/**
 * `@sumvin/sdk` errors — one error type for every request failure mode.
 *
 * {@link installErrorInterceptor} registers a `client.interceptors.error`
 * handler that normalizes an RFC 7807 problem, a non-problem HTTP error, and
 * a transport failure (network or abort) into a single {@link ApiError}.
 * {@link isApiError} narrows, {@link unwrap} throws for flow code that wants
 * exceptions, and {@link replayOutcome} names the 202-vs-208 idempotency
 * replay for operations like `createIpa` that declare both.
 */
export { ApiError, type ApiErrorInit, type ApiErrorKind, isApiError } from './api-error.js';
export { installErrorInterceptor } from './interceptor.js';
export { replayOutcome } from './replay-outcome.js';
export { unwrap } from './unwrap.js';
