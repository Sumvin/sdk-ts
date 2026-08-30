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
 * A provider's `appliesTo` (FIX 5, see `./provider.js` for the quantified
 * reason it exists) is checked per request, keyed the same way
 * `src/validation` keys operations: `` `${options.method} ${options.url}` ``
 * — `options.url` is the un-substituted path template, same proof as
 * `src/validation/seam.test.ts`. `getToken()` is still called for every
 * provider regardless of `appliesTo` (only whether the RESULT is applied is
 * gated); a provider with no `appliesTo` applies to every request, exactly
 * today's behaviour.
 *
 * **Also refuses to follow a redirect on every request, always — not only
 * when a provider is configured.** Found by reproduction (an adversarial
 * verification pass and a posture check, independently): the generated
 * client hardcodes `redirect: 'follow'`
 * (`generated/client/client.gen.ts:86`), and the fetch spec strips only
 * `Authorization`, `Cookie`, and `Proxy-Authorization` across a cross-origin
 * redirect — never a custom header, which is exactly the scheme every
 * provider here uses (`x-juno-jwt`, `x-sumvin-pat`, `x-sumvin-pint-token`).
 * A malicious or compromised API origin that 302s a credentialed call
 * forwards every header this interceptor just set, verbatim, to whatever
 * origin the `Location` names — proven against a real cross-origin redirect
 * in `../client.test.ts`. The HAL origin guard (`../hal/origin-guard.ts`)
 * does not help here: no href, no `hal.follow()` call is involved.
 *
 * `redirect: 'error'`, not `'manual'`: this API has no legitimate reason to
 * redirect a credentialed call — every named operation returns its result
 * directly — so a redirect here is already an anomaly. `'manual'` would hand
 * back an opaque, `status: 0` `Response` that `response.ok` reads as an
 * unhelpfully generic HTTP failure; `'error'` makes `fetch` itself reject,
 * which lands with no `response` at all in `installErrorInterceptor`'s
 * catch (`src/errors/interceptor.ts`) and normalizes through
 * `toTransportError` (`src/errors/transport.ts`) to a legible
 * `kind: 'network'` `ApiError` — the same shape a DNS failure or a dropped
 * connection produces, which is the right category for "this call could not
 * complete safely," not a value to unwrap and act on.
 *
 * This reconstructs the `Request` (`redirect` cannot be reassigned on an
 * existing one, unlike `headers`) — `new Request(request, { redirect:
 * 'error' })` clones every other property, including whatever headers the
 * loop above just set, unchanged. Applying this unconditionally (not only
 * when `providers.length > 0`) is deliberate: an unauthenticated client
 * still sends a `user-agent` / other configured header worth protecting
 * (ENG-3425's CLI requirement, `src/client.ts`), and a consumer should never
 * have to add a provider just to get redirect safety.
 *
 * @returns the interceptor's id, for `client.interceptors.request.eject(id)`.
 *
 * @example
 * const client = createClient(createConfig({ baseUrl }));
 * installAuthInterceptor(client, [sumvinPat(pat), pintToken(() => currentPint?.token)]);
 * // Every request now carries `x-sumvin-pat`, and `x-sumvin-pint-token` too
 * // whenever a PINT is active — both, not one instead of the other — and
 * // neither ever survives a redirect to a different origin.
 */
export function installAuthInterceptor(client: Client, providers: readonly AuthProvider[]): number {
  return client.interceptors.request.use(async (request, options) => {
    const operationKey = `${options.method} ${options.url}`;
    const tokens = await Promise.all(providers.map((provider) => provider.getToken()));

    for (const [index, provider] of providers.entries()) {
      const token = tokens[index];
      const applies = provider.appliesTo?.(operationKey) ?? true;
      if (token !== undefined && applies) {
        request.headers.set(provider.header, token);
      }
    }

    return new Request(request, { redirect: 'error' });
  });
}
