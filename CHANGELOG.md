# @sumvin/sdk

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
