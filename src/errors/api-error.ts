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
 * - `'redirect-refused'` — the API attempted to redirect this request
 *   (same-origin or cross-origin — this SDK refuses either, since no
 *   operation in the spec legitimately redirects) and this SDK refused to
 *   complete it, or caught after the fact that something downstream
 *   already had (see `installAuthInterceptor`'s TSDoc for the full
 *   mechanism). Two different moments produce this kind, and
 *   `error.message` says which: the ambient `fetch` honoured
 *   `redirect: 'error'` and rejected before ever contacting the redirect
 *   target (no credential exposure — detected positively only on runtimes
 *   that expose a distinguishing signal for this specific failure,
 *   currently Node/undici and Bun; elsewhere this falls back to
 *   `'network'`, unchanged); or a consumer-supplied `fetch`
 *   (`CreateSumvinClientOptions.fetch`) rebuilt the outgoing `Request` and
 *   silently dropped that setting, actually followed the redirect, and
 *   this was only caught afterwards by inspecting the `Response` that came
 *   back (`response.redirected` / `response.url`) — in which case any
 *   credential header this SDK set may already have reached the redirect
 *   target. The second case is a **detection, not a prevention**, and it
 *   has its own gap: a consumer `fetch` that ALSO reconstructs the
 *   `Response` object before returning it (e.g. a logging wrapper that
 *   reads the body and returns `new Response(...)`) defeats this
 *   detection too — that call completes as an ordinary success with no
 *   `ApiError` of any kind. See `installAuthInterceptor`'s TSDoc for that
 *   limitation in full.
 *
 *   **Not this kind**: a redirect *loop* (a rebuilding `fetch` following
 *   redirect after redirect, sending the credential on every hop, until
 *   the runtime's own redirect-count ceiling throws) is a genuine
 *   transport failure — it surfaces as `'network'`, deliberately, because
 *   "refused" would be false; see `toTransportError`'s TSDoc.
 */
export type ApiErrorKind = 'problem' | 'http' | 'network' | 'abort' | 'redirect-refused';

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
  /** The outgoing `Request`, when one was built before the failure occurred. Carries a live credential in its headers — see {@link ApiError.request}'s own TSDoc before logging or reporting it. */
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
  /**
   * The outgoing `Request` that failed, when one was built before the
   * failure occurred — populated on every failure this SDK's error
   * interceptor produces, not only on `'network'`/`'abort'`.
   *
   * **Handle with care in logging/error-reporting code.** This is a live
   * `Request` object, and `request.headers` still carries whatever
   * credential this SDK's auth providers set (`x-sumvin-pat`, `x-juno-jwt`,
   * a PINT bearer token) — `error.request.headers.get('x-sumvin-pat')`
   * reads it back in plaintext from any `catch` block or crash reporter
   * that receives this `ApiError`, and always will: that read is
   * indistinguishable from the legitimate reason this field exists (a
   * pipeline logging the method/URL of a failed call). Redact or omit
   * `request.headers` before sending this error anywhere it will be
   * persisted or transmitted.
   *
   * **`console.error(error)` / `console.log(error)` on Node.js and Bun are
   * safe** — this class implements the `util.inspect.custom` hook (looked
   * up via `Symbol.for('nodejs.util.inspect.custom')`, so this file never
   * imports `node:util` and behaves identically on every runtime) and its
   * implementation below renders `request` as only its method and URL,
   * never its headers. `console.error`/`console.log` on a non-string
   * argument call `util.inspect` internally to render it — one hook, one
   * rendering path either way — confirmed against real `util.inspect`
   * output on Node.js and Bun both, see this file's own test, not assumed.
   *
   * **`console.dir(error)` is ALSO safe, but not for the same reason on
   * every runtime** — and that divergence was found by running this, not
   * inferred: Node.js's own `console.dir` explicitly bypasses a target's
   * custom inspect function by default (`customInspect: false`), so the
   * hook above never fires there at all; Bun's `console.dir` DOES invoke
   * it, same as `console.log`. Node stays safe anyway, for the SAME reason
   * the next paragraph covers — see this file's own test for both.
   *
   * A naive `JSON.stringify` or an own-enumerable-properties walk was
   * already safe before the inspect hook existed, and stays safe
   * independent of it — `Request`/`Response` expose their fields through
   * prototype getters, which neither serializes — confirmed by this
   * file's own test, not assumed. **What none of the above covers**: a
   * runtime with no concept of `util.inspect` (every browser; most
   * edge/worker runtimes) falls back to that runtime's own default object
   * formatting, which this class has no hook into and which may render
   * the headers — browser DevTools in particular will show them if the
   * `Request` is expanded. On those runtimes, only an explicit read of
   * `request.headers` was ever the risk, and still is.
   */
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

  /**
   * Renders this error for Node.js/Bun's `console.log`/`console.error` and
   * for a direct `util.inspect(error)` call, omitting `request`/`response`
   * headers — see {@link ApiError.request}'s TSDoc for what this does and
   * does not protect against. Looked up by the runtime via
   * `Symbol.for('nodejs.util.inspect.custom')`, a globally-registered
   * symbol key rather than the `util.inspect.custom` export itself
   * (`node:util`'s own docs name this as the supported alternative) —
   * that keeps this file import-free of `node:util`, so defining this
   * method is inert, not a build or runtime error, on a browser or an
   * edge runtime that has never heard of Node's inspection protocol.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    const fields: string[] = [`kind: ${this.kind}`];
    if (this.status !== undefined) fields.push(`status: ${this.status}`);
    if (this.errorCode !== undefined) fields.push(`errorCode: ${this.errorCode}`);
    if (this.traceId !== undefined) fields.push(`traceId: ${this.traceId}`);
    if (this.request !== undefined) {
      fields.push(`request: ${this.request.method} ${this.request.url} (headers redacted)`);
    }
    if (this.response !== undefined) {
      fields.push(`response: ${this.response.status} ${this.response.statusText}`.trimEnd());
    }
    return `ApiError: ${this.message} { ${fields.join(', ')} }`;
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
