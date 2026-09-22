# Vendored spec provenance

`spec/openapi.json` is a SHA-pinned vendor copy of `sumvin-api`'s published OpenAPI
document. It is generated, not hand-edited. Re-vendor with `bun run spec:pull`;
verify freshness with `bun run spec:check`.

| Field | Value |
|---|---|
| Source repo | `sibylline-advisory/sumvin-api` |
| Source path | `docs/api-reference/openapi.json` |
| **Pinned commit SHA** | see `spec/PIN` (single source of truth — every script reads that file, nothing else) |
| Pinned commit SHA (as of this doc) | `201eb459a377cb9a44160566abd4b2f0de050296` |
| Vendored on | 2026-09-22 |
| Spec `info.version` at pin | `0.41.2` |
| Operations | 184 (0 missing `operationId`) |
| Schemas | 412 |

## ⚠️ `info.version` is not a staleness signal

Do not use the spec's `info.version` field to decide whether `spec/openapi.json`
is current. It is a hand-bumped string that does not track content: three specs
observed across the fleet on 2026-08-21 all self-reported `0.35.2` while
differing materially underneath it — 171 / 174 / 174 operations, and 169 / 172 / 0
FastAPI-mangled `operationId`s. The only trustworthy staleness signal is the
**commit SHA** the spec was fetched at (`spec/PIN`). Neither check looks at
`info.version`.

Two checks, two different questions — do not conflate them:

| Command | Question | Determinism | Role |
|---|---|---|---|
| `bun run spec:check` | Does `spec/openapi.json` still match what the **pinned SHA** holds? | Deterministic — pinned content is immutable | Required PR status check |
| `bun run spec:drift` | Has the spec **moved upstream** since we pinned it? | Reads live upstream state; the answer changes underneath you | Weekly cron + `workflow_dispatch` only, never required |

`spec:check` compares against immutable content, so it structurally cannot
notice that `sumvin-api` has moved on — that is `spec:drift`'s job, and it
compares `spec/PIN` against the latest commit on the source repo's default
branch that touched the spec path (path-scoped deliberately: unrelated commits
to `sumvin-api` are not spec drift). `spec:drift` distinguishes three outcomes,
because the middle one is real: the pin is current; the pin is behind but the
spec bytes are identical (a reformat, a revert, a merge restoring prior
content — a re-pin is a free no-op); or the spec genuinely changed, which fails
and prints the re-pin sequence.

## Security schemes

Four `apiKey`-in-header schemes, each carrying a distinct header. A scheme
appearing, disappearing, or having its header `name` move is exactly what
`bun run spec:diff-security` exists to catch on every re-pin.

| Scheme | Header | Purpose |
|---|---|---|
| `JunoJWT` | `x-juno-jwt` | JWT issued by Dynamic Labs or Privy — sent on every authenticated request |
| `SumvinPAT` | `x-sumvin-pat` | Personal access token issued to the Sumvin CLI |
| `PintBearer` | `x-sumvin-pint-token` | Purchase Intent token — scoped, user-level consent for a specific action |
| `UcpToken` | `x-sumvin-ucp-token` | Org-scoped key for the UCP Merchant Search endpoints |

## Fetch mechanism: the raw `Accept` header is mandatory, not a preference

`sumvin-api` is a private repository, so `raw.githubusercontent.com` 404s — the
only SHA-pinned fetch path is the GitHub Contents API:

```bash
gh api "repos/sibylline-advisory/sumvin-api/contents/docs/api-reference/openapi.json?ref=<PIN>" \
  -H "Accept: application/vnd.github.raw"
```

The `Accept: application/vnd.github.raw` header is **load-bearing**, not a style
choice. The spec blob is 1,333,669 bytes — past GitHub's 1 MB inline-content
limit for the Contents API's default (JSON-wrapped, base64) response form. Omit
the raw header and the API answers **HTTP 200** with:

```json
{"size": 1333669, "encoding": "none", "content": ""}
```

An empty spec, at a success status. A future maintainer "simplifying" the fetch
by dropping the header would silently vendor nothing and every consumer of
`spec/openapi.json` would fail downstream, far from this file. `scripts/lib/spec-source.ts`
structurally validates the fetched payload (`openapi` string, `paths` object,
`components.schemas` object present) before anything trusts it, which catches
this specific failure — but the header is the fix, the validator is the backstop.

## Normalisation

`spec/openapi.json` is normalised with `jq .` before being written, so re-pins
produce minimal diffs and so `bun run spec:check` can byte-compare a fresh fetch
against the committed file. This is not cosmetic: the raw payload contains 2,210
`\u`-escaped characters that `jq` decodes to real UTF-8, so raw bytes
(1,333,669) and normalised bytes (1,327,037) differ even when the content is
semantically identical. `scripts/lib/spec-source.ts` exports one
`normalizeWithJq` function that both `scripts/pull-spec.ts` (writes the
normalised form) and `scripts/check-spec-fresh.ts` (compares against the
normalised form) import — comparing a raw fetch against a normalised vendored
file fails every time, so both sides must go through the same function rather
than each re-implementing it.

## Single source of truth for the pin

`spec/PIN` is a single line holding the 40-character commit SHA. `pull-spec.ts`,
`check-spec-fresh.ts`, and any future script that needs the pin all read this one
file. This is deliberate: the old Sumvin CLI hand-synced a SHA across two files
with no shared source, which is exactly the failure mode this file's existence
prevents.
