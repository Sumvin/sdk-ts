/**
 * D9 — the real EIP-712 parity gate.
 *
 * sumvin-api's own parity test (`api/tests/contracts/test_eip712_client_parity.py`)
 * is a regex shape-check over a vendored copy of THIS SDK's own source — the
 * SDK is that fixture's source, not its consumer, and nothing on either side
 * is ever hashed or signed. There are no shared fixture vectors between the
 * two repos. So the acceptance criterion is re-cut here, in-repo and
 * numeric: compute the keccak256 type hash of our own `EIP712_TYPES` and
 * assert it equals the two constants sumvin-api pins at
 * `services/pint/eip712_types.py`. A single reordered or renamed field
 * changes the digest, so this catches exactly what matters — see the
 * mutation check below.
 *
 * `viem` is a devDependency used only here (and nowhere in the bundled
 * `src/signing` entry — see `index.ts`'s module doc), purely to compute
 * keccak256 for this test.
 */
import { keccak256, stringToBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { EIP712_TYPES } from './eip712.js';

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
 * The standard EIP-712 domain separator type. Not derived from anything
 * `src/signing` exports — `buildEip712TypedData`'s `domain` object carries
 * no parallel `types` entry describing itself (see `eip712.ts`) — so this is
 * named directly as the fixed, universal EIP712Domain field set our domain
 * object always populates: name, version, chainId, verifyingContract, in
 * that order. Mirrors `EIP712_DOMAIN_TYPE` in sumvin-api's `eip712_types.py`.
 */
const EIP712_DOMAIN_TYPE: readonly TypeField[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

// keccak256(PURCHASE_INTENT_TYPE_ENCODING) — pinned in sumvin-api's
// `services/pint/eip712_types.py`.
const PURCHASE_INTENT_TYPEHASH =
  '0x4425ea8354e100bfb443d54387ed8fa37732834de388d2393d99e0dbe52d9b8b';
// keccak256(DOMAIN_TYPE_ENCODING) — the standard EIP-712 domain separator
// type hash, also pinned there.
const DOMAIN_TYPEHASH = '0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f';

describe('EIP-712 type hashes match sumvin-api eip712_types.py', () => {
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

  it('EIP712Domain type hash matches DOMAIN_TYPEHASH', () => {
    const encoded = encodeType('EIP712Domain', EIP712_DOMAIN_TYPE);
    expect(keccak256(stringToBytes(encoded))).toBe(DOMAIN_TYPEHASH);
  });
});
