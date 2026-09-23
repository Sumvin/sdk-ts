import { isApiError } from './api-error.js';

/**
 * Whether an API error code is retryable: an identical retry of the failed
 * request, after a short backoff, can succeed without the caller or an
 * operator changing anything.
 *
 * Every Sumvin error code is `DOMAIN-STATUS-SEQ` (terminal) or
 * `DOMAIN-STATUS-SEQ-R` (retryable), so the answer is read off the code
 * itself: `true` exactly when it ends in `-R`. That also holds for a code this
 * SDK version has not seen yet. `undefined` is `false`.
 *
 * @example
 * isRetryableErrorCode('PAR-503-002-R'); // true
 * isRetryableErrorCode('PAR-409-001');   // false
 */
export function isRetryableErrorCode(code: string | undefined): boolean {
  return code?.endsWith('-R') ?? false;
}

/**
 * Whether a failed request is worth retrying unchanged: one retry policy over
 * every {@link ApiErrorKind}, usable directly as a TanStack Query `retry`
 * predicate.
 *
 * - `'problem'`: the error code decides ({@link isRetryableErrorCode}), whatever
 *   the HTTP status. A terminal `503` stays terminal.
 * - `'http'`: no error code could be read (a gateway page, a malformed body).
 *   Retryable for `429` and any `5xx`, which is what an intermediary sends for
 *   a transient failure.
 * - `'network'`: the request or its reply was lost in transit, so it is
 *   retryable. Only resend a request that is safe to repeat.
 * - `'abort'`: the caller cancelled. Not retryable.
 * - `'redirect-refused'`: a refused redirect is not a transient failure. Not
 *   retryable.
 *
 * Anything that is not an `ApiError` (a `ContractDriftError`, a thrown bug) is
 * `false`.
 *
 * @example
 * useQuery({ ...options, retry: (count, error) => count < 3 && isRetryableError(error) });
 */
export function isRetryableError(error: unknown): boolean {
  if (!isApiError(error)) {
    return false;
  }
  switch (error.kind) {
    case 'problem':
      return isRetryableErrorCode(error.errorCode);
    case 'http':
      return error.status !== undefined && (error.status === 429 || error.status >= 500);
    case 'network':
      return true;
    case 'abort':
    case 'redirect-refused':
      return false;
  }
}
