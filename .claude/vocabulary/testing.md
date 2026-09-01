# Pattern vocabulary addendum — `testing` surface

Prefix: `T`. Seeded from ENG-3467 (publishing `@sumvin/sdk/testing`) and the
fidelity gap it fixed, reproduced in this estate — not a hypothetical. See
`.claude/surfaces.yml` for the surface's registered paths. Per-class format
follows `socrates-core/reference/universal-classes.md`.

This surface is a **test double that ships to every consumer**. A defect
here doesn't just fail a test in this repo — it makes every consumer's test
against the double pass or fail for the wrong reason, silently, everywhere
that double is used.

## T1 — A fake's constructed object omits a signal production code branches on

**Shape:** a test double constructs an object of a real type (`Response`,
`Request`, an SDK error class, …) using only the fields the fake's own
author happened to think of, while production code elsewhere reads a
*different* field of that same type to make a decision.

**Why it kills:** the fake still type-checks and still satisfies every
assertion its own test file makes — nothing looks broken. The gap only
becomes visible when a *consumer* writes a test against the field the fake
never populates: that test cannot fail no matter what the code under test
does, because the fake never produces the `true`/non-default case the
assertion is trying to distinguish. A redirect-backstop test is exactly this
shape: `Response.redirected` and `Response.url` are read-only getters that
default to `false`/`''` on any hand-constructed `Response`, so a fake that
just does `new Response(body, { status, headers })` can never produce a
scripted redirect — every such test passes vacuously, whether or not the
backstop's own `response.redirected` check does anything at all.

**Concrete fingerprint (found and fixed in this repo — `src/testing/fake-fetch.ts`):**
```ts
// VULNERABLE shape: a hand-constructed Response with no way to script
// redirected/url — every scripted reply is `redirected: false, url: ''`.
return new Response(body, { status, headers });

// FIXED shape this surface protects: the fake exposes the field production
// code actually reads, and a consumer can script the case that field gates.
const response = new Response(body, { status, headers });
if (reply.redirected !== undefined) {
  Object.defineProperty(response, 'redirected', { value: reply.redirected });
}
```

**Second instance, same class (ENG-3486 Phase 1b —
`src/testing/fake-fetch.ts`):** `src/auth/interceptor.ts`'s response-side
redirect classifier (`classifyRedirectResponse`) added a production check
reading `response.type === 'opaqueredirect'` — the signal a browser (or any
runtime that filters the response under `redirect: 'manual'`) produces for a
refused redirect — and `FakeReply` had no `type` field until this fix. Same
failure shape as the `redirected`/`url` gap above, one field later: `new
Response(body, { status, headers })` always reports `type: 'default'`, so a
test asserting the classifier's opaqueredirect branch fires would have
passed whether or not that branch's own `response.type` check did anything
at all. Fixed the same way — `FakeReply.type` forged via instance-level
`Object.defineProperty` — and it carries the same T2 caveat below: the
override does not survive `.clone()`, presently harmless only because the
SDK's one cloner (`detectUnparsableJson`) runs solely on `response.ok`, and
an opaqueredirect response (`status: 0`) is never `ok`.

**Where it usually lives:** any hand-rolled fake/mock of a platform type
(`Response`, `Request`, `Headers`, `Event`) that a consumer's test asserts
on a field of, rather than a value the fake's constructor call sets
directly.

**What "an instance" looks like:** the field a real consumer/backstop reads
+ proof the fake's construction path can never produce a non-default value
for it + a test written against that backstop that cannot go red.

**Typical severity:** High when the field gates a security-relevant check
(auth, redirect refusal, origin validation) the fake is meant to exercise;
Medium otherwise — blast is silent false confidence in test coverage, not a
runtime failure, but it can hide a broken production check indefinitely.

**Check mode:** hybrid — grep finds the fake's construction call, but
confirming the gap requires reading what production code actually branches
on and attempting to write a test that fails.

## T2 — A double's fidelity override doesn't survive a transformation production code applies

**Shape:** a test double fakes a platform behaviour via an instance-level
property override (because the real API exposes it as a read-only getter),
and a standard operation on that object (`.clone()`, JSON
serialization, a copy constructor) silently drops the override and reverts
to the type's ordinary default.

**Why it kills:** the double is faithful in the simple case a test writer
checks first, and quietly stops being faithful the moment production code
does something structurally ordinary to the object — cloning it to peek at
a body, say. Nothing errors; the object is still a valid instance of its
type. A regression here is invisible until a *different* piece of
production code starts reading the post-transformation object instead of
the pre-transformation one, at which point every test relying on the
override becomes vacuous again, with no code change to the double itself.

**Concrete fingerprint (named, not yet triggered, in this repo —
`src/testing/fake-fetch.test.ts`):** `Object.defineProperty(response,
'redirected', { value: true })` is an own-property override; `response.clone()`
reverts `redirected` to `false` on every runtime this repo targets, because
`clone()` constructs a fresh `Response` from the underlying implementation,
not a shallow copy of `response`'s own properties. `src/validation/install.ts`
clones only to read the body and returns the *original* response onward —
safe today, but a refactor that started returning the clone instead would
silently reintroduce T1's vacuous-pass failure mode on every existing
redirect-backstop test, with no change to the test files themselves. The
same hazard was confirmed for `type` when it was added (ENG-3486 Phase
1b): `Object.defineProperty(response, 'type', { value: 'opaqueredirect' })`
also reverts to `'default'` on `.clone()`, verified on Node and workerd —
pinned by the file's own type-fidelity test.

**Where it usually lives:** any fake built by overriding a read-only
property on a real platform object (rather than a first-class custom
class), wherever production code between the fake's construction and the
assertion calls `.clone()`, `.slice()`, a spread, or any other operation
that reconstructs a new instance from the underlying value.

**What "an instance" looks like:** the override + the specific
transformation that drops it + a proof (usually a one-line reproduction
across the runtimes this repo targets) that the drop actually happens.

**Typical severity:** Medium today (a proven, currently-safe hazard, not an
active defect) — escalates to the same severity as T1 the moment the
transformation moves between the fake and the check that reads the
overridden field.

**Check mode:** hybrid — the drop itself is a one-line runtime probe per
runtime, but knowing *which* production call sites are safe requires
reading how the returned object is used downstream.

## Summary

| ID | Class | Typical severity | Check mode |
|---|---|---|---|
| T1 | A fake's constructed object omits a signal production code branches on | High/Medium | hybrid |
| T2 | A double's fidelity override doesn't survive a transformation production code applies | Medium | hybrid |

Citations: ENG-3467 (`@sumvin/sdk/testing` publication). T1 is the
`FakeReply.redirected`/`.url` gap sumvin-cli's own hand-rolled fake has
today, fixed here via instance-level `Object.defineProperty`; T2 is the
named-but-not-yet-triggered `.clone()` hazard on that same override, pinned
by `src/testing/fake-fetch.test.ts`'s clone-fidelity test.

**T1/T2 both amended by ENG-3486 Phase 1b** (`@sumvin/sdk` edge-safe
redirect refusal): `FakeReply` gained `type?: ResponseType` so
`src/auth/interceptor.ts`'s new response-side classifier's opaqueredirect
branch — unreachable via `redirected`/`url` alone — could be exercised by a
test at all. Same class as the original `redirected`/`url` gap (T1), same
`.clone()` hazard (T2), one field later; not a new class.
