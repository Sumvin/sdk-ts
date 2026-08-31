# @sumvin/sdk

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
