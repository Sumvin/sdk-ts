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
 * made with `redirect: 'error'` (`installAuthInterceptor` sets this on
 * every request) against a server that redirected — as opposed to a
 * genuine DNS/connection failure. This distinction is NOT free: on
 * Node/undici both cases throw the identical top-level `TypeError: fetch
 * failed`, with nothing in `.message` naming the cause — the only
 * difference is one property down, in `.cause`. Reproduced directly
 * against a real local HTTP server (not inferred from documentation)
 * before this was written:
 *
 * - **Bun**: `error.code === 'UnexpectedRedirect'` — a stable, documented
 *   error code, not a message string.
 * - **Node/undici**: `error.cause` is itself an `Error` whose `.message`
 *   is exactly `'unexpected redirect'` — undici's internal fetch
 *   algorithm, unversioned and not part of any public contract, so this
 *   is matched as a case-insensitive substring rather than pinned exactly.
 * - **Every other runtime** (chiefly browsers): neither signal exists —
 *   `fetch` rejects with the same opaque `TypeError` for a refused
 *   redirect as for a dropped connection. This function returns `false`
 *   there, and the failure falls through to the generic `'network'` kind
 *   below, unchanged from before this existed. That gap is exactly why
 *   `installAuthInterceptor` also carries an independent, fetch-
 *   implementation-agnostic response-side check — see its TSDoc.
 */
function isRedirectRefusedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === 'UnexpectedRedirect') return true; // Bun
  const cause = (error as { cause?: unknown }).cause;
  return (
    cause instanceof Error && cause.message.toLowerCase().includes('redirect') // Node/undici
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
      message:
        'Request refused: the API attempted to redirect this request to a different origin. ' +
        'The redirect was never followed, so no credential on this request reached that origin.',
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
