import { describe, expect, it } from 'vitest';
import type { Eip712Payload } from '../generated/types.gen.js';
import { SERVER_PREPARED_APPROVAL_PAYLOAD, singleFieldPayload } from './coerce.fixtures.js';
import { coerceTypedDataIntegers } from './coerce.js';
import { TypedDataPrecisionError, TypedDataShapeError, TypedDataSignError } from './errors.js';

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

describe('coerceTypedDataIntegers — signed int* accepts negative values', () => {
  // When: this test goes red if a signed (`int*`) field refuses a negative
  // value in any of the three wire forms. Signed and unsigned integer types
  // must be told apart: only `uint*` refuses a negative value.
  it.each([
    ['number', -1],
    ['decimal string', '-1'],
    ['bigint', -1n],
  ])('accepts a negative %s on an int256 field, exact', (_form, value) => {
    const payload = singleFieldPayload('int256', value);
    const result = coerceTypedDataIntegers(payload);
    expect(result.message.amount).toBe(-1n);
  });

  // `-0` has no separate BigInt representation from `0` — accepted the same
  // way a positive digit string is. Deliberate: refusing it would buy no
  // correctness (both sign identically), only pedantry.
  it('accepts "-0" on an int256 field as exactly 0n', () => {
    const payload = singleFieldPayload('int256', '-0');
    const result = coerceTypedDataIntegers(payload);
    expect(result.message.amount).toBe(0n);
  });
});

describe('coerceTypedDataIntegers — unsigned uint* refuses negative values', () => {
  // When: this test goes red if a `uint*` field accepts a negative value in
  // any of the three wire forms with anything other than TypedDataSignError.
  // A `bigint` input must not be trusted unconditionally: `-1n` on a
  // `uint256` field is refused too. The number/string cases must throw
  // TypedDataSignError, not TypedDataPrecisionError — this is a
  // precision-safe value the type simply forbids, not an inexact one.
  it.each([
    ['number', -1],
    ['decimal string', '-1'],
    ['bigint', -1n],
  ])('refuses a negative %s on a uint256 field with TypedDataSignError', (_form, value) => {
    const payload = singleFieldPayload('uint256', value);

    let thrown: unknown;
    try {
      coerceTypedDataIntegers(payload);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(TypedDataSignError);
    expect((thrown as TypedDataSignError).field).toBe('amount');
    expect((thrown as TypedDataSignError).value).toBe(value);
  });

  // `-0` carries a sign character on the wire even though its magnitude is
  // zero — treated as a sign violation on an unsigned field, consistently
  // with every other negative-string form, rather than special-cased by
  // magnitude.
  it('refuses "-0" on a uint256 field with TypedDataSignError', () => {
    const payload = singleFieldPayload('uint256', '-0');

    let thrown: unknown;
    try {
      coerceTypedDataIntegers(payload);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(TypedDataSignError);
    expect((thrown as TypedDataSignError).field).toBe('amount');
  });
});

describe('coerceTypedDataIntegers — array/scalar shape mismatch', () => {
  // When: this test goes red if an array-declared integer field silently
  // passes a scalar value through unchanged instead of refusing it —
  // `{"amounts": 5}` against a `uint256[]` field must never be signed as-is.
  it('throws TypedDataShapeError naming the field when an array-declared field gets a scalar', () => {
    const payload = singleFieldPayload('uint256[]', 5);

    let thrown: unknown;
    try {
      coerceTypedDataIntegers(payload);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(TypedDataShapeError);
    expect((thrown as TypedDataShapeError).field).toBe('amount');
    expect((thrown as TypedDataShapeError).declaredType).toBe('uint256[]');
    expect((thrown as TypedDataShapeError).value).toBe(5);
  });

  // When: this test goes red if a scalar-declared field carrying an array
  // is misattributed to TypedDataPrecisionError (today's behaviour — a
  // `String([5]) === '5'` coincidence hides the array-ness entirely and the
  // error reads "got 5") instead of the shape mismatch it actually is.
  it('throws TypedDataShapeError naming the field when a scalar-declared field gets an array', () => {
    const payload = singleFieldPayload('uint256', [5]);

    let thrown: unknown;
    try {
      coerceTypedDataIntegers(payload);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(TypedDataShapeError);
    expect((thrown as TypedDataShapeError).field).toBe('amount');
    expect((thrown as TypedDataShapeError).declaredType).toBe('uint256');
    expect((thrown as TypedDataShapeError).value).toEqual([5]);
  });
});

describe('coerceTypedDataIntegers — array element error attribution', () => {
  // When: this test goes red if a precision failure on one element of an
  // integer array is reported under the bare field name instead of naming
  // which element failed — indistinguishable in a multi-element array today.
  it('names the failing index when one element of a uint256[] array is imprecise', () => {
    const payload = singleFieldPayload('uint256[]', [1, 1.5, 2]);

    let thrown: unknown;
    try {
      coerceTypedDataIntegers(payload);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(TypedDataPrecisionError);
    expect((thrown as TypedDataPrecisionError).field).toBe('amount[1]');
    expect((thrown as TypedDataPrecisionError).value).toBe(1.5);
  });

  // When: this test goes red if the array happy path stops preserving
  // order/length once elements are individually indexed for error
  // attribution — the indexing must be metadata for the error path only,
  // never a transformation of the array itself.
  it('still preserves order and length for a uint256[] happy path', () => {
    const payload = singleFieldPayload('uint256[]', [30, 10, 20, 10]);
    const result = coerceTypedDataIntegers(payload);
    expect(result.message.amount).toEqual([30n, 10n, 20n, 10n]);
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
