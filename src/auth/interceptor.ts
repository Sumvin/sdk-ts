import { ApiError } from '../errors/api-error.js';
import type { Client } from '../generated/client/index.js';
import type { AuthProvider } from './provider.js';

/**
 * Registers a `client.interceptors.request` handler that sets every
 * configured provider's header, additively — never through `Config.auth` /
 * per-operation `security` metadata.
 *
 * That is a deliberate rejection, not an oversight. `Config.auth` is driven
 * by the spec's per-operation `security` array and selects *one* scheme per
 * requirement — the shape the OpenAPI generator hands you for "this
 * operation accepts credential A **or** B". That shape is unsafe to build on
 * here: the server identifies the caller from a base credential
 * (`x-juno-jwt` / `x-sumvin-pat`) **unconditionally**, before it ever reads
 * a Stamped Mandate header — a Stamped Mandate only *narrows what* the
 * identified caller may do, it never substitutes for the base credential —
 * while the spec lists the base and Stamped Mandate schemes as separate
 * requirement objects (an OR) across 135 operations. An OR-shaped selector
 * would eventually pick the Stamped Mandate alone on one of those operations
 * and silently drop the header the server actually requires. Setting every configured provider's header additively sidesteps
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
 * A provider's `appliesTo` (see `./provider.js` for the quantified reason
 * it exists) is checked per request, keyed the same way
 * `src/validation` keys operations: `` `${options.method} ${options.url}` ``
 * — `options.url` is the un-substituted path template, same proof as
 * `src/validation/seam.test.ts`. `getToken()` is still called for every
 * provider regardless of `appliesTo` (only whether the RESULT is applied is
 * gated); a provider with no `appliesTo` applies to every request, exactly
 * today's behaviour.
 *
 * **Also refuses to follow a redirect on every request, always — not only
 * when a provider is configured.** Found by reproduction: the generated
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
 * **`redirect: 'manual'`, not `'error'` — and this is a substrate fact, not
 * a preference.** `'error'` was the original design, on the reasoning that a
 * credentialed call to this API has no legitimate reason to redirect, so
 * making `fetch` itself reject on the first hop looked like the tightest
 * possible refusal. It is not portable: **Cloudflare Workers' workerd
 * rejects `redirect: 'error'` at `Request` construction itself** —
 * `TypeError: Invalid redirect value, must be one of "follow" or "manual"`,
 * observed directly against a real workerd isolate, before any `fetch` ever
 * runs. Edge runtimes are a supported target; `'error'` made this SDK
 * unusable there on every single request. `'manual'` is legal everywhere
 * this SDK targets (workerd, Node/undici, Bun, browsers) — verified
 * directly on all four, including that it survives `Request.clone()` — and
 * it never itself contacts the redirect target either: on every runtime
 * tested, a `'manual'` fetch against a 3xx resolves to an *inspectable*
 * `Response` (`status` in the 3xx band on workerd/Node/Bun, or
 * `type: 'opaqueredirect'` with `status: 0` on a real browser) rather than
 * following the hop. No runtime was found — checked directly, not assumed
 * from a spec — where `'manual'` causes the redirect to be followed.
 *
 * The cost of that portability is that `'manual'` never throws, so unlike
 * `'error'` there is no request-side signal at all to catch. **Every bit of
 * detection this SDK does for a redirected reply now happens response-side**
 * — the second interceptor registered below, which classifies every
 * incoming `Response` into one of four outcomes (see
 * {@link classifyRedirectResponse} for the table and, especially, the order
 * those checks must run in — getting that order wrong is the single most
 * dangerous way to modify this file).
 *
 * This reconstructs the `Request` (`redirect` cannot be reassigned on an
 * existing one, unlike `headers`) — `new Request(request, { redirect:
 * 'manual' })` clones every other property, including whatever headers the
 * loop above just set, unchanged. Applying this unconditionally (not only
 * when `providers.length > 0`) is deliberate: an unauthenticated client
 * still sends a `user-agent` / other configured header worth protecting
 * (a CLI's required `user-agent`, see `src/client.ts`), and a consumer should never
 * have to add a provider just to get redirect safety.
 *
 * **This request-side setting is NOT enforceable against every `fetch` this
 * SDK can be handed.** `CreateSumvinClientOptions.fetch` is a documented,
 * first-class override (`src/client.ts` — a CLI typically supplies its own;
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
 * The second `client.interceptors.response.use(...)` registered below is
 * what catches exactly that gap: a classifier on the `Response` that
 * actually came back, using `response.status`, `response.type`,
 * `response.redirected`, and `response.url` — fields the Fetch API spec
 * defines, not something specific to one runtime. Two of its four outcomes
 * (`refused-opaque`, `refused-status`) are the *normal, expected* result of
 * every legitimate redirect this SDK's own `'manual'` request setting
 * produces — nothing was contacted, nothing to detect. The other two
 * (`followed-cross-origin`, `followed-same-origin`) are reachable only
 * through the gap above: a consumer `fetch` that dropped the `'manual'`
 * setting and let the real hop happen. Be precise about what that half
 * catches and what it does not, because an earlier version of this comment
 * overstated it:
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
 *   not a contrived one — produces a `Response` with `redirected: false`,
 *   `url: ''`, and `type: 'default'`, identical to what this repo's own
 *   `fakeFetch` test harness constructs for a plain non-redirected reply.
 *   This check cannot tell the two apart, because there is nothing left in
 *   the object to tell them apart with. Reproduced directly
 *   (`../client.test.ts`, the "Response-rebuilding fetch" test): with such
 *   a `fetch`, the attacker origin is contacted, it receives every
 *   credential header, and the call completes as an ordinary success —
 *   **no `ApiError` is raised**. This is a real, demonstrated limit of what
 *   this SDK can enforce, not a hypothetical; no further check in this file
 *   closes it (see {@link classifyRedirectResponse}'s TSDoc for what was
 *   considered and why nothing more reliable was found).
 *
 * Even for the two outcomes it does catch, be clear about what this check
 * is: **a detection, not a prevention**. By the time a `followed-*` response
 * reaches it, a rebuilding `fetch` has already contacted the redirect
 * target — any credential header was already on the wire. This check cannot
 * un-send it; it converts what would otherwise be a silent,
 * indistinguishable-from-success leak into a loud `kind: 'redirect-refused'`
 * `ApiError` with `redirectOutcome: 'followed'`, so at minimum the caller
 * knows to stop trusting the response and to treat the credential as
 * compromised. The `refused-*` outcomes carry `redirectOutcome: 'refused'`
 * instead — nothing to detect after the fact, because nothing was ever
 * contacted.
 *
 * @returns the id of the request-side interceptor (auth headers +
 * `redirect: 'manual'`), for `client.interceptors.request.eject(id)`. The
 * response-side classifier registered alongside it has no separate id
 * exposed — this function has no partial-uninstall story today; ejecting
 * the returned id removes only the request-side half.
 *
 * @example
 * const client = createClient(createConfig({ baseUrl }));
 * installAuthInterceptor(client, [sumvinPat(pat), pintToken(() => currentPint?.token)]);
 * // Every request now carries `x-sumvin-pat`, and `x-sumvin-pint-token` too
 * // whenever a Stamped Mandate is active — both, not one instead of the other — and
 * // every request is sent with `redirect: 'manual'`, so a genuine redirect
 * // reply is refused (kind: 'redirect-refused', redirectOutcome: 'refused')
 * // without ever contacting the target. A consumer-supplied `fetch` that
 * // rebuilds the Request but returns the real Response unchanged is still
 * // caught (redirectOutcome: 'followed'). One that also rebuilds the
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

    return new Request(request, { redirect: 'manual' });
  });

  client.interceptors.response.use((response, request) => {
    const classification = classifyRedirectResponse(response, client.getConfig().baseUrl);
    if (classification === undefined) return response;

    throw new ApiError({
      kind: 'redirect-refused',
      redirectOutcome: classification.redirectOutcome,
      message: redirectRefusalMessage(classification.outcome),
      // An opaqueredirect response's status is spec-mandated 0 — not a
      // meaningful HTTP status to surface. Every other outcome here carries
      // a real, non-zero status (a genuine 3xx, or whatever the followed
      // target actually replied with).
      status: response.status !== 0 ? response.status : undefined,
      request,
      response,
    });
  });

  return requestInterceptorId;
}

/** One of the four outcomes {@link classifyRedirectResponse} can report. */
export type RedirectOutcome =
  | 'followed-cross-origin'
  | 'followed-same-origin'
  | 'refused-opaque'
  | 'refused-status';

/** See {@link classifyRedirectResponse}. */
export type RedirectClassification =
  | {
      readonly outcome: 'followed-cross-origin' | 'followed-same-origin';
      readonly redirectOutcome: 'followed';
    }
  | { readonly outcome: 'refused-opaque' | 'refused-status'; readonly redirectOutcome: 'refused' }
  | undefined;

/**
 * Classifies `response` into one of four outcomes, or `undefined` when
 * nothing about it looks like a redirect at all — the entire detection
 * surface left once request-side `redirect: 'manual'` never itself throws
 * (see `installAuthInterceptor`'s own TSDoc for why `'manual'`, not
 * `'error'`).
 *
 * | Order | Predicate | Outcome | Did anything leak? |
 * |---|---|---|---|
 * | 1 | `response.url` origin ≠ `baseUrl` origin | `followed-cross-origin` | **Yes** |
 * | 2 | `response.redirected` | `followed-same-origin` | **Yes** |
 * | 3 | `response.status === 304` | not a redirect (`undefined`) | No — only reachable once 1-2 already returned false |
 * | 4 | `response.type === 'opaqueredirect'` | `refused-opaque` | No |
 * | 5 | `300 <= status < 400` | `refused-status` | No |
 *
 * **This order is the single most dangerous detail in this file, and it is
 * checked in EXACTLY the sequence above — do not reorder it for tidiness.**
 * The two outcomes that mean a credential may have already leaked
 * (`followed-*`) are checked BEFORE every other predicate, `304` included.
 * An earlier draft of this classifier put the status-band check above the
 * origin check; running it proved that ordering wrong. The scenario: a
 * consumer `fetch` rebuilds the outgoing `Request` (the gap documented
 * above) and follows a redirect to an
 * attacker-controlled origin — and the attacker's own reply can itself be
 * another 3xx:
 *
 * ```
 * status=307 redirected=true url=https://evil.example/again
 *   status-band-first  -> refused-status        (WRONG: claims nothing leaked)
 *   origin-first        -> followed-cross-origin (correct: assume compromised)
 * ```
 *
 * A status-band-first classifier reports `refused-status` — "nothing
 * leaked" — for a response that already reached an attacker who chose to
 * reply with a 3xx of their own. This SDK's own credential was on the wire
 * to that origin the moment the rebuilding `fetch` followed the first hop;
 * whether the attacker's *reply* happens to also be a 3xx is irrelevant to
 * that fact, and irrelevant to what the caller needs to do about it. The
 * origin-first ordering above gets this right by construction: leak checks
 * run first, so once either one fires, no refusal check downstream ever
 * gets a chance to misreport a leak as a refusal. This mirrors the house
 * precedent for exactly this shape, `safeFetchSpec` in
 * `workers/ucp-crawler/src/services/capability/ssrf-guard.ts:279-310`.
 *
 * **The same mistake recurred one predicate later, and an adversarial
 * verification gate on this PR caught it by execution.** An earlier version
 * of this function put the `304` check first — above both leak checks,
 * rather than merely above the two refusal checks — on the reasoning that
 * "304 isn't a redirect, so check it and get out early." That reasoning
 * treats 304 as evidence of safety, which it is not: an attacker's own
 * reply can just as easily be a 304 as a 307, and a `304` + `redirected:
 * true` + cross-origin `url` response was misclassified `undefined` — no
 * `ApiError`, no `redirectOutcome`, no signal to rotate the credential —
 * instead of `followed-cross-origin`. 304 does have a leak axis like every
 * other status; only its *refusal* axis is `n/a`, because a 304 is never
 * itself classified `refused-*` or `followed-*` — it means "not a redirect
 * at all." Fixed by moving the `304` check below both leak checks (see the
 * regression test in `interceptor.test.ts` for the exact repro).
 *
 * The reverse mis-ordering is not a symmetric risk. A genuine refusal (no
 * consumer `fetch` interference at all) never sets `response.redirected`
 * — `'manual'` follows nothing, observed `redirected: false` on every
 * runtime this SDK targets — and leaves `response.url` on the request's own
 * origin (or unset). Checks 1 and 2 therefore cannot fire on a genuine
 * refusal, so putting them first costs nothing on the common path; it only
 * changes the answer on the attacker-controlled path above. **When in
 * doubt, this classifier assumes the credential leaked** — that asymmetry
 * is the entire point of the ordering.
 *
 * Other load-bearing details, in the order a reader hits them:
 *
 * - **304 is checked third — below both leak checks, above both refusal
 *   checks — and treated as "not a redirect" even though it sits inside the
 *   numeric 3xx band.** It is a conditional-GET success, not a redirect.
 *   This SDK sends no validators (`If-None-Match` / `If-Modified-Since`) on
 *   any request today, so a legitimate 304 should never arrive — but a
 *   server returning one unsolicited is cheap insurance against, not a
 *   scenario to refuse. It sits below the leak checks precisely because a
 *   304 is not evidence that nothing leaked — an attacker's reply can be a
 *   304 too — so those checks must get first look at it.
 *   `fakeFetch` already special-cases 304 as bodyless for the same reason.
 * - **The band, not the WHATWG redirect-status set.** The Fetch spec's own
 *   redirect statuses are exactly {301, 302, 303, 307, 308}; this refuses
 *   the whole 300–399 band instead (minus 304), because this API
 *   legitimately returns no 3xx of ANY kind — so 300, 305, and 306 are
 *   anomalies too, not values this classifier should let through unchecked.
 *   That is also why the thrown message for `refused-status` says "a 3xx
 *   response, which no operation in this API returns" rather than "the API
 *   redirected" — the wording has to stay honest for the whole band, not
 *   only the WHATWG subset.
 * - **`response.headers.get('location')` is never read, anywhere in this
 *   file.** The redirect target is attacker-controlled the moment a
 *   redirect reaches here at all; nothing in the thrown error names it.
 *   Same discipline as the house precedent, `safeFetchSpec`.
 * - **`(response.type as string)`, not a `Response['type']`-typed
 *   comparison.** `@cloudflare/workers-types`' `Response['type']` union
 *   omits `'opaqueredirect'` even though workerd's runtime value can be it
 *   — the same cast, for the same reason, as the house precedent.
 *
 * `response.url` is `''` for a `Response` built directly (`new
 * Response(...)`, not returned from an actual `fetch` call) — this repo's
 * own `fakeFetch` test harness does exactly that for every one of its
 * scripted replies unless a test opts in with `FakeReply.url`, and so does
 * the "Response-rebuilding fetch" attack shape documented on
 * `installAuthInterceptor`: a wrapper that reads the real `Response`'s body
 * and constructs a fresh one for logging purposes produces exactly this
 * same empty-`url`/`redirected: false`/`type: 'default'` shape,
 * indistinguishable from an ordinary non-redirected reply. That is treated
 * as "no signal" here, deliberately, not a violation — this function cannot
 * see past it, and no other check in this file can either (documented, not
 * silently accepted, on `installAuthInterceptor`). `baseUrl` may likewise be
 * `undefined` (`Config` requires no default) or fail to parse; both are
 * treated the same way — nothing to compare against, so no upgrade to
 * `followed-cross-origin`.
 *
 * **On further detection**: nothing else reliable was found, and nothing
 * invented to paper over that. `client.interceptors.request`/`.response`
 * only see the `Request` going in and the `Response` coming back out of
 * whatever `fetch` was configured — there is no hook on what that `fetch`
 * does internally between those two points, so this code cannot observe
 * whether a real, unmodified `Response` object ever existed before the one
 * that reached here. Ideas considered and rejected: tagging the outgoing
 * `Request` with an expando/`WeakMap` key to check for on the way back (a
 * `Response` carries no reference to the `Request` that produced it, so
 * there is nothing to key the check off downstream). If a genuinely
 * reliable signal surfaces later, it belongs here — this function's absence
 * of one is the honest current answer, not a design decision to leave the
 * gap open.
 */
export function classifyRedirectResponse(
  response: Response,
  baseUrl: string | undefined,
): RedirectClassification {
  if (isCrossOrigin(response.url, baseUrl)) {
    return { outcome: 'followed-cross-origin', redirectOutcome: 'followed' };
  }
  if (response.redirected) {
    return { outcome: 'followed-same-origin', redirectOutcome: 'followed' };
  }

  if (response.status === 304) return undefined;

  if ((response.type as string) === 'opaqueredirect') {
    return { outcome: 'refused-opaque', redirectOutcome: 'refused' };
  }
  if (response.status >= 300 && response.status < 400) {
    return { outcome: 'refused-status', redirectOutcome: 'refused' };
  }

  return undefined;
}

/**
 * True when `responseUrl` parses and names a different origin than
 * `baseUrl`. Both empty/missing and unparseable inputs return `false` —
 * "nothing to compare against" is not evidence of a cross-origin response;
 * see {@link classifyRedirectResponse}'s TSDoc for why that is the honest
 * answer rather than a gap.
 */
function isCrossOrigin(responseUrl: string, baseUrl: string | undefined): boolean {
  if (!responseUrl || !baseUrl) return false;
  try {
    return new URL(responseUrl).origin !== new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The thrown `ApiError.message` for each {@link RedirectOutcome} —
 * deliberately distinct per outcome (never a shared, generic string),
 * because a `redirect-refused` failure's own TSDoc forbids a consumer
 * keying behaviour off `error.message` and this is the last-resort,
 * developer-facing text a human actually reads. The refused/followed split
 * mirrors {@link ApiError.redirectOutcome}, which is the field a consumer
 * should key off instead.
 */
function redirectRefusalMessage(outcome: RedirectOutcome): string {
  switch (outcome) {
    case 'followed-cross-origin':
      return (
        'Refusing a response served by a different origin than requested — the ' +
        'configured fetch implementation followed a cross-origin redirect despite this ' +
        "SDK's own redirect: 'manual' request setting (a fetch wrapper that reconstructs " +
        'the outgoing Request typically drops that setting). Any credential header on ' +
        'this request may already have reached that origin — treat it as compromised and ' +
        'rotate it; this check detects the leak, it cannot undo it.'
      );
    case 'followed-same-origin':
      return (
        'Refusing a response that reached this client via a redirect — no operation in ' +
        "this API legitimately redirects, and this SDK's own redirect: 'manual' request " +
        'setting should have kept the redirect target from ever being contacted (the ' +
        'configured fetch implementation likely rebuilt the outgoing Request and dropped ' +
        'that setting). This redirect happened to land back on the same origin, so this ' +
        'is not necessarily a cross-origin credential leak — but any credential header on ' +
        'this request may already have been sent to whatever the redirect target actually ' +
        'was. Treat it as compromised and rotate it; this check detects the anomaly, it ' +
        'cannot undo it.'
      );
    case 'refused-opaque':
      return (
        "Refusing an opaque redirect response — this SDK's own redirect: 'manual' request " +
        'setting means the redirect target was never contacted, so no credential on this ' +
        'request could have reached it. No operation in this API legitimately redirects.'
      );
    case 'refused-status':
      return (
        "Refusing a 3xx response, which no operation in this API returns — this SDK's own " +
        "redirect: 'manual' request setting means the redirect target was never " +
        'contacted, so no credential on this request could have reached it.'
      );
  }
}
