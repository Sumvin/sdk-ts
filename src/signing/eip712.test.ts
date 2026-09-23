import { describe, expect, it } from 'vitest';
import {
  buildEip712TypedData,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  EIP712_TYPES,
  ZERO_ADDRESS,
} from './eip712.js';

describe('EIP-712 constants', () => {
  it('DOMAIN_NAME matches Python constant', () => {
    expect(DOMAIN_NAME).toBe('Sumvin Purchase Intent');
  });

  // Bumped 2 -> 3 alongside `conditions` entering the PurchaseIntent type. The
  // domain version is part of the signed digest, so a stale signer cannot have
  // its signature silently accepted against the new payload shape.
  it("DOMAIN_VERSION is '3'", () => {
    expect(DOMAIN_VERSION).toBe('3');
  });

  // There is deliberately no DEFAULT_CHAIN_ID. A default chain silently signs
  // against the wrong domain separator when the caller forgets to pass one, and
  // the resulting signature is rejected. chainId is required.
  it('exposes no default chain id', async () => {
    const mod = await import('./eip712.js');
    expect(mod).not.toHaveProperty('DEFAULT_CHAIN_ID');
  });

  it('PurchaseIntent type has 9 fields in the exact published order', () => {
    // Field ORDER is part of the type hash — a transposition changes the digest. Compare the
    // whole array so a reorder fails, not just a membership check.
    expect(EIP712_TYPES.PurchaseIntent).toEqual([
      { name: 'wallet', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'statement', type: 'string' },
      { name: 'scopes', type: 'string[]' },
      { name: 'resources', type: 'string[]' },
      { name: 'conditions', type: 'string[]' },
      { name: 'maxAmount', type: 'uint256' },
      { name: 'maxAmountToken', type: 'address' },
      { name: 'expiresAt', type: 'uint256' },
    ]);
  });
});

describe('buildEip712TypedData', () => {
  const baseParams = {
    wallet: '0x1234567890abcdef1234567890abcdef12345678',
    nonce: 42,
    statement: 'Test statement',
    scopes: ['read', 'write'],
    resources: ['resource:1'],
    conditions: ['price < 100'],
    maxAmount: '1000',
    // ZERO_ADDRESS here means "native asset", not "unset domain". Unrelated to
    // verifyingContract — do not conflate the two.
    maxAmountToken: ZERO_ADDRESS,
    expiresAt: 1700000000,
    chainId: 1329,
  };

  it('returns correct structure with domain, types, primaryType, message', () => {
    const result = buildEip712TypedData(baseParams);

    expect(result.domain).toBeDefined();
    expect(result.types).toBeDefined();
    expect(result.primaryType).toBe('PurchaseIntent');
    expect(result.message).toBeDefined();

    expect(result.domain.name).toBe(DOMAIN_NAME);
    expect(result.domain.version).toBe(DOMAIN_VERSION);

    expect(result.message.wallet).toBe(baseParams.wallet);
    expect(result.message.nonce).toBe(baseParams.nonce);
    expect(result.message.statement).toBe(baseParams.statement);
    expect(result.message.scopes).toEqual(baseParams.scopes);
    expect(result.message.resources).toEqual(baseParams.resources);
    expect(result.message.conditions).toEqual(baseParams.conditions);
    expect(result.message.maxAmount).toBe(baseParams.maxAmount);
    expect(result.message.maxAmountToken).toBe(baseParams.maxAmountToken);
    expect(result.message.expiresAt).toBe(baseParams.expiresAt);
  });

  // verifyingContract must be the signing wallet. A ZERO_ADDRESS
  // verifyingContract produces a digest the API rejects — every signature
  // fails, not just conditions-bearing ones.
  it('binds verifyingContract to the signing wallet, never the zero address', () => {
    const result = buildEip712TypedData(baseParams);
    expect(result.domain.verifyingContract).toBe(baseParams.wallet);
    expect(result.domain.verifyingContract).not.toBe(ZERO_ADDRESS);
  });

  it('uses the caller-supplied chainId verbatim', () => {
    expect(buildEip712TypedData({ ...baseParams, chainId: 137 }).domain.chainId).toBe(137);
    expect(buildEip712TypedData({ ...baseParams, chainId: 1329 }).domain.chainId).toBe(1329);
  });

  // `conditions` are signed exactly as given. Any normalisation here changes
  // the digest away from what the API expects.
  it('passes conditions through verbatim — no sort, no dedup', () => {
    const messy = ['z-last', 'a-first', 'z-last', 'm-middle'];
    const result = buildEip712TypedData({ ...baseParams, conditions: messy });

    expect(result.message.conditions).toEqual(messy);
    // Explicitly pin the two normalisations that would silently break the signature.
    expect(result.message.conditions).not.toEqual([...messy].sort());
    expect(result.message.conditions).toHaveLength(4);
  });

  it('carries an empty conditions array rather than omitting the field', () => {
    const result = buildEip712TypedData({ ...baseParams, conditions: [] });
    expect(result.message.conditions).toEqual([]);
    expect(Object.keys(result.message)).toContain('conditions');
  });

  it('passes expiresAt through directly', () => {
    const result = buildEip712TypedData({ ...baseParams, expiresAt: 9999999999 });
    expect(result.message.expiresAt).toBe(9999999999);
  });

  // expiresAt is epoch MILLISECONDS. A seconds value would read as 1970 and the
  // payload would be born expired, so the unit is pinned rather than assumed.
  it('carries expiresAt as epoch milliseconds', () => {
    const expiresAtMs = 1_900_000_000_000;
    const result = buildEip712TypedData({ ...baseParams, expiresAt: expiresAtMs });
    expect(result.message.expiresAt).toBe(expiresAtMs);
    expect(new Date(result.message.expiresAt).getUTCFullYear()).toBe(2030);
  });
});

// ---------------------------------------------------------------------------
// Byte-preservation tests.
//
// PINT scopes/resources arrays are the sole cryptographic truth — byte-for-byte
// JSON, never normalized. `scopes`, `resources`, and `conditions` are hashed
// verbatim into the EIP-712 typed data on the wire; any client-side sort, dedupe,
// case-fold, trim, or empty-string filter changes what gets hashed away from what
// the API expects, and the signature silently fails to authorize — not a crash,
// an unnoticed authorization failure.
//
// This is the invariant a well-meaning refactor is most likely to break, so it
// gets explicit adversarial tests rather than being taken on faith.
// ---------------------------------------------------------------------------
describe('scopes/resources/conditions are byte-for-byte, never normalized', () => {
  const canonBase = {
    wallet: '0x1234567890abcdef1234567890abcdef12345678',
    nonce: 1,
    statement: 'canon check',
    maxAmount: '1',
    maxAmountToken: ZERO_ADDRESS,
    expiresAt: 1700000000000,
    chainId: 1329,
  };

  // Order that would visibly change under a lexicographic sort, plus duplicates,
  // unicode, empty strings, and leading/trailing whitespace/mixed case — every
  // normalisation this test forbids would perturb at least one of these entries.
  const adversarial = [
    'z-last',
    'a-first',
    'z-last',
    '',
    '  padded  ',
    'MixedCase',
    'mixedcase',
    'ünïcödé:scope',
    '🔥emoji-scope',
    'a-first',
  ];

  it('preserves scopes byte-for-byte: order, duplicates, case, whitespace, unicode, empties', () => {
    const result = buildEip712TypedData({
      ...canonBase,
      scopes: adversarial,
      resources: [],
      conditions: [],
    });
    expect(result.message.scopes).toEqual(adversarial);
    expect(result.message.scopes).toStrictEqual(adversarial);
    expect(result.message.scopes).toHaveLength(adversarial.length);
    // Pin the specific normalisations Canon forbids: none of these transforms of
    // the input should equal what came out, because none should have been applied.
    expect(result.message.scopes).not.toEqual([...adversarial].sort());
    expect(result.message.scopes).not.toEqual([...new Set(adversarial)]);
    expect(result.message.scopes).not.toEqual(adversarial.map((s) => s.toLowerCase()));
    expect(result.message.scopes).not.toEqual(adversarial.map((s) => s.trim()));
    expect(result.message.scopes).not.toEqual(adversarial.filter((s) => s !== ''));
  });

  it('preserves resources byte-for-byte: order, duplicates, case, whitespace, unicode, empties', () => {
    const result = buildEip712TypedData({
      ...canonBase,
      scopes: [],
      resources: adversarial,
      conditions: [],
    });
    expect(result.message.resources).toEqual(adversarial);
    expect(result.message.resources).toStrictEqual(adversarial);
    expect(result.message.resources).toHaveLength(adversarial.length);
    expect(result.message.resources).not.toEqual([...adversarial].sort());
    expect(result.message.resources).not.toEqual([...new Set(adversarial)]);
    expect(result.message.resources).not.toEqual(adversarial.map((s) => s.toLowerCase()));
    expect(result.message.resources).not.toEqual(adversarial.map((s) => s.trim()));
    expect(result.message.resources).not.toEqual(adversarial.filter((s) => s !== ''));
  });

  it('preserves conditions byte-for-byte: order, duplicates, case, whitespace, unicode, empties', () => {
    const result = buildEip712TypedData({
      ...canonBase,
      scopes: [],
      resources: [],
      conditions: adversarial,
    });
    expect(result.message.conditions).toEqual(adversarial);
    expect(result.message.conditions).toStrictEqual(adversarial);
    expect(result.message.conditions).toHaveLength(adversarial.length);
    expect(result.message.conditions).not.toEqual([...adversarial].sort());
    expect(result.message.conditions).not.toEqual([...new Set(adversarial)]);
    expect(result.message.conditions).not.toEqual(adversarial.map((s) => s.toLowerCase()));
    expect(result.message.conditions).not.toEqual(adversarial.map((s) => s.trim()));
    expect(result.message.conditions).not.toEqual(adversarial.filter((s) => s !== ''));
  });

  it('preserves all three arrays simultaneously, referentially distinct inputs', () => {
    // A shared implementation bug (e.g. one normalisation helper applied to all
    // three fields) would only be caught by exercising them together.
    const scopes = ['b', 'a', 'b', ' a '];
    const resources = ['Res:2', 'res:2', 'Res:1', ''];
    const conditions = ['price < 100', 'price < 100', '  qty > 0  '];
    const result = buildEip712TypedData({ ...canonBase, scopes, resources, conditions });
    expect(result.message.scopes).toEqual(scopes);
    expect(result.message.resources).toEqual(resources);
    expect(result.message.conditions).toEqual(conditions);
  });
});
