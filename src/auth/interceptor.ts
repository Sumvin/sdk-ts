import { ApiError } from '../errors/api-error.js';
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
 * complete safely," not a value to unwrap and act on. (`toTransportError`
 * additionally recognizes the refused redirect specifically, on the
 * runtimes that expose a signal for it, and reports it as
 * `kind: 'redirect-refused'` instead — see its own TSDoc.)
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
 * **This request-side setting is NOT enforceable against every `fetch` this
 * SDK can be handed.** `CreateSumvinClientOptions.fetch` is a documented,
 * first-class override (`src/client.ts` — ENG-3425's CLI supplies its own).
 * A consumer `fetch` that *rebuilds* the `Request` it receives — reading
 * only `url`/`method`/`headers`/`body` and constructing a fresh one, a
 * common shape for a logging or proxy-aware wrapper — drops any property it
 * doesn't know to forward, `redirect` included, and this interceptor has no
 * way to observe or prevent that: it runs before the configured `fetch` is
 * ever called. Reproduced directly (`../client.test.ts`, "rebuilding custom
 * fetch"): with such a `fetch`, a cross-origin 302 IS followed, the
 * attacker origin IS contacted, and it DOES receive every credential header
 * this loop just set — silently, with the call otherwise looking like a
 * normal success.
 *
 * The second `client.interceptors.response.use(...)` registered below is
 * the backstop for exactly that gap: a check on the `Response` that
 * actually came back, which works regardless of which `fetch`
 * implementation produced it, because `Response.redirected` and
 * `Response.url` are part of the Fetch API itself, not something a
 * `fetch` wrapper can silently drop the way it can a request option. Be
 * clear about what this backstop is: **a detection, not a prevention**. By
 * the time a response reaches it, a rebuilding `fetch` has already
 * contacted the redirect target — any credential header was already on the
 * wire. This check cannot un-send it; it converts what would otherwise be a
 * silent, indistinguishable-from-success leak into a loud
 * `kind: 'redirect-refused'` `ApiError`, so at minimum the caller knows to
 * stop trusting the response and to treat the credential as compromised.
 *
 * @returns the id of the request-side interceptor (auth headers +
 * `redirect: 'error'`), for `client.interceptors.request.eject(id)`. The
 * response-side backstop registered alongside it has no separate id
 * exposed — this function has no partial-uninstall story today; ejecting
 * the returned id removes only the request-side half.
 *
 * @example
 * const client = createClient(createConfig({ baseUrl }));
 * installAuthInterceptor(client, [sumvinPat(pat), pintToken(() => currentPint?.token)]);
 * // Every request now carries `x-sumvin-pat`, and `x-sumvin-pint-token` too
 * // whenever a PINT is active — both, not one instead of the other — and
 * // neither ever survives a redirect to a different origin (or, if the
 * // configured `fetch` itself ignored that, the response is refused too).
 */
export function installAuthInterceptor(client: Client, providers: readonly AuthProvider[]): number {
  const requestInterceptorId = client.interceptors.request.use(async (request, options) => {
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

  client.interceptors.response.use((response, request) => {
    if (isCrossOriginResponse(response, client.getConfig().baseUrl)) {
      throw new ApiError({
        kind: 'redirect-refused',
        message:
          'Refusing a response served by a different origin than requested — the configured ' +
          "fetch implementation followed a cross-origin redirect despite this SDK's own " +
          "redirect: 'error' request setting. Any credential header on this request may " +
          'already have reached that origin; this check detects the leak, it cannot undo it.',
        request,
        response,
      });
    }
    return response;
  });

  return requestInterceptorId;
}

/**
 * True when `response` looks like it was ultimately served by a different
 * origin than `baseUrl` — the fetch-implementation-independent half of the
 * redirect refusal documented on {@link installAuthInterceptor}. Checked
 * two ways, either sufficient alone:
 *
 * - `response.redirected` — the Fetch API's own flag for "this response
 *   was reached via one or more redirects," part of the spec (not
 *   Node/Bun-specific) and set by every conformant `fetch` regardless of
 *   whether `Request.redirect` was honoured.
 * - `new URL(response.url).origin !== new URL(baseUrl).origin` — an
 *   independent check for a `fetch`/proxy whose `redirected` flag is wrong
 *   or unset.
 *
 * `response.url` is `''` for a `Response` built directly (`new
 * Response(...)`, not returned from an actual `fetch` call) — this
 * repo's own `fakeFetch` test harness does exactly that for every one of
 * its scripted replies. That is treated as "no signal" here, deliberately,
 * not a violation: every existing scripted-fetch test in this repo
 * constructs its responses that way, and none of them describes a
 * cross-origin scenario. `baseUrl` may likewise be `undefined` (`Config`
 * requires no default) or fail to parse; both are treated the same way —
 * nothing to compare against, so no verdict.
 */
function isCrossOriginResponse(response: Response, baseUrl: string | undefined): boolean {
  if (response.redirected) return true;
  if (!response.url || !baseUrl) return false;
  try {
    return new URL(response.url).origin !== new URL(baseUrl).origin;
  } catch {
    return false;
  }
}
