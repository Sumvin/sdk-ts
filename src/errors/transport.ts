/**
 * Transport-failure normalization — the thing sumvin-cli conspicuously never
 * did (`cli/src/runtime/client.ts` only ever maps an HTTP response body; a
 * thrown `fetch` rejection propagated as-is). Here, a thrown network error
 * and a cancelled request both become an {@link ApiError}, so a caller has
 * exactly one type to check regardless of whether the API ever answered.
 */
import { ApiError } from './api-error.js';

/**
 * True for an aborted request: a `DOMException` named `AbortError` (what
 * `fetch` rejects with under an `AbortSignal` in every runtime this SDK
 * targets), or a plain `Error` carrying the same `.name` (some
 * runtimes/polyfills throw that shape instead).
 */
function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * True when `error` is what this runtime actually throws for a `fetch`
 * made with `redirect: 'error'` against a server that redirected ONCE and
 * the redirect was never followed — as opposed to a genuine
 * DNS/connection failure, OR a redirect **loop**.
 *
 * **This SDK's own requests never trigger this function.**
 * `installAuthInterceptor` builds every request with `redirect: 'manual'`
 * (Cloudflare Workers' workerd rejects `'error'` at `Request`
 * construction, so `'manual'` is what keeps this SDK working there at
 * all), and `'manual'` never throws — it always resolves to a `Response`,
 * classified by the auth response interceptor's own response-side check
 * (see that file's TSDoc). What CAN still reach this function is a
 * **consumer-supplied `fetch`** (`CreateSumvinClientOptions.fetch`) that
 * sets `redirect: 'error'` on its OWN inner call — this SDK neither sets
 * nor requires that value from a consumer's `fetch`, but nothing stops one
 * from choosing it, and this is the signal `toTransportError` reads to
 * still classify that throw as `kind: 'redirect-refused'` (with
 * `redirectOutcome: 'refused'` — see `ApiError.redirectOutcome`) instead
 * of a generic `'network'` failure.
 *
 * The loop case matters here regardless of which layer set `'error'`: a
 * consumer `fetch` that rebuilds the outgoing `Request` and drops
 * whichever redirect setting it was handed (`'manual'` from this SDK, or
 * its own `'error'`) has the real `fetch` underneath follow every hop with
 * `redirect: 'follow'` semantics — sending the credential again on each
 * one — until the runtime's own hop-count ceiling throws. That is a
 * genuine transport failure (`'network'`), the opposite of "never
 * followed, no credential reached that origin"; this function must return
 * `false` for it, or `toTransportError` would tell the caller their
 * credential is safe when it was sent up to ~20 times.
 *
 * This distinction is NOT free: on Node/undici both the single-refusal and
 * the loop case throw the identical top-level `TypeError: fetch failed`,
 * with nothing in `.message` naming the cause — the only difference is one
 * property down, in `.cause`. Reproduced directly against a real local
 * HTTP server (not inferred from documentation) before this was written:
 *
 * - **Bun**, single refusal: `error.code === 'UnexpectedRedirect'` — a
 *   stable, documented error code, not a message string.
 * - **Bun**, redirect loop: `error.code === 'TooManyRedirects'` — a
 *   DIFFERENT code, so it never matches the check below and correctly
 *   falls through to `'network'`.
 * - **Node/undici**, single refusal: `error.cause` is itself an `Error`
 *   whose `.message` is exactly `'unexpected redirect'`.
 * - **Node/undici**, redirect loop: `error.cause.message` is exactly
 *   `'redirect count exceeded'` — it contains the substring `'redirect'`
 *   but NOT `'unexpected redirect'`, which is why the match below is
 *   anchored on the longer, more specific phrase rather than the bare
 *   word. undici's internal fetch algorithm is unversioned and not part
 *   of any public contract, so this is still a substring match rather
 *   than an exact one — narrowed just enough to stop colliding with the
 *   loop message observed today, not pinned to the whole string.
 * - **Every other runtime** (chiefly browsers): neither signal exists —
 *   `fetch` rejects with the same opaque `TypeError` for a refused
 *   redirect, a redirect loop, and a dropped connection alike. This
 *   function returns `false` there for all three, and every one of them
 *   falls through to the generic `'network'` kind below, unchanged from
 *   before this existed. That gap is exactly why `installAuthInterceptor`
 *   also carries an independent, fetch-implementation-agnostic
 *   response-side check for the single-hop case — see its TSDoc. There is
 *   no equivalent response-side check for a loop: a loop that exhausts the
 *   runtime's redirect ceiling never produces a `Response` at all, so
 *   nothing reaches that check either way.
 */
function isRedirectRefusedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === 'UnexpectedRedirect') return true; // Bun: single refusal
  // Bun's redirect-loop code ('TooManyRedirects') is deliberately NOT
  // matched — see this function's TSDoc.
  const cause = (error as { cause?: unknown }).cause;
  return (
    cause instanceof Error && cause.message.toLowerCase().includes('unexpected redirect') // Node/undici
  );
}

/**
 * Converts a raw thrown value — from `fetch` itself, before any `Response`
 * existed — into an {@link ApiError}, distinguishing an intentional abort,
 * a positively-identified refused redirect (see
 * {@link isRedirectRefusedError} — best-effort, not every runtime exposes
 * the signal), and a genuine network failure (DNS, connection refused, TLS,
 * …).
 */
export function toTransportError(error: unknown, request: Request | undefined): ApiError {
  if (isAbortError(error)) {
    return new ApiError({
      kind: 'abort',
      message: 'The request was aborted.',
      request,
      cause: error,
    });
  }

  if (isRedirectRefusedError(error)) {
    return new ApiError({
      kind: 'redirect-refused',
      redirectOutcome: 'refused',
      message:
        'Request refused: the API attempted to redirect this request (same-origin or ' +
        'cross-origin — this SDK refuses either, since no operation legitimately redirects). ' +
        'The redirect was never followed, so no credential on this request reached the ' +
        'redirect target.',
      request,
      cause: error,
    });
  }

  const reason = error instanceof Error ? error.message : String(error);
  return new ApiError({
    kind: 'network',
    message: `Network request failed: ${reason}`,
    request,
    cause: error,
  });
}
