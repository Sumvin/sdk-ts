# Pattern vocabulary addendum — `validation` surface

Prefix: `V`. Seeded from ENG-3424 (the curated layer), reproduced and fixed
directly in this repo's history — not hypotheticals. See
`.claude/surfaces.yml` for the surface's registered paths. Per-class format
follows `socrates-core/reference/universal-classes.md`.

This surface exists because response validation here is a **money and state
gate**, not a developer nicety: a set of operations fail *closed* precisely
because a mis-parsed figure is indistinguishable from a real one downstream.

## V1 — A fail-closed check is installed on only one of the paths its
data can arrive by

**Shape:** a validator, guard, or sanitizer is wired into one branch of a
multi-branch decode/dispatch path — the JSON branch, the happy content-type,
the non-empty body — while the other branches return earlier, or later, and
never reach it. The gate is real and correct on the path it covers, and
absent everywhere else.

**Why it kills:** an attacker or a merely-broken server does not have to
defeat the check; it only has to arrive by a different door. When the check
is the thing standing between an unvalidated figure and arithmetic that
treats it as settled fact, a skipped branch is not "unvalidated" — it is
*silently valid*. The failure is strictly worse than having no gate, because
the tier's existence is what licensed the downstream code to trust the value.

**Concrete fingerprint (fixed in this repo — `src/validation/install.ts`):**
```ts
// VULNERABLE shape: the validator is only reachable on the json branch,
// so 204 / Content-Length: 0 / a non-JSON content-type return BEFORE it.
// A strict money operation then yields `{}` — and `data.remaining ?? 0`
// reads that as a real zero.
if (response.ok) {
  if (status === 204 || headers.get('Content-Length') === '0') return { data: {} }; // no check
  if (parseAs === 'json') await opts.responseValidator(data);                        // check
}

// FIXED shape this surface protects: the interceptor decides, for a strict
// operation, that an empty or non-JSON `ok` response is ITSELF a contract
// violation — before the decode path can return early past the validator.
if (tier === 'strict' && skipsResponseValidator(response, opts)) {
  throw new ContractDriftError({ reason: 'empty-or-non-json-response', ... });
}
```

**Where it usually lives:** response validators, request sanitizers, and
authorization checks installed on a single content-type/parse/dispatch
branch; anything registered as "the" validator for a client whose decode
path has early returns for 204, empty bodies, streams, or blobs.

**What "an instance" looks like:** the check + an enumeration of every branch
the decoded value can reach the caller by + a concrete response shape that
reaches the caller without passing the check.

**Typical severity:** High to Critical — blast depends on what the tier
gates (here: balances, spend limits, authorization state, and the payload a
user signs); detectability is silent by construction, since the bypass
produces a well-formed success rather than an error; trigger requires only
that a server, proxy, or CDN return an unexpected shape, which needs no
attacker at all.

**Check mode:** hybrid — grep locates the validator's installation site, but
enumerating the decode path's early returns requires reading the client or
framework that actually invokes it.

## V2 — A schema/handler registry is keyed by a name string derived from a
convention, so a rename keeps compiling and stops checking

**Shape:** a lookup that resolves a schema, validator, permission, or
handler by *constructing its name* — `` schemas[`z${pascal(operationId)}Response`] ``,
`getattr(module, f"validate_{name}")`, a string-prefix match — rather than
holding the resolved value itself in the registry.

**Why it kills:** the name is not type-checked against anything. When the
underlying symbol is renamed, removed, or regenerated under a different
convention, the lookup returns `undefined` and the code takes its
"nothing registered, carry on" branch. Nothing fails to compile; no test
that exercises a *different* operation goes red. A strict entry silently
degrades to unvalidated while the registry still lists it, so the map
continues to *document* a protection it no longer provides.

**Concrete fingerprint (rejected in this repo's design —
`src/validation/validated-operations.ts`):**
```ts
// VULNERABLE shape: keyed by a constructed name. Survives a rename.
const schema = generatedZod[`z${pascalCase(operationId)}Response`];
if (!schema) return; // silent downgrade

// FIXED shape this surface protects: the map holds the schema VALUE,
// imported. A renamed or removed operation is a TypeScript build failure.
import { zGetBudgetResponse } from '../generated/zod.gen.js';
export const VALIDATED_OPERATIONS = {
  'GET /v0/budgets/{budget_id}': zGetBudgetResponse,
} as const;
```

**Where it usually lives:** generated-artifact registries (schemas, query
keys, route handlers, permission maps) where a naming convention exists and
is tempting to exploit as a lookup mechanism; also dynamic dispatch by
`getattr`/`globals()`/index signature over a generated module.

**What "an instance" looks like:** the constructed-name lookup + its
not-found branch + confirmation that no build-time or test-time check
asserts the entry still resolves.

**Typical severity:** High — blast is the silent loss of whatever the
registry gated, scoped to the renamed entries; detectability is silent
(green build, green tests, fewer checks running); trigger is an ordinary
upstream rename or regeneration, i.e. routine maintenance rather than an
attack.

**Check mode:** deterministic — grep for template-literal or f-string
symbol construction indexing a module/registry namespace, especially one
whose contents are generated.

## V3 — Diagnostic telemetry carries the offending payload verbatim

**Shape:** a drift/violation/exception event includes the value that failed,
bounded by *size* rather than by *content*, and is handed to a
consumer-supplied sink (a logger, an error reporter, an analytics call).

**Why it kills:** the bound is the wrong axis. A 2000-character prefix of a
KYC document response, a card object, or a token-issuing response is still
PII or a credential; truncation only decides how much of it leaves. Because
the sink is consumer-supplied and the operation set is consumer-overridable,
neither the SDK author nor the SDK reviewer controls what ends up where.

**Concrete fingerprint (bounded, and documented, in this repo —
`src/validation/truncate-for-drift.ts`):**
```ts
// RISK shape: a size bound presented as a safety bound.
value: JSON.stringify(body).slice(0, 2000)
```

**Where it usually lives:** validation-failure telemetry, schema-mismatch
reporters, retry/circuit-breaker diagnostics, and any error type that
attaches "the value that caused this" for debuggability.

**What "an instance" looks like:** the event field carrying the payload + the
set of operations that can populate it + whether any of them return
credential- or PII-bearing bodies. Note that this set moves whenever the
operation map is overridden by a consumer, so "no credential-bearing
operation is in the map today" is a *current fact*, not a property.

**Typical severity:** Medium — blast is data exposure into whatever sink the
consumer wired, not code execution; detectability is silent; trigger is
ordinary operation, but reaching sensitive data requires the operation set
to include a sensitive response.

**Check mode:** hybrid — grep finds the payload-bearing field, but deciding
whether any reachable operation returns sensitive data requires walking the
schemas transitively.

## Summary

| ID | Class | Typical severity | Check mode |
|---|---|---|---|
| V1 | Fail-closed check installed on only one arrival path | High–Critical | hybrid |
| V2 | Registry keyed by constructed name; rename compiles, stops checking | High | deterministic |
| V3 | Violation telemetry carries the payload, bounded by size not content | Medium | hybrid |

Citations: ENG-3424 curated-layer PR. V1 is the strict-tier bypass found
independently by two verification passes and fixed in commit `2f1416c`
(plus its corrupt-JSON sibling, `unparsable-json-response`); V2 is the
design alternative rejected in decision D4 after the app's own
`response-schemas.ts` header named the failure; V3 is documented on
`ContractDriftEvent` rather than fixed, since the payload is the point of
the event.
