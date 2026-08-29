import type { ApiErrorCode, ProblemDetail } from '../generated/types.gen.js';

/**
 * What kind of failure produced this {@link ApiError}.
 *
 * - `'problem'` — the response body was a genuine RFC 7807 `ProblemDetail`
 *   (all six required fields present — see {@link ApiError.problem}).
 * - `'http'` — a non-2xx HTTP response whose body was not a full
 *   `ProblemDetail`: either a title-only fallback (spec drift) or a bare
 *   status with an unusable/absent body.
 * - `'network'` — `fetch` itself rejected (DNS failure, connection refused,
 *   TLS error, …) before any `Response` was produced.
 * - `'abort'` — the request was cancelled via `AbortSignal`, distinguished
 *   from `'network'` because it is an intentional cancellation, not a
 *   failure.
 */
export type ApiErrorKind = 'problem' | 'http' | 'network' | 'abort';

/** Constructor input for {@link ApiError}. Every field but `kind` and `message` is optional. */
export interface ApiErrorInit {
  /** See {@link ApiErrorKind}. */
  kind: ApiErrorKind;
  /** A genuinely useful message: title + detail + code, never a stringified blob. */
  message: string;
  /** The HTTP status, when one exists. `undefined` for `'network'`/`'abort'` failures. */
  status?: number;
  /** The parsed `ProblemDetail`, present only when `kind === 'problem'`. */
  problem?: ProblemDetail;
  /** The spec-generated error code, present only when `kind === 'problem'`. */
  errorCode?: ApiErrorCode;
  /** `ProblemDetail.trace_id`, present only when `kind === 'problem'` and the server sent one. */
  traceId?: string;
  /** The outgoing `Request`, when one was built before the failure occurred. */
  request?: Request;
  /** The raw `Response`, when one was received (absent for `'network'`/`'abort'`). */
  response?: Response;
  /** The original thrown value (a fetch rejection, a `DOMException`), threaded through as `Error.cause`. */
  cause?: unknown;
}

/**
 * The single error type for every request failure this SDK produces: an RFC
 * 7807 problem, a non-problem HTTP error, or a transport failure (network or
 * abort). Callers handling API errors only ever need to catch or check for
 * one type, regardless of which of those occurred — see {@link isApiError}.
 *
 * Constructed internally by the error interceptor installed via
 * {@link installErrorInterceptor}; consumers are not expected to construct
 * one themselves outside of tests.
 *
 * @example
 * const { data, error } = await getBudget({ client, path: { budget_id } });
 * if (isApiError(error)) {
 *   if (error.kind === 'abort') return; // user cancelled, not a failure
 *   console.error(`${error.errorCode ?? error.status}: ${error.message}`);
 * }
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  readonly problem: ProblemDetail | undefined;
  readonly errorCode: ApiErrorCode | undefined;
  readonly traceId: string | undefined;
  readonly request: Request | undefined;
  readonly response: Response | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.kind = init.kind;
    this.status = init.status;
    this.problem = init.problem;
    this.errorCode = init.errorCode;
    this.traceId = init.traceId;
    this.request = init.request;
    this.response = init.response;
  }
}

/**
 * Narrows `x` to {@link ApiError}. The normal way to check whether a
 * non-throwing result's `error` branch is safe to read `.kind` /
 * `.errorCode` off.
 *
 * @example
 * const { error } = await getBudget({ client, path: { budget_id } });
 * if (isApiError(error)) {
 *   console.error(error.kind, error.message);
 * }
 */
export function isApiError(x: unknown): x is ApiError {
  return x instanceof ApiError;
}
