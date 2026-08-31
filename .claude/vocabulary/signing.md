# Pattern vocabulary addendum — `signing` surface

Prefix: `S`. Seeded from ENG-3424 (the curated layer) and the PINT/mandate
incidents it inherited, all reproduced in this estate — not hypotheticals.
See `.claude/surfaces.yml` for the surface's registered paths. Per-class
format follows `socrates-core/reference/universal-classes.md`.

This surface signs **authorization payloads that move money**. A signature
is a commitment to exact bytes: anything that changes what was hashed, or
lets a signature be produced over something other than what the server will
verify, is a correctness *and* an authorization failure at once.

## S1 — A cross-implementation parity gate asserts a constant against
another constant, so nothing under test participates

**Shape:** a test that claims to pin one implementation against another
compares two literals that both live in the test file (or both in the same
module), rather than deriving one side from the code under test. It passes
forever, including after the code it "pins" has drifted.

**Why it kills:** the whole value of a parity gate is that it fails when the
two sides diverge. If neither side is computed from the implementation, the
gate is a tautology wearing the costume of a contract — and it is *load
bearing in reviewers' minds*, so its presence actively suppresses the
scrutiny that would have caught the drift.

**Concrete fingerprint (found and fixed in this repo —
`src/signing/typehash.test.ts`):**
```ts
// VULNERABLE shape: both sides are literals in the test.
// Mutating DOMAIN_VERSION '3' -> '4' in the SOURCE left this GREEN.
const EIP712_DOMAIN_TYPE = [{ name: 'version', type: 'string' }, ...]; // literal
expect(keccak256(encodeType('EIP712Domain', EIP712_DOMAIN_TYPE))).toBe(DOMAIN_TYPEHASH);

// FIXED shape this surface protects: derive from what the module emits,
// and assert the VALUES too — a type hash covers field names and types,
// never struct values, so it can never catch a version bump on its own.
const { domain } = buildEip712TypedData({ ... });
expect(domain.version).toBe(BACKEND_PINNED_DOMAIN_VERSION);
```

**Where it usually lives:** cross-repo contract tests, golden/typehash
vectors, "our constant matches theirs" assertions, and any test whose
expected value was pasted from the implementation rather than computed
independently of it.

**What "an instance" looks like:** the assertion + which side is derived
from the code under test + a mutation of the source that the test does *not*
catch. If no such mutation exists, the gate is real.

**Typical severity:** High — blast is undetected divergence in exactly the
constant the gate existed to protect (here: a domain separator, so every
signature produced becomes unverifiable by the counterparty); detectability
is silent and self-reinforcing; trigger is any ordinary change to the pinned
value.

**Check mode:** hybrid — grep finds the assertion, but establishing whether
either operand traces to the implementation requires reading the test's
imports, and confirming it requires actually running a mutation.

## S2 — Data that is cryptographic truth is normalized on its way into the
signature

**Shape:** a sort, dedupe, trim, case-fold, empty-string filter, key
reordering, or integer re-encoding applied to a payload — or to part of one
— that is about to be hashed and signed, or that has already been signed by
a counterparty.

**Why it kills:** the signature commits to bytes. Any normalization the
signer applies that the verifier does not (or vice versa) produces a digest
mismatch, and the failure surfaces far from its cause — as a signature that
"just doesn't verify," or worse, as a signature that verifies over a
*different* authorization than the user actually approved. For a scope or
resource list this is directly a privilege question: a dedupe or a sort
changes what was authorized.

**Concrete fingerprint (guarded in this repo — `src/signing/coerce.ts`):**
```ts
// VULNERABLE shape: tidying a list on the way in.
message.scopes = [...new Set(scopes)].sort();

// FIXED shape this surface protects: integers are coerced by DECLARED
// TYPE only; arrays pass through with order, length and membership intact.
// Canon LBD 2026-JUL-14: PINT scopes/resources are the sole cryptographic
// truth, byte-for-byte — no sort, dedupe, case-fold, trim, or empty filter.
```

**Where it usually lives:** any adapter between a server-prepared payload
and a wallet/HSM signing call; "cleanup" helpers applied to request bodies
that are also signed; serializers that reorder object keys.

**What "an instance" looks like:** the transformation + proof the same
transformation is (or is not) applied on the verifying side + a payload
whose signed digest differs before and after.

**Typical severity:** Critical — blast is either a wholesale inability to
authorize, or an authorization over something other than what was shown to
the user; detectability is poor (a mismatch looks like a bad key or a bad
nonce); trigger is routine, since normalization is usually added as a tidy-up
by someone who does not know the value is signed.

**Check mode:** hybrid — grep finds `.sort(`/`new Set(`/`.trim(`/
`toLowerCase(` near a signing call, but deciding whether the verifier
matches requires reading the counterparty.

## S3 — A signing ceremony is aimed at a verifier that cannot accept it

**Shape:** client code constructs and signs a payload for an endpoint whose
server-side verification cannot succeed for that signer — a units mismatch
between the signed field and the validated one, a recovery model the signer
type cannot satisfy, or an endpoint that was left behind when its siblings
were migrated to a new verification doctrine.

**Why it kills:** the client is correct in isolation and the server is
correct in isolation; only the pairing is impossible. Nothing fails at
build time, unit tests on either side pass, and the defect surfaces as a
100%-failure rate on a path that may be dormant for months. Two live
instances in this estate: a mandate expiry sent in **seconds** against an
API validating **milliseconds** (every mint born expired, and — worse under
local signing — the signed struct and the request body must be one value, or
the signature covers something the server never hashes); and an agent-signed
mint asserting `recovered_address == claimed_wallet` where the claimed
wallet is a Safe, which ECDSA recovery can never return.

**Concrete fingerprint (avoided in this repo — `src/signing/mint-pint.ts`):**
```ts
// VULNERABLE shape: PATCH /v0/pint/{pint_id} still calls the pre-migration
// verifier unconditionally, so a Safe-walleted PINT always 401s. The
// backend's own HAL link builder advertises it for every pending pint,
// so FOLLOWING THE LINK is the trap.

// FIXED shape this surface protects: target the endpoint whose verifier
// names the signer rather than recovering the Safe, and treat the
// server-signs mode as what it is — a POST with no signature at all.
```

**Where it usually lives:** any client ceremony against an endpoint that has
more than one verification doctrine, or whose siblings were migrated; also
any signed field carrying a unit (timestamps, amounts, decimals).

**What "an instance" looks like:** the ceremony + the specific verifier
branch the server will actually run for this signer/payload + evidence it
can succeed. A passing unit test on the client alone is not that evidence.

**Typical severity:** High — blast is a fully non-functional authorization
path, sometimes dormant until a feature goes live; detectability is poor
before deployment and obvious after; trigger is any migration that moves one
call site and not its siblings.

**Check mode:** hybrid — requires reading the server's verification branch
for the exact endpoint and signer type; no grep on the client alone can
settle it.

## Summary

| ID | Class | Typical severity | Check mode |
|---|---|---|---|
| S1 | Parity gate compares constant to constant; nothing under test participates | High | hybrid |
| S2 | Cryptographic-truth data normalized on the way into the signature | Critical | hybrid |
| S3 | Ceremony aimed at a verifier that cannot accept it (units, recovery model, unmigrated endpoint) | High | hybrid |

Citations: ENG-3424 curated-layer PR. S1 is the inert domain half of the D9
parity gate, caught by a re-verification pass and fixed in commit `2ce3f7b`;
S2 is Socrates Canon LBD 2026-JUL-14, enforced by `coerce.ts`'s
byte-preservation tests; S3 draws on the 2026-AUG-11 seconds-vs-milliseconds
and agent-signed-mint findings (both since fixed upstream in DEVREL-31) and
on the `PATCH /v0/pint/{pint_id}` route that migration left behind, filed
separately against sumvin-api.
