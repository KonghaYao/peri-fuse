/**
 * SQL fragments (json_extract over `o.usage_details`) computing the cache token
 * columns of the materialized `trace_metrics` table. Shared by the ingestion-
 * time maintenance (processEventBatchLite) and the one-time backfill migration
 * below. Both queries alias `observations` as `o`.
 *
 * Cache key naming varies by ingestion path: the OTLP processor normalizes to
 * `input_cached_tokens` / `input_cache_creation*`, while the plain SDK path
 * stores the provider's raw keys — Anthropic's `cache_read_input_tokens` /
 * `cache_creation_input_tokens` and OpenAI's `cached_tokens`. A single
 * usage_details object only ever carries ONE naming scheme, so summing across
 * all known keys never double-counts.
 *
 * Each metric has a per-row expression (`*_ROW_SQL`, no aggregate) and an
 * aggregated expression (`SUM(...)`). The per-row forms are needed to build the
 * gross-input CASE below without nesting aggregates.
 */
const CACHED_TOKENS_ROW_SQL = `(
             COALESCE(json_extract(o.usage_details, '$.input_cached_tokens'), 0) +
             COALESCE(json_extract(o.usage_details, '$.input_cache_read'), 0) +
             COALESCE(json_extract(o.usage_details, '$.cache_read_input_tokens'), 0) +
             COALESCE(json_extract(o.usage_details, '$.cached_tokens'), 0))`;

const CACHE_CREATION_TOKENS_ROW_SQL = `(
             COALESCE(json_extract(o.usage_details, '$.input_cache_creation'), 0) +
             COALESCE(json_extract(o.usage_details, '$.input_cache_write'), 0) +
             COALESCE(json_extract(o.usage_details, '$.input_cache_creation_5m'), 0) +
             COALESCE(json_extract(o.usage_details, '$.input_cache_creation_1h'), 0) +
             COALESCE(json_extract(o.usage_details, '$.cache_creation_input_tokens'), 0))`;

export const TRACE_METRICS_CACHED_TOKENS_SQL = `COALESCE(SUM(${CACHED_TOKENS_ROW_SQL}), 0)`;

export const TRACE_METRICS_CACHE_CREATION_TOKENS_SQL = `COALESCE(SUM(${CACHE_CREATION_TOKENS_ROW_SQL}), 0)`;

/**
 * Per-observation GROSS input tokens (the full prompt/context size, cache
 * included) — the correct denominator for cache-hit-rate.
 *
 * Providers disagree on what `usage_details.input` means:
 *  - Anthropic (and gateways forwarding it verbatim) report `input` as GROSS,
 *    already including cache reads (`input` = net + cache_read + creation);
 *  - OpenAI / the OTLP-normalized path report `input` as NET (cache excluded).
 * Heuristic: if `input` already covers the cache tokens (input >= cache read +
 * creation) it is gross, use it as-is; otherwise it is net, so add the cache
 * tokens back. When there is no cache the two agree, so this is always safe.
 */
export const TRACE_METRICS_GROSS_INPUT_TOKENS_SQL = `COALESCE(SUM(
             CASE WHEN COALESCE(json_extract(o.usage_details, '$.input'), 0) >=
                       (${CACHED_TOKENS_ROW_SQL} + ${CACHE_CREATION_TOKENS_ROW_SQL})
                  THEN COALESCE(json_extract(o.usage_details, '$.input'), 0)
                  ELSE COALESCE(json_extract(o.usage_details, '$.input'), 0) +
                       ${CACHED_TOKENS_ROW_SQL} + ${CACHE_CREATION_TOKENS_ROW_SQL}
             END), 0)`;
