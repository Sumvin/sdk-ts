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
| `@sumvin/sdk/generated/*` | Unbundled, one-file-per-module pass-through of everything under `src/generated/` (e.g. `@sumvin/sdk/generated/core/types.gen`, `@sumvin/sdk/generated/client`, `@sumvin/sdk/generated/client.gen`) | none |

ESM and CJS, with `.d.ts` and sourcemaps for click-through. Runs on Node ≥20, evergreen
browsers, Bun, and edge runtimes.

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
