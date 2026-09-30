# Gateway troubleshooting filters

All filters are exact matches and execute in SQL within the authenticated project.
Request and error log counts use the same predicates as the paginated data query.
Existing no-filter API calls and response shapes remain supported.

| API | Supported filters |
| --- | --- |
| `/admin/logs/requests` | `model`, `provider`, `apiKey`, `status`, `sessionId`, `minDurationMs`, UTC timestamp `startDate` / `endDate`, `limit` / `offset` |
| `/admin/logs/errors` | `statusCode`, `modelGroup`, `providerModel`, `modelId`, `apiBase`, `exceptionType`, UTC timestamp `startDate` / `endDate`, `limit` / `offset` |
| `/admin/usage/daily`, `/summary`, `/by-model`, `/by-provider`, `/by-key` | `model`, `provider`, `apiKey`, UTC calendar `startDate` / `endDate` |
| `/admin/models` | `modelName`, `providerModel`, `providerId`, `isEnabled` |
| `/admin/providers` | `name`, `type`, `status`, `isEnabled` |

Log date controls cover entire UTC days, including the end day. Usage retains its
previous seven-day default and writes the initial dates into the URL. Clearing
usage sets `usage.range=all`, so refresh does not reinstate the default range.
Filters are namespaced in the URL, preserve unrelated parameters, and reset
pagination atomically on Apply. Draft typing does not query the server. Invalid
request durations in URLs disable fetching until corrected or cleared.

## Schema and API gaps

- SpendLog has success/failure `status`, but no HTTP status column. HTTP status
  filtering therefore belongs to ErrorLog, whose `statusCode` is stored as text.
- ErrorLog has no provider or API key column. Use `providerModel`, `modelId`,
  `apiBase`, model group, and exception type instead of inventing unsupported fields.
- Log and usage `provider` values are stored identifiers/type strings, not joined
  provider display names. Deployments filter by provider ID, providers by name/type.
- API key inputs match the stored identifier, not the secret credential.
- Daily usage returns at most 200 rows (not 200 distinct days) and has no offset or
  total count. The UI explicitly labels this cap. Summaries and model/provider/key
  aggregates include all matching rows; the daily table is not a full export.
- Model/provider list endpoints return complete filtered lists without pagination.
- Name matching remains exact; no implicit substring or wildcard interpretation
  is introduced. The UI labels and titles state this behavior.
- Legacy no-HTTP-status errors remain visible without a status filter.
