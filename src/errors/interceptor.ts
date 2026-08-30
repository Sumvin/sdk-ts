import type { Client } from '../generated/client/index.js';
import { ContractDriftError } from '../validation/contract-drift-error.js';
import { ApiError } from './api-error.js';
import { parseProblemBody } from './problem.js';
import { toTransportError } from './transport.js';

/**
 * Registers a `client.interceptors.error` handler that rewrites every
 * request failure into a single {@link ApiError}: an RFC 7807 problem (by
 * shape, per P3), a non-problem HTTP error, or a transport failure — network
 * or abort. After this is installed, `result.error` from any generated
 * operation call is always an `ApiError` (never a raw parsed body, a string,
 * or an uncaught rejection), regardless of which failure mode occurred — with
 * one deliberate exception, immediately below.
 *
 * **Bypasses {@link ContractDriftError} unchanged.** Found composing this
 * with `installResponseValidation` in `createSumvinClient` (Phase C): a
 * `strict`-tier drift throws a `ContractDriftError` from inside the
 * generated client's own JSON-parse branch, which the client's `try/catch`
 * routes through this SAME `interceptors.error` chain — there is no way for
 * `installResponseValidation` to keep it out of this function's hands. Left
 * unguarded, `response` is defined (the drift only fires on `response.ok`)
 * and the body is a `ContractDriftError` instance with no `title`/`detail`
 * fields, so it would fall through `parseProblemBody`'s tiers 1 and 2 into
 * the generic tier-3 status message — silently replacing a typed
 * `ContractDriftError` with a generic `ApiError` and losing `operationKey`,
 * `tier`, `reason`, and `issues` in the process. `src/validation/seam.test.ts`
 * proves the bare (uncomposed) contract this bypass exists to preserve:
 * a throwing validator surfaces as `{ data: undefined, error }` with the
 * *original* error object, untouched.
 *
 * Caution, proven at runtime: the error interceptor receives the RAW options
 * passed to the client call, not the resolved ones a response interceptor
 * sees — `options.baseUrl` is absent and `options.headers` is not guaranteed
 * to be a `Headers` instance, despite the `ResolvedRequestOptions` cast the
 * generated client applies at the call site. This function does not read
 * `options` at all for exactly that reason; if a base URL is ever needed
 * here in the future, read it from `client.getConfig()` instead.
 *
 * `throwOnError` is untouched by this installer — it stays `false` by
 * default, so a normalized `ApiError` surfaces as `result.error`. Use
 * {@link unwrap} at call sites that want an exception instead.
 *
 * @returns the interceptor's id, for `client.interceptors.error.eject(id)`.
 *
 * @example
 * const client = createClient(createConfig({ baseUrl }));
 * installErrorInterceptor(client);
 * const { data, error } = await getBudget({ client, path: { budget_id } });
 * if (isApiError(error)) {
 *   console.error(error.kind, error.message);
 * }
 */
export function installErrorInterceptor(client: Client): number {
  return client.interceptors.error.use((error, response, request) => {
    if (error instanceof ApiError || error instanceof ContractDriftError) {
      // Already normalized — defensive (ApiError, in case this ever runs
      // twice) and deliberate (ContractDriftError, see above).
      return error;
    }

    if (response === undefined) {
      // `fetch` itself threw: a network failure or an abort, before any
      // Response existed to parse a body from.
      return toTransportError(error, request);
    }

    return parseProblemBody({ body: error, status: response.status, request, response });
  });
}
