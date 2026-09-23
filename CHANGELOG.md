# @sumvin/sdk

## 0.4.0

### Minor Changes

- [#20](https://github.com/Sumvin/sdk-ts/pull/20) [`7f564d2`](https://github.com/Sumvin/sdk-ts/commit/7f564d256634209b5b0fba77152ce872b90bf035) Thanks [@3266miles](https://github.com/3266miles)! - Add `putMandateKeyWallet` and `getMandateKeyShare`, generated from sumvin-api's new mandate-key wallet-bind surface: verifying and binding a browser-created Para wallet as the account holder's mandate key, and reading back its encrypted key share.
  
  - `putMandateKeyWallet` — `PUT /v0/user/me/mandate-key/wallet` — binds a browser-created wallet as the mandate key and starts adding it as a smart-wallet owner.
  - `getMandateKeyShare` — `GET /v0/user/me/mandate-key/share` — reads the wallet's encrypted key share back once binding has completed.
  - `getUserMandateKey`'s response (`MandateKeyActivationResponse`) now carries a strongly-typed `_links` (`MandateKeyLinks`): `self` is always present, `wallet` and `share` are nullable — `share` is explicitly `null` until a wallet is bound, since there is nothing to read back yet.
  - New `PAR-*` error codes on `ApiErrorCode` for the embedded-wallet provider's failure modes (unauthorized signature, not-found wallet, conflicting binding state, validation, rate limiting, and upstream provider errors).
  
  The vendored OpenAPI spec is re-pinned to sumvin-api `8c4cb17` (the merged `main` commit for PR [#2043](https://github.com/Sumvin/sdk-ts/issues/2043); superseding this PR's earlier `201eb459` pre-review pin) and the generated client is regenerated from it. Post-review changes from `201eb459` to `8c4cb17`, on top of the additions above:
  
  - `putMandateKeyWallet`'s `422` response is now `ProblemDetail` (was `HttpValidationErrorDetail`), so a malformed body or a failed possession-signature check now carries a `PAR-422-*` or `GEN-400-001` error code instead of FastAPI's bare validation-error shape.
  - `MandateKeyWalletShareResponse.encryption` is now typed `WalletShareEncryptionData`, a response-side counterpart to the existing request-side `WalletShareEncryption` (unchanged, still used on the bind request) — not a rename, the two schemas now coexist.
  - `MandateKeyWalletLinks` (the share response's `_links`) drops its own `share` field — the share link now lives solely on `MandateKeyLinks` above — and `wallet`'s doc clarifies binding is safe to repeat.
  - `MandateKeyActivationResponse.address` is documented checksummed, not lowercased.
  - No security-scheme changes between `201eb459` and `8c4cb17` (`bun run spec:diff-security` reports none); `sendSafeRpc` still gains `PintBearer` as an additional accepted auth scheme relative to this branch's original base, as already noted below.
  
  Every operation/schema change from the original base pin is still additive; nothing is removed or renamed at the operation level:
  
  - five operations: read/bind/read-share for the mandate key, the new `/v0/webhooks/para` embedded-wallet-provider webhook (`receiveParaWebhookEvent`), and reading a mandate ceremony's status
  - one existing operation (`sendSafeRpc`) gains `PintBearer` as an additional accepted auth scheme, alongside the two it already accepted
  - 11 net new schemas, including `MandateKeyActivationResponse`, `BindMandateKeyWalletRequest`, `MandateKeyLinks`, and `WalletShareEncryptionData`

- [#18](https://github.com/Sumvin/sdk-ts/pull/18) [`b92cde9`](https://github.com/Sumvin/sdk-ts/commit/b92cde917d629231b27bec9528895591fa2a49cf) Thanks [@3266miles](https://github.com/3266miles)! - Add `readScopeCeiling`, which reads the spend ceiling a PINT scope states, using the API's display-unit `max` convention.
  
  Every `max` is an amount of the currency or asset the scope names. `sr:us:pint:spend:visa_checkout?max=25&currency=USD` is $25.00, and `spend:x402?max=0.5&asset=USDC` is 0.5 USDC. Clients that render a signed ceiling should call this reader instead of parsing scope strings. Before this convention, checkout's `max` was read as minor units, which would now show a ceiling 100× too small.
  
  - Returns `{ kind: 'fiat', amount, currency, decimals }` or `{ kind: 'asset', amount, asset, symbol, decimals }`. `amount` is an exact decimal string. Returns `null` when the scope states no `max`.
  - Throws `ScopeCeilingError` (a `SumvinError`, detectable with `isScopeCeilingError`) with a `reason`. It never truncates an over-precise amount or guesses an unknown denomination's decimals.
  - The vendored OpenAPI spec is re-pinned to sumvin-api `4ced3079` and the generated client is regenerated from it. Every change is an addition; nothing is removed or renamed:
    - five operations: list and revoke agent identities, read and decide a mandate ceremony, and the Para wallet-claimed webhook
    - 13 schemas, including `MandateCeremonyResponse`, whose example uses a display-unit `visa_checkout?max=500.00&currency=USD`
    - no change to the security schemes

## 0.3.0

### Minor Changes

- [#16](https://github.com/Sumvin/sdk-ts/pull/16) [`d610056`](https://github.com/Sumvin/sdk-ts/commit/d610056f9825fdef7995de2b799b10f29adf7e92) Thanks [@3266miles](https://github.com/3266miles)! - Redirect refusal is now edge-safe. Every request this SDK builds previously carried
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

- [#14](https://github.com/Sumvin/sdk-ts/pull/14) [`a604e3b`](https://github.com/Sumvin/sdk-ts/commit/a604e3b154c6de732d279da8c2385405470358c3) Thanks [@3266miles](https://github.com/3266miles)! - This is a breaking release under the "0.x, honest minor-bump-on-break" convention — feedback
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

## 0.2.1

### Patch Changes

- [#12](https://github.com/Sumvin/sdk-ts/pull/12) [`08b2c1f`](https://github.com/Sumvin/sdk-ts/commit/08b2c1f0900d7be0c08142696ebe02eaa082c3f8) Thanks [@3266miles](https://github.com/3266miles)! - `src/signing`'s `coerceTypedDataIntegers` now guards two failure modes that could
  previously reach a signature silently or unhelpfully:
  
  - **`domain.chainId` normalization.** A server (or an intermediary re-serialising the
    JSON) that sends `domain.chainId` as an all-digit string now gets it normalised to a
    `Number` before signing, instead of being passed through untouched — the generated
    `Eip712Payload.domain.chainId` is typed `number`, but nothing on the wire guarantees
    that at runtime.
  - **Exact integer conversion.** An integer-typed field's value that cannot be converted
    to `BigInt` exactly — above `Number.MAX_SAFE_INTEGER`, fractional, or non-numeric — now
    throws the new, exported `TypedDataPrecisionError` (naming the offending field) instead
    of letting a bare `RangeError`/`SyntaxError` from `BigInt()` escape as an unnamed
    library error. `TypedDataPrecisionError` is exported from `@sumvin/sdk/signing`.

## 0.2.0

### Minor Changes

- [#10](https://github.com/Sumvin/sdk-ts/pull/10) [`91030a5`](https://github.com/Sumvin/sdk-ts/commit/91030a51d059c6230b4d3f1e13579fff5629d536) Thanks [@3266miles](https://github.com/3266miles)! - Adds a curated layer on top of the generated core, all available from the root
  `@sumvin/sdk` entry point via a single `createSumvinClient({ baseUrl, ... })`
  factory that returns the generated `Client` with this behaviour installed —
  every generated operation still takes `{ client }` exactly as before.
  
  - **Response-body contract validation, on by default.** A mismatch between what
    the server actually returns and what the spec promises is now reported (and,
    for a set of money/state-driving operations, fails the call closed) instead
    of silently reaching your code. Fully overridable per operation.
  - **One error type for every request failure.** RFC 7807 problems, other HTTP
    errors, and transport failures (network, abort, timeout) all normalize to a
    single `ApiError` — `isApiError()` narrows, `unwrap()` throws for call sites
    that want exceptions, `replayOutcome()` names an idempotent-replay result.
  - **Credential providers** (`junoJwt`, `sumvinPat`, `pintToken`) that compose
    additively, and a `deviceLogin()` helper that drives the CLI/device
    sign-in flow (create → poll with backoff → exchange) end to end.
  - **Every request now refuses to follow a redirect, including a same-origin
    one.** None of the 174 operations in the spec declares a 3xx response, so a
    redirect is treated as a failure (`ApiError` with `kind: 'redirect-refused'`)
    rather than followed transparently — this is what stops a credential header
    from silently reaching whatever origin a compromised or misconfigured API
    redirects to, and it isn't optional per-client today. If your deployment
    301s `http`→`https` or 307s a trailing slash in front of the API, point
    `baseUrl` at the URL that responds directly (no redirect in the way) —
    the previous "just follow it" behaviour no longer applies. This also adds
    `'redirect-refused'` to the `ApiErrorKind` union — a type-level change,
    not just a runtime one: an exhaustive `switch (error.kind)` you wrote
    against an earlier version of this package will stop compiling until you
    add a case (or a default) for it.
  - **HAL `_links` navigation** (`halOf(data).follow(client, rel)`) and
    cursor-following pagination, both routed through your configured client so
    they inherit its base URL, auth, and validation rather than hitting a bare
    `fetch`.
  - **Progression readers** for onboarding, KYC, and Safe-wallet creation that
    derive "what to show or do next" from server-reported capability facts
    instead of a locally-owned state machine.
  - **PINT signing ceremonies** (`mintPint`, `mintPintAsAgent`, `decideErrand`)
    that build the EIP-712 typed data, delegate signing to a function you
    supply (a viem wallet, a Safe SDK — this SDK never holds a key), and handle
    the nonce-race retry.
  - **Cache-invalidation groups** on `@sumvin/sdk/react`, built from the
    generated query-key functions so a renamed or removed operation is a build
    failure rather than a silently inert string filter.
  - An optional per-client request timeout (`timeoutMs`), off by default so
    existing behaviour is unchanged unless you opt in.
  
  See the README's Quickstarts for a complete web, CLI-tool, and agent example.

## 0.1.2

### Patch Changes

- [#6](https://github.com/Sumvin/sdk-ts/pull/6) [`9e6eb23`](https://github.com/Sumvin/sdk-ts/commit/9e6eb232ca139ab9c98cdc32ee3f7976015ddfad) Thanks [@3266miles](https://github.com/3266miles)! - No functional change to the published package. Release plumbing only: the release workflow is now split into gate/select/version/publish jobs so that `id-token: write` is held by the publishing step alone, and a new `bun run spec:drift` check detects upstream OpenAPI drift that the pinned-SHA freshness check structurally could not. This release exercises the split pipeline end to end.

## 0.1.1

### Patch Changes

- [#3](https://github.com/Sumvin/sdk-ts/pull/3) [`4f7ee80`](https://github.com/Sumvin/sdk-ts/commit/4f7ee800b8798a728744d1636fcc6dfce4e02cd2) Thanks [@3266miles](https://github.com/3266miles)! - No functional change. First release cut by the changesets pipeline, published from
  a merged Version Packages PR rather than a push to `main`.

## 0.1.0

### Minor Changes

- Initial release of `@sumvin/sdk`: generated core (types, fetch client, Zod schemas)
  from a SHA-pinned copy of the Sumvin API OpenAPI spec, plus the `react` and
  `signing` subpaths.
