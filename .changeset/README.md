# Changesets

This directory holds [changesets](https://github.com/changesets/changesets) — one
markdown file per user-visible change, each declaring the semver bump it needs and
the line it should contribute to the changelog.

Add one with `bun run changeset` when your PR changes anything a consumer can
observe. Skip it for changes that cannot reach the published package (CI wiring,
internal docs, test-only edits); the release workflow treats "no changesets" as
"nothing to release" and stays inert.

The release workflow opens and maintains a **Version Packages** pull request that
consumes every pending changeset here, bumps `package.json`, and rewrites
`CHANGELOG.md`. Merging that PR is what publishes to npm. Nothing is published
until it is merged, and merging it is the only thing that publishes.
