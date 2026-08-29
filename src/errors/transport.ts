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
 * Converts a raw thrown value — from `fetch` itself, before any `Response`
 * existed — into an {@link ApiError}, distinguishing an intentional abort
 * from a genuine network failure (DNS, connection refused, TLS, …).
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

  const reason = error instanceof Error ? error.message : String(error);
  return new ApiError({
    kind: 'network',
    message: `Network request failed: ${reason}`,
    request,
    cause: error,
  });
}
