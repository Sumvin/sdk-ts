---
"@sumvin/sdk": minor
---

This is a breaking release under the "0.x, honest minor-bump-on-break" convention — feedback
from the sumvin-cli integration surfaced a few places where the curated layer said one thing
and did another. Fixing them changes observable behaviour.

- **One error funnel for every SDK error family.** `SumvinError` is a new abstract base every
  error this SDK throws or returns now extends — `ApiError`, `ContractDriftError`, `HalError`
  (and its subclasses), `DeviceLoginError` (and its subclasses), `TypedDataPrecisionError`, and
  the two new signing errors below. `isSumvinError()` catches all of them in one branch;
  `isContractDriftError()` narrows a result to a strict-tier contract-drift failure the same way
  `isApiError()` already narrows a request failure. Both are exported from `@sumvin/sdk` and
  from `@sumvin/sdk/react` (a hook author narrowing a query/mutation's `error` no longer needs a
  second import from the root entry point). `isApiError` and `isContractDriftError` stay
  deliberately disjoint — a contract-drift failure is not a request failure, and folding one
  into the other would give it a `status`/`errorCode`/`problem` of `undefined` instead of a loud
  type mismatch.
- **`uint*` fields now refuse a negative `bigint`.** Previously a negative `bigint` value on an
  unsigned field passed straight through to the signer unchanged — an unsigned type has no
  representation for a sign at all, so the resulting signature committed to a struct the server
  could never reconstruct from the same inputs. All three wire forms (`bigint`, number,
  all-digit decimal string) are now refused uniformly, throwing the new `TypedDataSignError`.
- **An array/scalar mismatch against a field's declared type now throws, named.** A
  `uint256[]`-declared field handed a scalar used to pass the value through unchanged, silently.
  A `uint256`-declared field handed an array used to throw `TypedDataPrecisionError` with a
  message reading `got 5` — because `String([5]) === '5'` — misattributing a shape problem to a
  precision one. Both cases now throw the new `TypedDataShapeError`, naming the field and its
  declared type. Array happy-path order, length, and membership are unchanged.
- **`int*` fields now accept negative values that previously threw.** A signed field wrongly
  refused every negative value in all three wire forms. This is a loosening — code that relied
  on the field rejecting negatives will now see it succeed — but it's a behaviour change, so it's
  called out here rather than folded silently into a patch.
- **`TypedDataPrecisionError`'s message no longer says "non-negative".** It was wrong the moment
  a signed field could legitimately hold one; the message now describes precision only, which is
  the only thing this error is about.
- **`Hal` gains an interface member: `followValidated`.** This breaks anyone who implements a
  `Hal`-shaped object directly rather than getting one from `halOf()`. Nobody should be doing
  that — `halOf()` is the only place this SDK constructs a `Hal` — but it is a type-level break
  and is called out as one. `follow()` itself is unchanged: it still returns the response body
  typed `unknown`, which remains a deliberate decision (an arbitrary `rel` can't be mapped back
  to a named operation), not something this release tightens.

**Additive, alongside the above:**

- `SumvinError`, `isSumvinError` from `@sumvin/sdk` and `@sumvin/sdk/react`.
- `isContractDriftError` from `@sumvin/sdk` (the class itself was already exported; there was
  no guard function to narrow with, only a bare `instanceof`) and from `@sumvin/sdk/react`.
- `TypedDataSignError`, `TypedDataShapeError` from `@sumvin/sdk/signing`.
- `Hal.followValidated(client, rel, schema, vars?)` — follows a link and parses the response
  against a caller-supplied Zod schema instead of returning `unknown`, throwing
  `ContractDriftError` on a mismatch into the same funnel a generated operation's response
  validator throws into.
- A new `@sumvin/sdk/testing` subpath, re-exporting `fakeFetch` — the scripted `fetch` this
  repo's own test suite already uses to exercise real curated behaviour (auth headers,
  validation tiers, error normalization, HAL following) instead of a hand-rolled approximation
  of this SDK's transport. Not included in the root `@sumvin/sdk` import, so it never reaches a
  production bundle by accident.

**Migration note for sumvin-app-v2.** Existing bare `instanceof ApiError` checks keep working
unchanged — they never caught a `ContractDriftError` before this release and still don't. The
fix where you want the new coverage is to add one `isContractDriftError` (or `isSumvinError`)
branch alongside an existing `instanceof ApiError` check, not to churn every existing call site.
