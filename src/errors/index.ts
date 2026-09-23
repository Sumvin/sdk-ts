/**
 * `@sumvin/sdk` errors — one funnel for every error family this SDK throws
 * or returns.
 *
 * {@link installErrorInterceptor} registers a `client.interceptors.error`
 * handler that normalizes an RFC 7807 problem, a non-problem HTTP error, and
 * a transport failure (network or abort) into a single {@link ApiError}.
 * {@link isApiError} narrows that one; {@link isSumvinError} narrows to
 * {@link SumvinError}, the abstract base every error family this SDK
 * produces extends — `ApiError`, `ContractDriftError`, `HalError`,
 * `DeviceLoginError`, and `TypedDataPrecisionError` — so a single
 * `isSumvinError` branch catches all of them, regardless of which produced
 * it. {@link unwrap} throws for flow code that wants exceptions, and
 * {@link replayOutcome} names the 202-vs-208 idempotency replay for
 * operations like `createIpa` that declare both. {@link isRetryableError} is
 * the one retry policy over every failure kind, keyed on the API's own
 * per-code retryability for problems ({@link isRetryableErrorCode}).
 */
export { ApiError, type ApiErrorInit, type ApiErrorKind, isApiError } from './api-error.js';
export { installErrorInterceptor } from './interceptor.js';
export { replayOutcome } from './replay-outcome.js';
export { isRetryableError, isRetryableErrorCode } from './retryable.js';
export { isSumvinError, SumvinError } from './sumvin-error.js';
export { unwrap } from './unwrap.js';
