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
 * first-class override (`src/client.ts` — ENG-3425's CLI supplies its own;
 * see that option's own TSDoc for the contract a consumer `fetch` must
 * honour to keep the protections described here). A consumer `fetch` that
 * *rebuilds* the `Request` it receives — reading only
 * `url`/`method`/`headers`/`body` and constructing a fresh one, a common
 * shape for a logging or proxy-aware wrapper — drops any property it
 * doesn't know to forward, `redirect` included, and this interceptor has no
 * way to observe or prevent that: it runs before the configured `fetch` is
 * ever called. Reproduced directly (`../client.test.ts`, the "Request-
 * rebuilding fetch" test): with such a `fetch`, a cross-origin 302 IS
 * followed, the attacker origin IS contacted, and it DOES receive every
 * credential header this loop just set.
 *
 * The second `client.interceptors.response.use(...)` registered below is a
 * **partial** backstop for exactly that gap: a check on the `Response` that
 * actually came back, using `Response.redirected` and `Response.url` —
 * fields the Fetch API spec defines, not something specific to one runtime.
 * Be precise about what this catches and what it does not, because an
 * earlier version of this comment overstated it:
 *
 * - **What it catches**: a `fetch` wrapper that rebuilds only the outgoing
 *   `Request` and returns the real `Response` object it got back from the
 *   underlying `fetch` unchanged (or merely `.clone()`d) — `redirected` and
 *   `url` survive that untouched, because they live on the `Response`, not
 *   the `Request`. Reproduced directly (`../client.test.ts`, the "Request-
 *   rebuilding fetch" test — it stays caught).
 * - **What defeats it — and this is the important correction**:
 *   `Response.redirected` and `Response.url` are ordinary read-only
 *   properties of a `Response` instance, exactly like `Request.redirect`
 *   is a property of a `Request` instance. A wrapper that reads the body
 *   for logging and hands a *freshly constructed* `Response` downstream —
 *   `new Response(await res.arrayBuffer(), { status, statusText, headers
 *   })`, a completely ordinary shape for a logging/caching/retry wrapper,
 *   not a contrived one — produces a `Response` with `redirected: false`
 *   and `url: ''`, identical to what this repo's own `fakeFetch` test
 *   harness constructs for a plain non-redirected reply. This check cannot
 *   tell the two apart, because there is nothing left in the object to
 *   tell them apart with. Reproduced directly (`../client.test.ts`, the
 *   "Response-rebuilding fetch" test): with such a `fetch`, the attacker
 *   origin is contacted, it receives every credential header, and
 *   the call completes as an ordinary success — **no `ApiError` is
 *   raised**. This is a real, demonstrated limit of what this SDK can
 *   enforce, not a hypothetical; no further check in this file closes it
 *   (see {@link redirectRefusalReason}'s TSDoc for what was considered and
 *   why nothing reliable was found).
 *
 * Even where it does fire, be clear about what this backstop is: **a
 * detection, not a prevention**. By the time a response reaches it, a
 * rebuilding `fetch` has already contacted the redirect target — any
 * credential header was already on the wire. This check cannot un-send it;
 * it converts what would otherwise be a silent, indistinguishable-from-
 * success leak into a loud `kind: 'redirect-refused'` `ApiError`, so at
 * minimum the caller knows to stop trusting the response and to treat the
 * credential as compromised.
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
 * // neither survives a redirect this SDK's own ambient fetch handles. A
 * // consumer-supplied `fetch` that rebuilds the Request but returns the
 * // real Response unchanged is still caught. One that also rebuilds the
 * // Response is NOT — see this function's TSDoc.
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
    const reason = redirectRefusalReason(response, client.getConfig().baseUrl);
    if (reason !== undefined) {
      throw new ApiError({
        kind: 'redirect-refused',
        message:
          reason === 'cross-origin'
            ? 'Refusing a response served by a different origin than requested — the ' +
              'configured fetch implementation followed a cross-origin redirect despite ' +
              "this SDK's own redirect: 'error' request setting. Any credential header on " +
              'this request may already have reached that origin; this check detects the ' +
              'leak, it cannot undo it.'
            : 'Refusing a response that reached this client via a redirect — no operation ' +
              "in this API legitimately redirects, and this SDK's own redirect: 'error' " +
              'request setting should have prevented it (the configured fetch implementation ' +
              'likely rebuilt the outgoing Request and dropped that setting). This redirect ' +
              'happened to land back on the same origin, so this is not necessarily a ' +
              'cross-origin credential leak — but any credential header on this request may ' +
              'already have been sent to whatever the redirect target actually was; this ' +
              'check detects the anomaly, it cannot undo it.',
        request,
        response,
      });
    }
    return response;
  });

  return requestInterceptorId;
}

/** See {@link redirectRefusalReason}. */
type RedirectRefusalReason = 'cross-origin' | 'same-origin' | undefined;

/**
 * Names why `response` looks like it should never have reached this client
 * — the fetch-implementation-independent half of the redirect refusal
 * documented on {@link installAuthInterceptor} — or `undefined` when
 * nothing looks wrong. Despite this function's old name
 * (`isCrossOriginResponse`), `response.redirected` fires for a
 * **same-origin** redirect too — this API has no legitimate reason to
 * redirect at all (see `installAuthInterceptor`'s own TSDoc on
 * `redirect: 'error'`), so any redirect reaching here is already an
 * anomaly regardless of where it landed. Returning a reason, rather than a
 * boolean plus a hardcoded "different origin" message, is what keeps the
 * thrown `ApiError`'s message honest about which one actually happened.
 *
 * Checked two ways, either sufficient alone to report `'same-origin'`; a
 * confirmed origin mismatch upgrades the reason to `'cross-origin'`:
 *
 * - `response.redirected` — the Fetch API's own flag for "this response
 *   was reached via one or more redirects," part of the spec (not
 *   Node/Bun-specific) and set by every conformant `fetch` regardless of
 *   whether `Request.redirect` was honoured. This alone does not say
 *   *which* origin was reached — see `response.url` below.
 * - `new URL(response.url).origin !== new URL(baseUrl).origin` — checked
 *   whenever both URLs are available and parse, independently of
 *   `redirected`: it both upgrades a same-origin verdict to cross-origin
 *   when the target is known, and catches a `fetch`/proxy whose
 *   `redirected` flag is wrong or unset but whose `url` still moved.
 *
 * `response.url` is `''` for a `Response` built directly (`new
 * Response(...)`, not returned from an actual `fetch` call) — this
 * repo's own `fakeFetch` test harness does exactly that for every one of
 * its scripted replies, and so does the "Response-rebuilding fetch" attack
 * shape documented on {@link installAuthInterceptor}: a wrapper that reads
 * the real `Response`'s body and constructs a fresh one for logging
 * purposes produces exactly this same empty-`url`/`redirected: false`
 * shape, indistinguishable from an ordinary non-redirected reply. That is
 * treated as "no signal" here, deliberately, not a violation — this
 * function cannot see past it, and no other check in this file can either
 * (documented, not silently accepted, on {@link installAuthInterceptor}).
 * `baseUrl` may likewise be `undefined` (`Config` requires no default) or
 * fail to parse; both are treated the same way — nothing to compare
 * against, so no upgrade to `'cross-origin'`.
 *
 * **On further detection**: nothing else reliable was found, and nothing
 * invented to paper over that. `client.interceptors.request`/`.response`
 * only see the `Request` going in and the `Response` coming back out of
 * whatever `fetch` was configured — there is no hook on what that `fetch`
 * does internally between those two points, so this code cannot observe
 * whether a real, unmodified `Response` object ever existed before the one
 * that reached here. Ideas considered and rejected: `response.type`
 * (its value for a hand-constructed `Response` — `'default'` — is also
 * the value for plenty of legitimate non-redirected replies, including
 * every scripted `fakeFetch` reply in this repo, so it carries no signal);
 * tagging the outgoing `Request` with an expando/`WeakMap` key to check
 * for on the way back (a `Response` carries no reference to the `Request`
 * that produced it, so there is nothing to key the check off downstream).
 * If a genuinely reliable signal surfaces later, it belongs here — this
 * function's absence of one is the honest current answer, not a design
 * decision to leave the gap open.
 */
function redirectRefusalReason(
  response: Response,
  baseUrl: string | undefined,
): RedirectRefusalReason {
  const crossOrigin = ((): boolean => {
    if (!response.url || !baseUrl) return false;
    try {
      return new URL(response.url).origin !== new URL(baseUrl).origin;
    } catch {
      return false;
    }
  })();

  if (crossOrigin) return 'cross-origin';
  if (response.redirected) return 'same-origin';
  return undefined;
}
