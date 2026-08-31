import { describe, expect, it } from 'vitest';
import type { Eip712Payload } from '../generated/types.gen.js';
import { SERVER_PREPARED_APPROVAL_PAYLOAD } from './coerce.fixtures.js';
import { coerceTypedDataIntegers } from './coerce.js';
import { TypedDataPrecisionError } from './errors.js';

describe('coerceTypedDataIntegers — integer coercion', () => {
  it('coerces every uint256-typed scalar field to BigInt', () => {
    const result = coerceTypedDataIntegers(SERVER_PREPARED_APPROVAL_PAYLOAD);

    expect(result.message.nonce).toBe(7n);
    expect(result.message.maxAmount).toBe(45000n);
    expect(result.message.expiresAt).toBe(1_735_689_600_000n);
    expect(typeof result.message.nonce).toBe('bigint');
    expect(typeof result.message.maxAmount).toBe('bigint');
    expect(typeof result.message.expiresAt).toBe('bigint');
  });

  it('leaves address- and string-typed fields untouched', () => {
    const result = coerceTypedDataIntegers(SERVER_PREPARED_APPROVAL_PAYLOAD);

    expect(result.message.wallet).toBe(SERVER_PREPARED_APPROVAL_PAYLOAD.message.wallet);
    expect(result.message.maxAmountToken).toBe(
      SERVER_PREPARED_APPROVAL_PAYLOAD.message.maxAmountToken,
    );
    expect(result.message.statement).toBe(SERVER_PREPARED_APPROVAL_PAYLOAD.message.statement);
    expect(typeof result.message.wallet).toBe('string');
  });

  // When: this test goes red if a numeric-string uint256 value is left as a
  // string instead of coerced — the exact shape a JSON-encoded server
  // payload uses when the value would otherwise lose precision as a number.
  it('coerces a numeric-string uint256 value the same as a numeric one', () => {
    // The generated type says `maxAmount: number`, but the wire may in
    // practice send a numeric string (the safer encoding for a value that
    // could exceed Number.MAX_SAFE_INTEGER) — coercion must accept both.
    // `unknown` bridges the deliberate mismatch instead of `any`.
    const payload = {
      ...SERVER_PREPARED_APPROVAL_PAYLOAD,
      message: {
        ...SERVER_PREPARED_APPROVAL_PAYLOAD.message,
        maxAmount: '45000',
      },
    } as unknown as Eip712Payload;
    const result = coerceTypedDataIntegers(payload);
    expect(result.message.maxAmount).toBe(45000n);
  });

  // When: this test goes red if a nested struct's own integer fields (and
  // integer-array fields) stop being coerced — the recursion this function
  // ports exists for exactly this case, even though no PurchaseIntent field
  // nests today.
  it('recurses into a nested struct type, including a nested uint256[]', () => {
    // Synthetic: no PurchaseIntent field nests, so this shape isn't
    // representable by the generated `Eip712Payload` type (its `message` is
    // pinned to the one real struct). `unknown` bridges the deliberate
    // mismatch instead of `any` — exercising the recursion this function
    // ports verbatim, defensively, for a struct shape that could exist.
    const payload = {
      types: {
        Leg: [
          { name: 'amount', type: 'uint256' },
          { name: 'fees', type: 'uint256[]' },
          { name: 'label', type: 'string' },
        ],
        Bundle: [
          { name: 'total', type: 'uint256' },
          { name: 'legs', type: 'Leg[]' },
        ],
      },
      primaryType: 'Bundle',
      domain: SERVER_PREPARED_APPROVAL_PAYLOAD.domain,
      message: {
        total: 1000,
        legs: [
          { amount: 400, fees: [1, 2, 3], label: 'first' },
          { amount: '600', fees: ['4', '5'], label: 'second' },
        ],
      },
    } as unknown as Eip712Payload;

    const result = coerceTypedDataIntegers(payload);

    expect(result.message.total).toBe(1000n);
    const legs = result.message.legs as Array<Record<string, unknown>>;
    expect(legs).toHaveLength(2);
    expect(legs[0]?.amount).toBe(400n);
    expect(legs[0]?.fees).toEqual([1n, 2n, 3n]);
    expect(legs[0]?.label).toBe('first');
    expect(legs[1]?.amount).toBe(600n);
    expect(legs[1]?.fees).toEqual([4n, 5n]);
  });
});

describe('coerceTypedDataIntegers — byte-preservation of scopes/resources/conditions', () => {
  // When: this test goes red if the coercion sorts, dedupes, or otherwise
  // normalizes an array field — Canon LBD 2026-JUL-14 names these arrays the
  // sole cryptographic truth, and this ceremony must sign exactly what the
  // server prepared, not a "cleaned up" version of it.
  it('preserves conditions byte-for-byte: order, duplicates, membership', () => {
    const result = coerceTypedDataIntegers(SERVER_PREPARED_APPROVAL_PAYLOAD);

    expect(result.message.conditions).toEqual(SERVER_PREPARED_APPROVAL_PAYLOAD.message.conditions);
    expect(result.message.conditions).toHaveLength(3);
    // Pin the specific normalisations this must NOT apply.
    const conditions = result.message.conditions as string[];
    expect(conditions).not.toEqual([...conditions].sort());
    expect(conditions).not.toEqual([...new Set(conditions)]);
  });

  it('preserves an adversarial scopes/resources array: unsorted, duplicate-bearing, empty-string-containing', () => {
    const adversarial = ['z-last', '', 'a-first', 'z-last', '  padded  '];
    const payload: Eip712Payload = {
      ...SERVER_PREPARED_APPROVAL_PAYLOAD,
      message: {
        ...SERVER_PREPARED_APPROVAL_PAYLOAD.message,
        scopes: adversarial,
        resources: adversarial,
      },
    };

    const result = coerceTypedDataIntegers(payload);

    expect(result.message.scopes).toEqual(adversarial);
    expect(result.message.scopes).toStrictEqual(adversarial);
    expect(result.message.resources).toEqual(adversarial);
    expect(result.message.scopes).not.toEqual([...adversarial].sort());
    expect(result.message.scopes).not.toEqual([...new Set(adversarial)]);
    expect(result.message.scopes).not.toEqual(adversarial.filter((s) => s !== ''));
  });
});

describe('coerceTypedDataIntegers — domain.chainId normalization', () => {
  // When: this test goes red if an all-digit-string `domain.chainId` is
  // signed as-is instead of normalised to a Number — `coerceTypedDataIntegers`
  // otherwise returned `domain: payload.domain` untouched, and a wallet
  // signing a string-typed chainId produces a struct that does not match
  // what `EIP712Domain` declares (`chainId: uint256`).
  it('normalises an all-digit string domain.chainId to a Number', () => {
    const payload = {
      ...SERVER_PREPARED_APPROVAL_PAYLOAD,
      domain: { ...SERVER_PREPARED_APPROVAL_PAYLOAD.domain, chainId: '1329' as unknown as number },
    };

    const result = coerceTypedDataIntegers(payload);

    expect(result.domain.chainId).toBe(1329);
    expect(typeof result.domain.chainId).toBe('number');
  });

  it('leaves a numeric domain.chainId unchanged', () => {
    const result = coerceTypedDataIntegers(SERVER_PREPARED_APPROVAL_PAYLOAD);

    expect(result.domain.chainId).toBe(1329);
    expect(typeof result.domain.chainId).toBe('number');
  });
});

describe('coerceTypedDataIntegers — exact integer refusal', () => {
  // When: this test goes red if a fractional numeric value is handed to
  // BigInt() unguarded — `BigInt(1.5)` throws a bare, unnamed `RangeError`
  // instead of this named, field-attributed refusal.
  it('refuses a fractional value with TypedDataPrecisionError naming the field', () => {
    const payload = {
      ...SERVER_PREPARED_APPROVAL_PAYLOAD,
      message: { ...SERVER_PREPARED_APPROVAL_PAYLOAD.message, maxAmount: 1.5 },
    };

    let thrown: unknown;
    try {
      coerceTypedDataIntegers(payload);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(TypedDataPrecisionError);
    expect((thrown as TypedDataPrecisionError).field).toBe('maxAmount');
    expect((thrown as TypedDataPrecisionError).value).toBe(1.5);
  });

  // When: this test goes red if a value above Number.MAX_SAFE_INTEGER is
  // passed straight to BigInt() — the runtime has already rounded it on
  // JSON parse, so the resulting BigInt would sign a digest the server
  // cannot reproduce, silently.
  it('refuses a value above 2^53 with TypedDataPrecisionError naming the field', () => {
    const tooLarge = 2 ** 53 + 1;
    const payload = {
      ...SERVER_PREPARED_APPROVAL_PAYLOAD,
      message: { ...SERVER_PREPARED_APPROVAL_PAYLOAD.message, nonce: tooLarge },
    };

    let thrown: unknown;
    try {
      coerceTypedDataIntegers(payload);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(TypedDataPrecisionError);
    expect((thrown as TypedDataPrecisionError).field).toBe('nonce');
    expect((thrown as TypedDataPrecisionError).value).toBe(tooLarge);
  });

  // When: this test goes red if a non-numeric value is passed straight to
  // BigInt() — `BigInt('abc')` throws a bare, unnamed `SyntaxError` instead
  // of this named, field-attributed refusal.
  it('refuses a non-numeric value with TypedDataPrecisionError naming the field', () => {
    const payload = {
      ...SERVER_PREPARED_APPROVAL_PAYLOAD,
      message: { ...SERVER_PREPARED_APPROVAL_PAYLOAD.message, expiresAt: 'abc' },
    } as unknown as Eip712Payload;

    let thrown: unknown;
    try {
      coerceTypedDataIntegers(payload);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(TypedDataPrecisionError);
    expect((thrown as TypedDataPrecisionError).field).toBe('expiresAt');
    expect((thrown as TypedDataPrecisionError).value).toBe('abc');
  });
});

describe('coerceTypedDataIntegers — realistic vector', () => {
  it('produces a fully-coerced, sign-ready typed data object from the committed fixture', () => {
    const result = coerceTypedDataIntegers(SERVER_PREPARED_APPROVAL_PAYLOAD);

    expect(result.primaryType).toBe('PurchaseIntent');
    expect(result.domain).toEqual(SERVER_PREPARED_APPROVAL_PAYLOAD.domain);
    expect(result.types.PurchaseIntent).toEqual(
      SERVER_PREPARED_APPROVAL_PAYLOAD.types.PurchaseIntent,
    );
    expect(result.message).toEqual({
      wallet: '0x1111111111111111111111111111111111111111',
      nonce: 7n,
      statement: 'Approve purchase of flight SFO-JFK, up to $450.00',
      scopes: ['sr:us:pint:card:checkout'],
      resources: ['sr:us:person:safe:0x1111111111111111111111111111111111111111'],
      conditions: ['price < 45000', 'availability = confirmed', 'price < 45000'],
      maxAmount: 45000n,
      maxAmountToken: '0x0000000000000000000000000000000000000000',
      expiresAt: 1_735_689_600_000n,
    });
  });
});
