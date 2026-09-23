---
'@sumvin/sdk': minor
---

Add `isRetryableError` and `isRetryableErrorCode`, generated from the per-code retryability sumvin-api now publishes, so clients no longer hand-keep a retry allowlist.

- `isRetryableErrorCode(code)` — the API's own answer for one error code: can an identical retry, after a short backoff, succeed? It comes from the `x-retryable` map on the `APIErrorCode` schema, generated into `@sumvin/sdk/generated/error-retryability.gen` (`apiErrorCodeRetryable`, one entry per `ApiErrorCode`). A code this SDK version does not know is `false`.
- `isRetryableError(error)` — one retry policy over every `ApiError` kind, usable as a TanStack Query `retry` predicate. A problem uses its code's answer. An HTTP failure with no readable code is retryable on `429`/`5xx`. A network failure is retryable. An abort or a refused redirect is not.

The vendored OpenAPI spec is re-pinned to sumvin-api `d455eb17`. `APIErrorCode` gains a description and the `x-retryable` extension, and `getNonce`'s description now explains that the nonce skips any held by a pending approval. No operations, schemas, error codes or security schemes are added or removed.
