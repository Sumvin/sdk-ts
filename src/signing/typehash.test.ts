/**
 * The EIP-712 parity gate.
 *
 * Computes the keccak256 type hash of our own `EIP712_TYPES` and asserts it
 * equals the two published constants the API signs against. A single
 * reordered or renamed field changes the digest, so this catches exactly
 * what matters — see the mutation check below.
 *
 * A type hash covers only a struct's field NAMES and TYPES — never its
 * VALUES — so it is structurally blind to `DOMAIN_NAME`/`DOMAIN_VERSION`
 * drifting out of sync with the API's signed domain separator (a domain
 * separator is derived from the domain VALUES, not from `DOMAIN_TYPEHASH`). Those two constants are
 * pinned by value in `./eip712.test.ts` instead — this file's domain
 * coverage is the TYPE-HASH test only, proving the four domain field
 * names/types haven't drifted.
 *
 * `viem` is a devDependency used only here (and nowhere in the bundled
 * `src/signing` entry — see `index.ts`'s module doc), purely to compute
 * keccak256 for this test.
 */
import { keccak256, stringToBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { buildEip712TypedData, EIP712_TYPES, ZERO_ADDRESS } from './eip712.js';

interface TypeField {
  readonly name: string;
  readonly type: string;
}

/**
 * EIP-712's `encodeType`: `StructName(type1 name1,type2 name2,...)`. No
 * dependent-type suffixing here (PurchaseIntent and EIP712Domain reference
 * no nested struct types), so the full spec's recursive/sorted dependent-type
 * handling isn't needed — this is exactly what `keccak256` hashes for a
 * struct with no nested types.
 */
function encodeType(name: string, fields: ReadonlyArray<TypeField>): string {
  const params = fields.map((field) => `${field.type} ${field.name}`).join(',');
  return `${name}(${params})`;
}

/**
 * A sample typed-data payload from the module under test — used below to
 * derive the domain struct's field NAMES and ORDER from what
 * `buildEip712TypedData` actually emits, rather than a literal disconnected
 * from `src/`. (See the standalone `domainFieldTypes` map immediately below
 * for why the Solidity TYPE annotations still can't be derived the same
 * way: a JS runtime string is ambiguous between `string` and `address`.)
 */
const sampleTypedData = buildEip712TypedData({
  wallet: '0x1111111111111111111111111111111111111111',
  nonce: 1,
  statement: 'test',
  scopes: [],
  resources: [],
  conditions: [],
  maxAmount: '0',
  maxAmountToken: ZERO_ADDRESS,
  expiresAt: 0,
  chainId: 1,
});

/** The fixed, universal EIP-712 domain separator field types. */
const DOMAIN_FIELD_TYPES: Readonly<Record<string, string>> = {
  name: 'string',
  version: 'string',
  chainId: 'uint256',
  verifyingContract: 'address',
};

/**
 * The domain struct's field NAMES and ORDER are derived from
 * `buildEip712TypedData`'s own emitted `domain` object (`Object.keys`
 * preserves string-key insertion order), so a domain field being renamed,
 * reordered, added, or removed in `eip712.ts` changes this digest too — not
 * just a `PurchaseIntent` drift. Each name is looked up in
 * {@link DOMAIN_FIELD_TYPES}; an unrecognized field throws rather than
 * silently hashing `undefined`.
 */
const EIP712_DOMAIN_TYPE: readonly TypeField[] = Object.keys(sampleTypedData.domain).map((name) => {
  const type = DOMAIN_FIELD_TYPES[name];
  if (type === undefined) {
    throw new Error(
      `typehash.test.ts: no known EIP-712 type annotation for domain field "${name}" — add one to DOMAIN_FIELD_TYPES`,
    );
  }
  return { name, type };
});

// keccak256(PURCHASE_INTENT_TYPE_ENCODING) — the published PurchaseIntent type hash.
const PURCHASE_INTENT_TYPEHASH =
  '0x4425ea8354e100bfb443d54387ed8fa37732834de388d2393d99e0dbe52d9b8b';
// keccak256(DOMAIN_TYPE_ENCODING) — the standard EIP-712 domain separator
// type hash.
const DOMAIN_TYPEHASH = '0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f';

describe('EIP-712 type hashes match the published constants', () => {
  // When: this test goes red if a `PurchaseIntent` field is reordered,
  // renamed, retyped, added, or removed — every one of those changes the
  // type-string encoding and therefore the digest. Derived from the
  // exported `EIP712_TYPES`, never hardcoded, so a real drift in the source
  // this SDK signs against is what makes this fail, not a copy-pasted
  // string that could silently go stale alongside it.
  it('PurchaseIntent type hash matches PURCHASE_INTENT_TYPEHASH', () => {
    const encoded = encodeType('PurchaseIntent', EIP712_TYPES.PurchaseIntent);
    expect(encoded).toBe(
      'PurchaseIntent(address wallet,uint256 nonce,string statement,string[] scopes,string[] resources,string[] conditions,uint256 maxAmount,address maxAmountToken,uint256 expiresAt)',
    );
    expect(keccak256(stringToBytes(encoded))).toBe(PURCHASE_INTENT_TYPEHASH);
  });

  // When: this test goes red if `buildEip712TypedData`'s `domain` object
  // gains, loses, renames, or reorders a field — derived from what the
  // function actually emits (see `EIP712_DOMAIN_TYPE` above), not a literal
  // disconnected from `src/signing`. Before this fix, this half of the
  // gate was two fully independent literals hardcoded in this file that
  // nothing in `src/` ever touched — mutating `DOMAIN_VERSION` left it
  // green (verified: 2 passed after `DOMAIN_VERSION: '3' -> '4'`).
  it('EIP712Domain type hash matches DOMAIN_TYPEHASH', () => {
    const encoded = encodeType('EIP712Domain', EIP712_DOMAIN_TYPE);
    expect(keccak256(stringToBytes(encoded))).toBe(DOMAIN_TYPEHASH);
  });
});

// Note: DOMAIN_NAME/DOMAIN_VERSION VALUES (as opposed to the domain
// TYPE-HASH above, which only covers field names/types) are pinned in
// `./eip712.test.ts` — "DOMAIN_NAME matches Python constant",
// "DOMAIN_VERSION is '3'", and the domain.name/domain.version assertions in
// "returns correct structure with domain, types, primaryType, message".
// Mutation-checked identical: forcing DOMAIN_VERSION to drift, or
// de-linking buildEip712TypedData's emitted domain.version from the
// DOMAIN_VERSION constant, fails those tests exactly as it would have
// failed a same-shaped test here.
