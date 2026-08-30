/**
 * `createSumvinClient` — the single entry point that composes every curated
 * behaviour onto the generated {@link Client} (D1).
 *
 * This is deliberately **not** a wrapper class. It returns the generated
 * `Client` itself, with request/response/error interceptors installed on
 * it — consumers keep calling generated operations with `{ client }`
 * exactly as they would against an uncurated client. Nothing here
 * re-implements request building, serialization, or parsing; those all stay
 * hey-api's job.
 */
import { installAuthInterceptor } from './auth/interceptor.js';
import type { AuthProvider } from './auth/provider.js';
import { installErrorInterceptor } from './errors/interceptor.js';
import type { Client } from './generated/client/index.js';
import { createClient, createConfig } from './generated/client/index.js';
import { installResponseValidation } from './validation/install.js';
import type { ValidationOptions } from './validation/types.js';

/** Options for {@link createSumvinClient}. */
export interface CreateSumvinClientOptions {
  /** The API's base URL, e.g. `https://api.sumvin.com`. */
  baseUrl: string;
  /**
   * The `fetch` implementation to use. Omit to use the ambient global.
   * ENG-3425: the CLI injects its own (a `fetch` wrapping Node's, or a
   * proxy-aware one) rather than relying on whichever global happens to be
   * present in the runtime it's built for.
   */
  fetch?: typeof fetch;
  /**
   * Extra headers sent on every request, merged with (never replacing) the
   * generated client's own default `Content-Type: application/json` — see
   * the "why merge, not replace" note in this function's body. ENG-3425:
   * the CLI **must** set `user-agent: sumvin-cli/<version>` here — the API
   * pins PAT auth (`x-sumvin-pat`) to `CLI_ALLOWED_USER_AGENT_PREFIXES`, so
   * a client built without it can create a device-authorization sign-in and
   * then have every subsequent PAT-authenticated call refused.
   */
  headers?: Record<string, string>;
  /**
   * Credential providers, applied additively — see {@link installAuthInterceptor}
   * (D2) for why this is a list of providers and not `Config.auth`.
   * Defaults to none: an unauthenticated client (what {@link deviceLogin}
   * itself needs to run before any credential exists).
   */
  auth?: AuthProvider[];
  /**
   * Response-body contract validation (D4). Defaults to **on**, at the
   * module's shipped `VALIDATED_OPERATIONS` / `STRICT_OPERATIONS` maps —
   * this is an explicit ENG-3424 acceptance criterion, not an opt-in.
   * Fully overridable (see {@link ValidationOptions}); pass `{}` to keep
   * the defaults while only adding an `onContractDrift` hook, or
   * `{ operations: {}, strictOperations: {} }` to disable validation
   * entirely without removing the ability to still pass `onContractDrift`
   * for some other purpose.
   */
  validation?: ValidationOptions;
  /**
   * Request timeout in milliseconds. **Defaults to off** (D11) — `fetch`
   * itself has no default timeout, and a consumer migrating from a client
   * that never timed out should see identical behaviour until they opt in.
   * Combined with any per-call `signal` the caller already passed (via
   * `AbortSignal.any`), so setting this never *removes* a caller's own
   * cancellation — it only adds a ceiling.
   */
  timeoutMs?: number;
}

/**
 * Registers a request interceptor that bounds every request to `timeoutMs`,
 * combined with whatever `AbortSignal` the request already carries (a
 * per-call `signal`, or the browser/Node default of "never aborts").
 *
 * A `Request`'s `signal` is fixed at construction and cannot be reassigned
 * in place, so this constructs a new `Request` from the one it receives —
 * `new Request(request, { signal })` clones every other property (method,
 * headers, body, …) unchanged, which is what makes registering this AFTER
 * {@link installAuthInterceptor} safe: the clone carries whatever headers
 * auth already set.
 *
 * `AbortSignal.timeout(ms)` rejects `fetch` with a `TimeoutError`
 * `DOMException` — distinct from the `AbortError` a caller's own
 * cancellation produces — so {@link installErrorInterceptor}'s transport
 * normalization reports a timeout as `kind: 'network'`
 * (`isAbortError` in `src/errors/transport.ts` only matches `AbortError`),
 * never misrepresented as an intentional `kind: 'abort'`.
 */
function installTimeoutInterceptor(client: Client, timeoutMs: number): number {
  return client.interceptors.request.use((request) => {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    return new Request(request, { signal });
  });
}

/**
 * Builds a generated {@link Client}, curated with every Wave A/B behaviour
 * (D1): credential providers (D2), single-type error normalization (D3),
 * on-by-default contract validation (D4), and an optional request timeout
 * (D11). `hal.follow()` / `paginate()` (D5) and the signing ceremonies
 * (D6) need no installation step of their own — they read `client` at call
 * time, so any client built here (or any bare generated `Client`) already
 * works with them.
 *
 * **Install order, and why it's this order:**
 *
 * 1. **Auth** ({@link installAuthInterceptor}) — a request interceptor,
 *    registered first so it is the first thing to touch the outgoing
 *    request's headers. Nothing downstream needs to run before it.
 * 2. **Timeout** ({@link installTimeoutInterceptor}, only if `timeoutMs` is
 *    set) — also a request interceptor, registered *after* auth so the
 *    `Request` it reconstructs (to attach a combined `AbortSignal`, see its
 *    own TSDoc) clones a request that already carries auth's headers,
 *    rather than racing auth to decide which one's mutation survives.
 * 3. **Errors** ({@link installErrorInterceptor}) — normalizes every
 *    request failure (transport, HTTP, RFC 7807) into a single `ApiError`.
 *    Order relative to validation (below) is not load-bearing on its own —
 *    `interceptors.error` and `interceptors.response` are independent
 *    queues the generated client invokes at different points in its own
 *    request lifecycle — but it matters for a related reason: this
 *    function's own bypass for `ContractDriftError` (see its TSDoc) is what
 *    keeps step 4's fail-closed errors from being silently rewritten into a
 *    generic `ApiError` here, regardless of which of steps 3/4 is called
 *    first in source.
 * 4. **Validation** ({@link installResponseValidation}) — a response
 *    interceptor; assigns `options.responseValidator` for the client's own
 *    parse step to invoke. On by default (D4 — an explicit acceptance
 *    criterion), fully overridable via `options.validation`.
 *
 * @example
 * const client = createSumvinClient({
 *   baseUrl: 'https://api.sumvin.com',
 *   auth: [sumvinPat(process.env.SUMVIN_PAT)],
 * });
 * const { data, error } = await getBudget({ client, path: { budget_id } });
 */
export function createSumvinClient(options: CreateSumvinClientOptions): Client {
  const { baseUrl, fetch: fetchImpl, headers, auth = [], validation, timeoutMs } = options;

  // `createConfig()` with no override is the generated client's own way of
  // asking "what are the defaults?" — read here once so `headers` MERGES
  // with them (`Content-Type: application/json` in particular) instead of
  // replacing them outright. `createConfig({..., headers})`'s own internal
  // spread order (`{ headers: defaultHeaders, ...override }`) means an
  // `override.headers` REPLACES the whole object, not just the keys it
  // names — passing `options.headers` straight through would silently drop
  // the default `Content-Type` for every request with a body the moment a
  // consumer supplied so much as one header of their own (exactly what
  // ENG-3425's CLI `user-agent` requirement does).
  const defaultHeaders = createConfig().headers;

  const client = createClient(
    createConfig({
      baseUrl,
      fetch: fetchImpl,
      headers: { ...defaultHeaders, ...headers },
      // Explicit, not just relying on the generated default: `unwrap()` /
      // `isApiError()` (D3) and the fail-closed `ContractDriftError` result
      // (D4) both depend on a failed call resolving to `{ data: undefined,
      // error }` rather than throwing out of the call itself.
      throwOnError: false,
    }),
  );

  installAuthInterceptor(client, auth);
  if (timeoutMs !== undefined) {
    installTimeoutInterceptor(client, timeoutMs);
  }
  installErrorInterceptor(client);
  installResponseValidation(client, validation);

  return client;
}
