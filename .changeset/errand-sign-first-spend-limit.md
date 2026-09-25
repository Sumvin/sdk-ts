---
"@sumvin/sdk": minor
---

Regenerate the client from sumvin-api's sign-first errand contract. An errand is now signed before anything is searched for, so `createIpa` must carry a spend limit, and a match found within the signed bounds is bought without asking the owner again.

- `createIpa` (`POST /v0/user/ipa/`) now refuses an errand with no spend limit its owner could sign. Send `constraints.max_total` (or `max_price`) plus `constraints.currency`, in a supported currency and exact in its minor units. Without one, the call gets a `422` `ProblemDetail` with `IPA-422-003`, and nothing is created. The request *type* is unchanged, because both fields were already on `IpaConstraint`. The requirement lives in the server and in the field descriptions.
- An errand in `pending_approval` has no manifest yet: `manifest_summary` is `null` until the owner has signed and search has run.
- `ManifestSummaryData` gains an optional `items` list (`ManifestSummaryItem`).
- New operation `updateAgentIdentity` (`PATCH /v0/agent-identities/{external_id}`) renames a connected agent. `AgentIdentityData` gains `label`, `harness`, `harness_source` and `origin_host`.
- New `ApiErrorCode` members:
  - `IPA-422-003` (spend limit required)
  - `AID-400-001`
  - `SYS-503-001`
  - `SYS-503-002`
  - `WAL-409-003-R`
- Six upload and download operations now declare a `503` `ProblemDetail`: profile picture, receipt and chat attachment.
- **Breaking type change:** the spec now emits a single `ConditionGroup` schema in place of `ConditionGroup-Input` / `ConditionGroup-Output`.
  - The generated `ConditionGroupInput` / `ConditionGroupOutput` types are replaced by `ConditionGroup`.
  - `zConditionGroupInput` / `zConditionGroupOutput` are replaced by `zConditionGroup`.
  - Import `ConditionGroup` / `zConditionGroup` instead.
- No security-scheme changes (`bun run spec:diff-security` reports none).
