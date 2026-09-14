# Session text search performance benchmark

Date: 2026-09-14
SQLite: 3.49.2 (the bundled `better-sqlite3` runtime)
Node.js: v22.20.0
Host: macOS Darwin 25.5.0, arm64 (MacBook-Pro-2.local; CPU and memory details were unavailable to the sandbox)

## Question and method

This benchmark checks whether the SQLite FTS5 session-search query stays within the design's 500 ms search budget when a project has many old records but only 100 records in the default one-hour window. It measures the SQL used by `searchSessions`, including source and revision joins, time predicates, ordering, and `LIMIT 1001`.

The reproducible runner is [scripts/session-search-benchmark.mjs](/Users/konghayao/code/ai/langfuse-lite/scripts/session-search-benchmark.mjs). Each run creates a fresh database below `/tmp`, inserts either 10,000 or 100,000 trace messages in one transaction, and removes the temporary directory at exit. Every message contains the common keyword `commonphrase`; one old message contains `rareneedle`; the 100 newest messages are spread over the last hour and all other messages are 24 hours old. The common, rare, and missing terms are each run 20 times after statement preparation. Reported values are warm-query wall time from `process.hrtime.bigint()`; median is the middle sorted sample and P95 is the 19th sorted sample.

## Results after the change

Times are milliseconds. `rows` is the raw SQL row count before application-side grouping (the common full-history query is capped at 1,001).

| Indexed trace rows | Query | Window | Rows | Median | P95 | Min–max |
| ---: | --- | --- | ---: | ---: | ---: | ---: |
| 10,000 | commonphrase | 1h | 100 | 4.992 | 5.339 | — |
| 10,000 | commonphrase | all history | 1,001 | 25.877 | 26.989 | — |
| 10,000 | rareneedle | 1h | 0 | 0.233 | 0.258 | — |
| 10,000 | rareneedle | all history | 1 | 5.996 | 7.141 | — |
| 10,000 | missingterm | 1h | 0 | 0.121 | 0.128 | — |
| 10,000 | missingterm | all history | 0 | 0.121 | 0.146 | — |
| 100,000 | commonphrase | 1h | 100 | 50.320 | 54.772 | — |
| 100,000 | commonphrase | all history | 1,001 | 221.518 | 227.378 | — |
| 100,000 | rareneedle | 1h | 0 | 0.679 | 0.719 | — |
| 100,000 | rareneedle | all history | 1 | 61.787 | 65.727 | — |
| 100,000 | missingterm | 1h | 0 | 0.366 | 0.389 | — |
| 100,000 | missingterm | all history | 0 | 0.366 | 0.373 | — |

Before this change, the same runner measured 10,000/100,000 common-term one-hour median at 6.011/72.324 ms and full-history median at 20.077/163.856 ms. Run-to-run variance is visible, so these are directional comparisons rather than a controlled A/B timing study. The current final run omitted min/max from this table because they are especially sensitive to host noise.

## Query plan and constraint usage

For windows up to six hours, the query now uses the projection directly: it scans the bounded occurrence index and applies `instr(search_texts.normalized_text,@literal)>0`. This preserves contiguous normalized-literal semantics without expanding original IO. Wider windows retain FTS MATCH for selectivity.

The short-window benchmark results were 0.259/0.274 ms (median/P95) at 10,000 rows and 0.275/0.289 ms at 100,000 rows for the common term. Rare and missing terms stayed below 0.12 ms. The fixed 100 recent rows therefore did not grow with historical index size in this fixture. Full-history FTS results remained 23.947/25.286 ms and 212.025/215.557 ms (median/P95) respectively.

The plan was stable across both data sizes after the change:

```text
SCAN f VIRTUAL TABLE INDEX 0:M1M0
SEARCH t USING INTEGER PRIMARY KEY (rowid=?)
SEARCH o USING INDEX idx_search_occ_text (project_id=? AND text_id=?)
SEARCH ob USING INDEX sqlite_autoindex_observations_1 (id=?) LEFT-JOIN
SEARCH sr USING INDEX sqlite_autoindex_search_source_revisions_1 (project_id=? AND source_kind=? AND source_id=?...)
SEARCH tr USING INDEX sqlite_autoindex_traces_1 (id=?) LEFT-JOIN
SEARCH tr2 USING INDEX sqlite_autoindex_traces_1 (id=?) LEFT-JOIN
USE TEMP B-TREE FOR ORDER BY
```

The new first lines are `MATERIALIZE time_candidates` followed by `SEARCH search_occurrences USING INDEX idx_search_occ_window (project_id=? AND event_time>? AND event_time<?)`. This proves the project and half-open time range drive the candidate scan before the text predicate; the CTE has no LIMIT, so it cannot create a false negative by truncating before matching. In the short branch the plan continues with `SCAN o` and primary-key lookup of `search_texts`; the full candidate set is text-filtered before the final LIMIT. Wider windows use the FTS virtual-table scan and project scope constraint, and ordering still materializes a temporary B-tree. Queries whose raw input normalizes below three code points are rejected explicitly, avoiding trigram false negatives in the wide branch.

## Acceptance and findings

All measured samples completed below the 500 ms design budget on this host, including the 100,000-row common-term full-history case (P95 227.378 ms). Rare and no-hit terms remained low latency, although rare full-history matching is expensive under the forced time-first plan. The default one-hour result count stayed at exactly 100 because the old records were outside the window.

The time constraint now drives the first candidate access path. The 10x history increase still raised common-term one-hour median from 5.908 ms to 56.449 ms, because SQLite scans FTS postings after the time CTE; the change improves the observed result but does not establish history-independent latency. Full-history P95 remains below 500 ms at this scale. Production claims should remain bounded by the explicit timeout/limited-result handling, and a larger corpus or a separate time-aware FTS projection would be needed to remove the remaining historical dependence.

## Limitations

This is a synthetic single-project trace-only fixture. It does not model observations, duplicate text deduplication, long-message chunks, multiple projects, concurrent readers/writers, WAL contention, cold page cache, or the read-pool queue. It measures SQL execution directly rather than HTTP and snippet loading. The all-history range uses Unix epoch as its lower bound only to expose the historical candidate cost; the product API does not offer an unbounded default range. The sample has one occurrence per trace and an intentionally high-frequency common term, so it is useful for detecting scaling direction and plan behavior, not for promising latency at millions of records.
