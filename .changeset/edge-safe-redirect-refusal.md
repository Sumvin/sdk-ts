---
"@sumvin/sdk": minor
---

Redirect refusal is now edge-safe. Every request this SDK builds previously carried
`redirect: 'error'`, which Cloudflare Workers' workerd rejects at `Request` construction —
so `@sumvin/sdk` could not make a single request on Cloudflare Workers before this release.
Requests now use `redirect: 'manual'` (legal everywhere this SDK targets — Workers,
Node/undici, Bun, browsers), backed by a response-side classifier that still refuses any 3xx
or opaque-redirect reply the same way `redirect: 'error'` did. `ApiErrorKind` is unchanged
and no signature moved, so this is additive rather than a breaking change — called out as a
minor rather than a patch because it changes observable behaviour on two runtimes.

- **The SDK now works on Cloudflare Workers.** Previously every request threw a `TypeError`
  at `Request` construction before `fetch` ever ran.
- **A refused redirect on a browser or edge runtime now surfaces as `kind: 'redirect-refused'`
  instead of `kind: 'network'`.** Neither runtime exposes a signal that distinguishes a refused
  redirect from an ordinary network failure once `fetch` rejects (Node/undici and Bun do, and
  are unaffected by this change) — with `redirect: 'error'` that meant those two runtimes could
  only ever report `'network'` for this case. `redirect: 'manual'` never throws, so this SDK now
  classifies the response itself, on every runtime. Code branching on `error.kind` will see a
  different value for the same event on browser and edge.
- **New `ApiError.redirectOutcome: 'refused' | 'followed' | undefined`**, present only when
  `kind === 'redirect-refused'`. `'refused'` means the redirect target was never contacted —
  no action needed. `'followed'` means a redirect was already followed before this SDK's check
  caught it (only reachable when a consumer-supplied `fetch` rebuilds the request and drops the
  `'manual'` setting) — treat any credential on that request as compromised and rotate it.
- **`FakeReply` (from `@sumvin/sdk/testing`) gains a `type` field**, so a test can script a
  `Response` that presents as `'opaqueredirect'` — the signal a browser produces for a refused
  redirect — to exercise the new classifier's browser-specific branch.
