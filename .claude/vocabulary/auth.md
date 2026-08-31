# Pattern vocabulary addendum — `auth` surface

Prefix: `A`. Seeded from ENG-3424 (the curated layer), reproduced/fixed
directly in this repo's history — not hypotheticals. See
`.claude/surfaces.yml` for the surface's registered paths and
`.claude/skills/posture-check/references/surface-registry-format.md` for
this file's role. Per-class format follows
`socrates-core/reference/universal-classes.md`.

## A1 — Credential survives a cross-origin redirect because only the
built-in headers are stripped

**Shape:** a request interceptor sets a custom credential header
(`x-*`, not `Authorization`/`Cookie`/`Proxy-Authorization`) on a `Request`
whose `redirect` is left at the generated client's default (`'follow'`), or
is set to `'error'`/`'manual'` only conditionally (e.g. only when a provider
is configured).

**Why it kills:** the Fetch spec strips only `Authorization`, `Cookie`, and
`Proxy-Authorization` across a cross-origin redirect — never a custom
header. A malicious or compromised API origin that 302s a credentialed call
forwards every custom credential header verbatim to whatever origin the
`Location` names, and the call otherwise completes looking like a normal
success. No CORS preflight catches this — redirects are followed
transparently by `fetch` itself.

**Concrete fingerprint (fixed in this repo — `src/auth/interceptor.ts`):**
```ts
// VULNERABLE shape: headers set, redirect never pinned
client.interceptors.request.use((request) => {
  request.headers.set(provider.header, token);
  return request; // redirect stays 'follow' — the generated default
});

// FIXED shape this surface protects: reconstruct with redirect: 'error',
// unconditionally, not gated on `providers.length > 0`
return new Request(request, { redirect: 'error' });
```

**Where it usually lives:** the request-interceptor/middleware layer of any
HTTP client wrapper that adds credential headers, especially one built on a
generated client whose transport defaults (`redirect`, `credentials`) are
not visible at the call site.

**What "an instance" looks like:** the interceptor that sets the header +
confirmation that `redirect` is pinned to `'error'`/`'manual'` on every
request path that can carry a credential, not only a subset (e.g. only when
`auth.length > 0`) — the unconditional case matters because an
unauthenticated client that still sends a protectable header (e.g.
`user-agent`) needs the same guard.

**Typical severity:** Critical — blast is a live credential reaching an
attacker/compromised origin (security compromise); detectability is silent
(the call looks like a normal success) unless a response-side backstop
exists (see A2's note); recovery requires treating the credential as
compromised; trigger requires only that the API origin issue a redirect,
which needs no client-side misconfiguration to fire.

**Check mode:** hybrid — grep for `new Request(request, { redirect:` /
`redirect: 'error'` finds the mechanism, but confirming it applies
unconditionally (not gated behind a provider-count check) needs reading the
surrounding branch.

## A2 — The redirect guard is request-side only; a consumer-supplied
`fetch` that rebuilds the `Request` silently drops it

**Shape:** an SDK/wrapper accepts a caller-supplied `fetch` implementation
(a documented override point, e.g. for logging, proxying, or a
non-browser runtime) and relies on a property set on the `Request` object
(`redirect`, custom headers) to hold once that `fetch` is invoked — with no
independent check on the `Response` that comes back.

**Why it kills:** a `fetch` wrapper that reads `url`/`method`/`headers`/
`body` off the `Request` it receives and constructs a fresh one — a common
shape for a logging or proxy-aware wrapper — drops any property it doesn't
know to forward, `redirect` included. The request-side guard (A1) never
observes this: it runs before the configured `fetch` is ever called. With
such a `fetch`, a cross-origin redirect IS followed, the attacker/compromised
origin IS contacted, and it receives every credential header the interceptor
set — silently, with the call otherwise looking like a normal success.

**Concrete fingerprint (this repo's own reproduction — `client.test.ts`,
"rebuilding custom fetch"):**
```ts
// Consumer-supplied fetch that defeats A1's redirect: 'error' entirely
const rebuildingFetch: typeof fetch = (input, init) => {
  const req = input as Request;
  return fetch(new Request(req.url, { method: req.method, headers: req.headers }));
  // ^ drops `redirect` — the clone reverts to the ambient default
};
```

**What "an instance" looks like:** a documented `fetch` override option +
confirmation that a **response-side** backstop exists and is independent of
which `fetch` implementation produced the response — e.g. checking
`response.redirected` and `new URL(response.url).origin` against the
configured base origin, not just trusting the request-side setting held.

**Typical severity:** High — same blast (credential reaches the wrong
origin) and same silent-success shape as A1, but detectability is better
when a response-side backstop is present (it converts the leak into a loud,
typed error after the fact — a detection, not a prevention) and trigger
requires a consumer to supply a rebuilding `fetch`, which is a deliberate
integration choice rather than the default path.

**Check mode:** hybrid — grep confirms a documented `fetch` override option
exists; confirming an independent response-side check exists (and that it
doesn't itself trust request-side state) needs reading both halves.

## A3 — A credential-carrying object is reachable through a runtime's
default object-inspection path even when JSON serialization is clean

**Shape:** an error/response type holds a `request`/`response` (or any
object carrying live credential headers) as a plain property, with no
override for the runtime's default debug-printing path (Node's
`util.inspect`, i.e. `console.log(err)`), while its `toJSON()`/serialized
form is already redacted.

**Why it kills:** `JSON.stringify`/`toJSON()` being clean is not sufficient
— `console.log(errorInstance)` and any tool built on `util.inspect`
(REPLs, most Node loggers, some error trackers) walk the object's own
enumerable properties directly, bypassing `toJSON()` entirely. A `request`
or `response` held as a plain property prints every header, credential
included, in plaintext to whatever captures stdout/stderr — CI logs,
terminals, third-party log aggregators. This is a completely ordinary
debugging action (`console.log(error)`), not a misuse.

**Concrete fingerprint (this repo's guard — `src/errors/api-error.ts`):**
```ts
// The gap this class targets: request/response held as a plain property,
// no custom inspector — util.inspect(err) prints every header verbatim.
class ApiError extends Error {
  request?: Request;
  response?: Response;
}

// The fix this surface protects: a custom inspector keyed off the
// globally-registered symbol (works even on a runtime that never imported
// `util`), omitting request/response from the default debug view.
[Symbol.for('nodejs.util.inspect.custom')](): string { /* redacted view */ }
```

**Where it usually lives:** any custom `Error` subclass, or response
wrapper, that stores the original HTTP `Request`/`Response` (or a raw
token/header map) for debugging convenience.

**What "an instance" looks like:** a class holding request/response/token
data as an own property + confirmation that both the JSON path (`toJSON`)
AND the default-inspection path (`util.inspect.custom`, or the runtime's
equivalent) redact it — checking only one is not sufficient, and a class
added later that also carries credential data but wasn't given the same
inspector is the regression this class exists to catch.

**Typical severity:** Critical — trigger is trivial (any ordinary
`console.log`/debugger inspection of the object), detectability is silent
(nothing flags that a log line now contains a live credential), and
recovery requires rotating the credential and auditing every place the log
line may have been captured (CI artifacts, log aggregators, error
trackers).

**Check mode:** hybrid — grep for `Symbol.for('nodejs.util.inspect.custom')`
finds the guard's presence; confirming every credential-carrying class has
one (not just the ones that already do) requires reading each class's
property list.

## Summary

| ID | Class | Typical severity | Check mode |
|---|---|---|---|
| A1 | Credential survives cross-origin redirect (custom headers not stripped) | Critical | hybrid |
| A2 | Consumer `fetch` rebuild silently drops the redirect guard | High | hybrid |
| A3 | Credential reachable via default object-inspection despite clean JSON | Critical | hybrid |

Citations: ENG-3424 curated-layer PR — A1/A2 fixed in
`src/auth/interceptor.ts` (commit `7b95a60`, "refuse redirects so
credentials cannot follow one cross-origin"), reproduced in
`src/client.test.ts`; A3 implemented in `src/errors/api-error.ts`. All three
found by an adversarial verification pass and a posture check,
independently, per the interceptor's own TSDoc.
