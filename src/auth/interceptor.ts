import type { Client } from '../generated/client/index.js';
import type { AuthProvider } from './provider.js';

/**
 * Registers a `client.interceptors.request` handler that sets every
 * configured provider's header, additively — never through `Config.auth` /
 * per-operation `security` metadata (D2).
 *
 * That is a deliberate rejection, not an oversight. `Config.auth` is driven
 * by the spec's per-operation `security` array and selects *one* scheme per
 * requirement — the shape the OpenAPI generator hands you for "this
 * operation accepts credential A **or** B". ENG-3386 makes that shape unsafe
 * to build on here: server-side, `deps/caller_context.py:811-836` resolves
 * the caller from a base credential (`x-juno-jwt` / `x-sumvin-pat`)
 * **unconditionally**, before it ever reads a PINT header — a PINT only
 * *upgrades* the resolved caller, it never substitutes for the base
 * credential — while `openapi_security.py:280-284` still emits the base and
 * PINT schemes as separate requirement objects (an OR) across 135
 * operations. An OR-shaped selector would eventually pick PINT alone on one
 * of those operations and silently drop the header the server actually
 * requires. Setting every configured provider's header additively sidesteps
 * that spec/server mismatch entirely, and costs nothing once the mismatch is
 * fixed upstream — an operation that only ever wants one header simply never
 * sees the other's provider configured.
 *
 * Each provider's `getToken()` is called fresh on every request (never
 * cached here); a provider that resolves `undefined` is skipped — its
 * header is left unset, not sent empty. Storage of whatever `getToken()`
 * returns is entirely the consumer's responsibility — this interceptor never
 * persists a token anywhere, and never logs one (see the header-set calls
 * below: only `provider.header`, the header *name*, is ever passed to
 * anything outside this function).
 *
 * @returns the interceptor's id, for `client.interceptors.request.eject(id)`.
 *
 * @example
 * const client = createClient(createConfig({ baseUrl }));
 * installAuthInterceptor(client, [sumvinPat(pat), pintToken(() => currentPint?.token)]);
 * // Every request now carries `x-sumvin-pat`, and `x-sumvin-pint-token` too
 * // whenever a PINT is active — both, not one instead of the other.
 */
export function installAuthInterceptor(client: Client, providers: readonly AuthProvider[]): number {
  return client.interceptors.request.use(async (request, _options) => {
    const tokens = await Promise.all(providers.map((provider) => provider.getToken()));

    for (const [index, provider] of providers.entries()) {
      const token = tokens[index];
      if (token !== undefined) {
        request.headers.set(provider.header, token);
      }
    }

    return request;
  });
}
