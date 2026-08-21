---
"@sumvin/sdk": patch
---

No functional change to the published package. Release plumbing only: the release workflow is now split into gate/select/version/publish jobs so that `id-token: write` is held by the publishing step alone, and a new `bun run spec:drift` check detects upstream OpenAPI drift that the pinned-SHA freshness check structurally could not. This release exercises the split pipeline end to end.
