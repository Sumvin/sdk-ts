import { apiErrorCodeRetryable } from '../generated/error-retryability.gen.js';
import { isApiError } from './api-error.js';

/**
 * Whether the API marks this error code as retryable: an identical retry of
 * the failed request, after a short backoff, can succeed without the caller
 * changing anything.
 *
 * The answer comes from the `x-retryable` map sumvin-api publishes on each
 * code, generated into this SDK — never a hand-kept list. A code this SDK
 * version does not know (a server newer than the SDK) is `false`: an
 * unclassified code is never assumed transient; upgrade the SDK to learn it.
 *
 * @example
 * if (isRetryableErrorCode(error.errorCode)) scheduleRetry();
 */
export function isRetryableErrorCode(code: string | undefined): boolean {
  if (code === undefined || !Object.hasOwn(apiErrorCodeRetryable, code)) {
    return false;
  }
  return apiErrorCodeRetryable[code as keyof typeof apiErrorCodeRetryable];
}

/**
 * Whether a failed request is worth retrying unchanged — one retry policy over
 * every {@link ApiErrorKind}, suitable as a TanStack Query `retry` predicate.
 *
 * - `'problem'` — the API's own per-code answer ({@link isRetryableErrorCode}).
 * - `'http'` — no error code was readable (a gateway page, a malformed body):
 *   retryable for `429` and any `5xx`, which is what an intermediary emits for
 *   a transient failure.
 * - `'network'` — the request or its reply was lost in transit: retryable.
 *   Resend only a request that is safe to repeat.
 * - `'abort'` — the caller cancelled: not retryable.
 * - `'redirect-refused'` — a refused redirect is not a transient failure:
 *   not retryable.
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
