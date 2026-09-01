# `@sumvin/sdk`

The TypeScript SDK for the Sumvin API. A **generated core** — types, fetch client, and Zod
schemas produced by [hey-api](https://heyapi.dev) from a SHA-pinned copy of the API's OpenAPI
spec — plus a thin **curated layer** that adds judgment on top.

```bash
bun add @sumvin/sdk      # npm / pnpm / yarn all fine
```

| Entry point | What's in it | Extra peers |
|---|---|---|
| `@sumvin/sdk` | Every API operation, its types, and its Zod schemas. Framework-free. | none — `zod` is the only runtime dependency |
| `@sumvin/sdk/react` | Generated TanStack Query artifacts | `react`, `@tanstack/react-query` |
| `@sumvin/sdk/signing` | EIP-712 typed-data construction for PINT purchase intents | `viem` (optional; currently unused) |
| `@sumvin/sdk/testing` | `fakeFetch`, the scripted transport this SDK's own tests run on. Test-only — never import it from production code | none |
| `@sumvin/sdk/generated/*` | Unbundled, one-file-per-module pass-through of everything under `src/generated/` (e.g. `@sumvin/sdk/generated/core/types.gen`, `@sumvin/sdk/generated/client`, `@sumvin/sdk/generated/client.gen`) | none |

ESM and CJS, with `.d.ts` and sourcemaps for click-through. Runs on Node ≥20, evergreen
browsers, and Bun. Edge runtimes (Cloudflare Workers) are a declared target this SDK does not
meet yet — see [Verified runtimes](#verified-runtimes) below for what's actually checked, per
runtime, and the specific defect blocking edge today.

## Quickstarts

Every consumer builds a client the same way — `createSumvinClient({ baseUrl, ... })` —
and gets back the *generated* `Client`, not a wrapper. Every generated operation still
takes `{ client }` exactly as it always did; `createSumvinClient` only installs curated
behaviour (auth headers, error normalization, response validation — on by default,
optional request timeout) on top of it.

### Web app

```tsx
import { createSumvinClient, junoJwt } from '@sumvin/sdk';
import { invalidateFamily, listWalletsOptions } from '@sumvin/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

// `junoJwt` is getter-first on purpose: a JWT is short-lived, and the app's own
// session store refreshes it independently of this SDK — a static string here
// would go stale the moment the app rotated its session token.
const client = createSumvinClient({
  baseUrl: 'https://api.sumvin.com',
  auth: [junoJwt(() => authStore.getState().jwt)],
});

function WalletsList() {
  const { data, isLoading } = useQuery(listWalletsOptions({ client }));
  const queryClient = useQueryClient();

  async function onWalletLinked() {
    // Refreshes every `wallets`-family query (list + detail + balances +
    // assets) built from the SAME generated `{op}QueryKey` builders the app's
    // own queries use — a renamed/removed operation is a build failure here,
    // never a silently-inert string filter.
    await invalidateFamily(queryClient, 'wallets');
  }

  if (isLoading) return <Spinner />;
  return <ul>{data?.wallets.map((w) => <li key={w.id}>{w.nickname}</li>)}</ul>;
}
```

### CLI tool

```ts
import { createSumvinClient, deviceLogin, sumvinPat } from '@sumvin/sdk';

// The `user-agent` header is REQUIRED, even for the unauthenticated sign-in
// client below — the API pins `x-sumvin-pat` auth to
// `CLI_ALLOWED_USER_AGENT_PREFIXES`, so a token minted by a client that never
// sent this header is unusable the moment you try to authenticate with it.
// `fetch` is injected too: a CLI runs across Node versions and proxy setups
// this SDK doesn't control, so it never assumes a particular global `fetch`.
const cliClient = createSumvinClient({
  baseUrl: 'https://api.sumvin.com',
  fetch,
  headers: { 'user-agent': `sumvin-cli/${cliVersion}` },
});

const credential = await deviceLogin({
  client: cliClient,
  onUserCode: (info) => {
    // The ONLY place the user ever sees the verification URL and short code —
    // fire this before any best-effort browser open, so a headless/SSH
    // session still gets a usable prompt.
    console.log(`Visit ${info.verificationUri} and enter ${info.userCode}`);
  },
});
await storeCredential(credential.token); // deviceLogin never persists it for you

// Every subsequent command authenticates with the minted PAT — same
// `fetch`/`user-agent`, now with `auth` added.
const client = createSumvinClient({
  baseUrl: 'https://api.sumvin.com',
  fetch,
  headers: { 'user-agent': `sumvin-cli/${cliVersion}` },
  auth: [sumvinPat(() => readStoredCredential())],
});
```

### Agent

```ts
import { createSumvinClient, pintToken, sumvinPat } from '@sumvin/sdk';
import { mintPint } from '@sumvin/sdk/signing';

// A PINT travels ALONGSIDE a base credential, never instead of it: the server
// resolves the caller from `x-sumvin-pat` (or `x-juno-jwt`) UNCONDITIONALLY
// before it ever reads `x-sumvin-pint-token` — a PINT only upgrades the
// resolved caller, it never substitutes for the base credential. A
// PINT-only client has every request refused with no base credential to
// resolve a caller from.
const client = createSumvinClient({
  baseUrl: 'https://api.sumvin.com',
  auth: [sumvinPat(process.env.SUMVIN_PAT), pintToken(() => currentPint?.token)],
});

// Mint the purchase-intent token the agent will present as `pintToken` above.
// `signTypedData` is YOUR wallet's own signer (a viem `WalletClient`, a Safe
// SDK, an EOA signer) — this SDK never holds a key, it only builds the
// EIP-712 struct and orchestrates the nonce-fetch-sign-exchange sequence.
const { data: pint, error } = await mintPint({
  client,
  wallet: safeAddress, // must be a Safe; the signing key must be a registered owner
  statement: 'Book a flight up to $450',
  scopes: ['sr:us:pint:card:checkout'],
  resources: [],
  maxAmount: '45000',
  maxAmountToken: '0x0000000000000000000000000000000000000000',
  expiresAt: Date.now() + 60 * 60 * 1000,
  chainId: 1329,
  signTypedData: (typedData) => walletClient.signTypedData({ account, ...typedData }),
});
if (error === undefined) {
  console.log(`Minted PINT ${pint.id}`); // `id` is the PINT URI
}
```

### Why `@sumvin/sdk/generated/*` exists

The three subpaths above (`.`, `./react`, `./signing`) are bundled: each is a small set of
shared chunks, not a 1:1 mirror of `src/`. That's the wrong shape for one specific consumer
need — TypeScript **module augmentation**, which only works against a module that resolves to
a real, individually addressable file, not a chunk folded into a bundle. A consumer that wants
to add its own field to `ClientMeta` (an empty interface at `src/generated/core/types.gen.ts`)
does so like this:

```ts
declare module '@sumvin/sdk/generated/core/types.gen' {
  interface ClientMeta {
    caller: string;
  }
}
```

and separately imports `createClient` / `createConfig` / `type Client` from
`@sumvin/sdk/generated/client` and the pre-built singleton from
`@sumvin/sdk/generated/client.gen` — two distinct modules that must stay distinct.

**The augmentation only reaches call sites that import from the same unbundled module.**
It does not reach the bundled `.` barrel: `@sumvin/sdk`'s declarations are rolled up, so
`ClientMeta` is inlined into the bundle rather than referenced, and declaration merging
cannot cross that boundary. Measured against a packed tarball — a bogus `meta` key is
rejected when imported from `@sumvin/sdk/generated/sdk.gen` (`TS2353`) and silently
accepted when imported from `@sumvin/sdk`. A consumer relying on the augmentation must
import the operation from `@sumvin/sdk/generated/*`, and must reference the augmented
module (`import type {} from '@sumvin/sdk/generated/core/types.gen'`) or TypeScript will
not load the declaration at all.

The `./generated/*` export is a **guarded wildcard**: it exposes exactly the `src/generated/`
tree (built unbundled, one output file per input file, via a second `tsdown.config.ts` entry
with `unbundle: true`) and nothing else in `dist/`. `./generated/client` has its own **exact**
entry ahead of the wildcard: the source module is `src/generated/client/index.ts` — a directory
index — so the wildcard's literal `*` substitution (`./generated/client` → `dist/generated/client.mjs`,
which does not exist) can't reach it; only `dist/generated/client/index.mjs` does. Node resolves
an exact `exports` key before a pattern key, so the two entries coexist safely. Do not delete
either export as apparently redundant with the barrels above, and do not fold the unbundled
build entry into the bundled ones: TypeScript module augmentation only works against an
individually addressable module, so folding them breaks every consumer that augments a
generated interface.

## Error handling

Every error family this SDK throws or returns — `ApiError`, `ContractDriftError`, `HalError`
(and its subclasses), `DeviceLoginError` (and its subclasses), and the `signing` errors
(`TypedDataPrecisionError`, `TypedDataSignError`, `TypedDataShapeError`) — extends
`SumvinError`. One guard catches all of them; two more tell the two you'll actually branch on
apart:

```ts
import { isApiError, isContractDriftError, isSumvinError, unwrap } from '@sumvin/sdk';

try {
  const budget = unwrap(await getBudget({ client, path: { budget_id } }));
  console.log(budget.name);
} catch (e) {
  if (!isSumvinError(e)) throw e; // not from this SDK — rethrow

  if (isApiError(e)) {
    console.error(e.kind, e.status, e.message);
  } else if (isContractDriftError(e)) {
    console.error(e.operationKey, e.reason);
  }
}
```

`isApiError` and `isContractDriftError` are deliberately disjoint — `isApiError` returns
`false` for a `ContractDriftError`, and vice versa. An `ApiError` is a **request** failure: the
server answered badly (an RFC 7807 problem, a bare HTTP error) or the transport itself failed
(network, abort, a refused redirect). A `ContractDriftError` is a **client-side validation**
failure on a response the server delivered just fine — a strict-tier operation's body didn't
match the shape the spec promised. Neither is a special case of the other, so `isSumvinError`
first, then narrow, is the only way to handle both without silently missing one.

**`message` is a developer diagnostic, not your copy.** `ApiError.message` — and every other
`SumvinError.message` — is a developer-facing string, and a reasonable last resort if you have
no message table of your own. It is not the field to key a user-facing message table off. A
consumer that owns one keys it off `errorCode` / `status` / `kind` / `problem` instead, never
off `message`. The concrete reason: this SDK composes its own generic string for an
unrecognized failure — literally `Sumvin is busy, please retry (HTTP 502).` for an unrecognized
5xx — which is a second, independent copy of whatever generic "something went wrong" string
your own table already has. Map from `message` and that copy silently becomes decorative the
moment either string changes, with nothing to signal it. sumvin-cli does this correctly:
`toCliErrorFromApiError` builds its `CliError` from `error.errorCode` / `error.status` /
`error.problem` only, falling back to a `kind`-derived title when there's no `errorCode` to look
up — `error.message` never enters its rendering.

**`ContractDriftError.value` and `.issues` are truncated, not redacted.** `.value` is a
truncated view of the response body that failed validation, capped at 2000 characters. Because
the cap is length-based, not field-aware, it can carry money amounts or PII from the mismatched
response verbatim. `.issues` (Zod's raw `safeParse` issues) carries the same caution — only
`invalid_type`'s `received` is guaranteed to be a type name, and other issue codes can echo real
data back. Both are fine for a developer console or an access-controlled server log; neither
should ever reach a rendered error envelope or an unredacted log sink.

**`hal.follow()` returns `unknown` by decision, not omission.** An arbitrary `rel` can't be
mapped back to a named, typed operation, so a more specific return type there would be a lie.
For a typed result, call the named generated operation for what `rel` points at, if one exists,
or use `hal.followValidated`, which parses the body against a schema you supply instead of
casting it:

```ts
import { halOf, zAssetPriceResponse } from '@sumvin/sdk';

const asset = await getAsset({ client, path: { symbol: 'eth' } });
const hal = halOf(asset.data!);

const price = await hal.followValidated(client, 'price', zAssetPriceResponse);
// price is typed from zAssetPriceResponse — parsed, not cast.
```

Relation lookup, template expansion, and the origin guard all run first, exactly as they do for
`follow()` — a missing relation or a refused href never reaches the schema. On a mismatch,
`followValidated` throws a `ContractDriftError` into the same funnel above, with `operationKey`
set to `` `FOLLOW ${rel}` ``, so a caller checking `isSumvinError` / `isContractDriftError` in
one place catches a followed link's drift the same way it catches a generated operation's.

## Testing against this SDK

`@sumvin/sdk/testing` publishes `fakeFetch` — the scripted transport this SDK's own tests run
on. It captures the outgoing `Request` and hands back a scripted `Response`, so auth headers,
validation tiers, error normalization and HAL following can all be exercised end to end with no
network and no mock library.

```ts
import { createSumvinClient } from '@sumvin/sdk';
import { fakeFetch } from '@sumvin/sdk/testing';

const f = fakeFetch([{ status: 422, body: problemDetail }]);
const client = createSumvinClient({ baseUrl: 'https://api.test', fetch: f.fetch });

const { error } = await getBudget({ client, path: { budget_id } });
expect(f.last().headers.get('x-sumvin-pat')).toBe('pat_test');
```

It is published because the alternative is every consumer writing their own approximation of
this SDK's transport, and the approximations get the security-relevant parts wrong. A
hand-built `new Response(...)` reports `redirected: false` and `url: ''` no matter what it is
modelling, so a test asserting that the redirect backstop fires passes whether or not that
backstop does anything at all. `FakeReply` therefore lets you script `redirected` and `url`
explicitly. Note that neither survives `Response.clone()` — see the type's own TSDoc.

Test-only. It is deliberately absent from the root barrel so an unqualified import cannot pull
it into a production bundle.

## Verified runtimes

The claim above ("Runs on Node ≥20, evergreen browsers, and Bun") is backed by a CI job per
runtime, not inferred from `engines` or from what merely compiles. Coverage differs by runtime —
this is the honest version of that claim:

| Runtime | What runs | Redirect-refusal detection (`kind: 'redirect-refused'`) |
|---|---|---|
| Bun 1.3.13 | Full suite, 350 tests | Asserted |
| Node 20 | Full suite, 350 tests | Asserted |
| Node 24 | Full suite, 350 tests | Asserted |
| Cloudflare Workers (workerd, via Miniflare) | 137 tests — a runtime-sensitive subset; excludes `src/auth/interceptor.test.ts`, `src/client.test.ts`, `src/validation/seam.test.ts`, `src/validation/naming-rule-coverage.test.ts`, and `src/errors/api-error.test.ts` | Not asserted |
| Headless Chromium (Playwright) | The same 137-test subset | Not asserted |

**Cloudflare Workers is a declared target this SDK does not meet today.**
`installAuthInterceptor` constructs every outgoing request with `redirect: 'error'`
(`src/auth/interceptor.ts:168`), and workerd rejects that value outright: `TypeError: Invalid
redirect value, must be one of "follow" or "manual"` — verified directly against a real workerd
isolate, not inferred from its docs. **Every request this SDK makes therefore throws on
Cloudflare Workers.** The edge CI job stays green only because its test subset excludes the one
file (`src/auth/interceptor.test.ts`) that would exercise this path — that green proves the
subset it covers, and says nothing about whether this SDK can make a request at all on that
runtime. Tracked as ENG-3486; until it's fixed, do not deploy this SDK to a Worker.

Of the five exclusions from the Cloudflare/Chromium subset, only `auth/interceptor.test.ts` is
the defect above. The other four are test-infrastructure limits, not gaps in the SDK itself:
`src/client.test.ts` and `src/validation/{seam,naming-rule-coverage}.test.ts` start a real
`node:http` server or read source files off disk, neither of which a Worker or a browser build
can do; `src/errors/api-error.test.ts` exercises a Node/Bun-console-specific hook
(`Symbol.for('nodejs.util.inspect.custom')`) that doesn't apply to either runtime.

Redirect-refusal (`kind: 'redirect-refused'`) is asserted only on Node and Bun, which each
expose a distinguishing signal on the underlying `fetch` rejection. It is asserted on neither
Cloudflare Workers nor a browser: a browser fetching the test server is cross-origin, so a CORS
failure and a genuine redirect refusal produce the identical opaque `TypeError` — asserting
anything there would pass for the wrong reason, not a real one.

## Two rules this repo runs on

**The generated tree is never hand-edited.** Everything under `src/generated/` is an artifact.
`bun run generate` must reproduce it byte-for-byte from the committed spec, and CI fails if it
doesn't. If the output is wrong, the spec or the generator config is wrong — fix it there.

**The spec is vendored at a commit SHA, never a branch.** `spec/openapi.json` is pinned by
`spec/PIN`, and re-pinning requires reading a security-block diff. See
[`spec/SOURCE.md`](spec/SOURCE.md) — in particular the part about `info.version` being useless
as a staleness signal. It has read `0.35.2` across specs whose route sets genuinely differ.

## Supersedes an earlier hand-written client

This repository replaces an earlier hand-written Sumvin client, whose surface last tracked the
API in April 2026 and drifted from it thereafter. Only its EIP-712 module survived the move,
and it lives at `src/signing/` now. Nothing else came across, and nothing depended on it — that
package was never published to npm.

## Two Node floors, not one

`package.json#engines.node` (`>=20`) is the floor for **consuming** this package. It is not
the floor for **generating** it. `@hey-api/openapi-ts`, the code
generator `bun run generate` shells out to, declares `"engines": { "node": ">=22.18.0" }` in its
own `package.json` (checked directly in `node_modules/@hey-api/openapi-ts/package.json`, not
taken from its migration notes — those say `22.13`, which is wrong for this install). Conflating
the two is how a wrong `engines` field ships: the generator's floor governs the machine that runs
`bun run generate` / CI's generation step; the published floor governs every consumer.

## Development

```bash
bun install
bun run spec:pull    # re-vendor the spec at the pinned SHA (needs `gh` auth)
bun run spec:check   # does the vendored copy still match the pinned SHA?
bun run spec:drift   # has the spec moved upstream since we pinned it?
bun run generate     # regenerate the client, then assert the output matches the config
bun run build        # ESM + CJS + declarations
bun run test
```

## Releasing

Releases run on [changesets](https://github.com/changesets/changesets). A PR that
changes anything a consumer can observe should carry a changeset:

```bash
bun run changeset    # pick a bump, write the changelog line
```

Commit the generated file in `.changeset/` alongside your change. PRs that cannot
reach the published package — CI wiring, internal docs, test-only edits — need
nothing.

On merge to `main`, the release workflow opens or updates a **Version Packages**
PR that consumes every pending changeset, bumps the version, and rewrites
`CHANGELOG.md`. Merging *that* PR is what publishes to npm, with provenance, via
[trusted publishing](https://docs.npmjs.com/trusted-publishers) — there is no npm
token anywhere in this repo. Nothing publishes without a merged PR, and no commit
message convention is load-bearing: the changeset files are the source of truth
for what the next version is.
