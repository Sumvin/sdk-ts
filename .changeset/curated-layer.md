---
"@sumvin/sdk": minor
---

Adds a curated layer on top of the generated core, all available from the root
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
