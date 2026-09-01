import type { Eip712Payload } from '../generated/types.gen.js';
import { TypedDataPrecisionError, TypedDataShapeError, TypedDataSignError } from './errors.js';
import type { Eip712TypeField, SignableTypedData } from './types.js';

// Matches solidity's unsigned/signed integer types separately, sized or
// unsized, optionally an array: uint, uint256, uint256[] / int, int8,
// int128[]. Split from one combined pattern so the field's sign is known
// (not just "it's an integer") before any value is coerced or refused.
const UINT_TYPE = /^uint\d*(\[\])?$/;
const INT_TYPE = /^int\d*(\[\])?$/;

// An all-digit decimal string — the safe wire encoding for a value that could
// exceed `Number.MAX_SAFE_INTEGER` (arbitrary precision, nothing to lose on
// the way here). `SIGNED_DIGITS` additionally admits a leading `-` for
// `int*` fields; `UNSIGNED_DIGITS` never does, so a negative string on a
// `uint*` field is classified as a sign violation, not a parse failure.
const UNSIGNED_DIGITS = /^\d+$/;
const SIGNED_DIGITS = /^-?\d+$/;
const NEGATIVE_DIGITS = /^-\d+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Convert one integer-typed field value to an exact `BigInt`, or throw a
 * named error identifying why it can't be signed as-is.
 *
 * Three distinct refusals, never conflated:
 * - {@link TypedDataPrecisionError} — the value's magnitude or shape can't
 *   convert exactly (a fractional number, a number above 2^53, a
 *   non-numeric string). A JSON **number** is only safe below 2^53: above
 *   that the runtime already rounded it on parse, and `BigInt(rounded)`
 *   would yield a structurally valid signature over a digest the server
 *   cannot reproduce. `Number.isSafeInteger` rather than `value >
 *   Number.MAX_SAFE_INTEGER`: the latter admits fractional values, and
 *   `BigInt(1.5)` throws a bare `RangeError` that would otherwise escape as
 *   an unhandled library error instead of this named refusal.
 * - {@link TypedDataSignError} — the value converts exactly but is negative
 *   on a field declared `uint*`, which has no representation for a sign at
 *   all. This applies uniformly across all three wire forms: a `bigint`
 *   input is otherwise trusted unconditionally (already exact — nothing to
 *   lose), but a negative one is still refused, because "exact" and
 *   "representable by this field's declared type" are different questions.
 *   `"-0"` is treated as carrying a sign character regardless of its
 *   (zero) magnitude — see the class's own TSDoc.
 * - A signed (`int*`) field accepts a negative value in all three forms
 *   (`bigint`, all-digit decimal string with an optional leading `-`,
 *   `Number.isSafeInteger` number) — this is the loosening ENG-3468 makes:
 *   today a signed field wrongly refuses every negative value.
 */
function toExactBigInt(field: string, value: unknown, signed: boolean): bigint {
  if (typeof value === 'bigint') {
    if (!signed && value < 0n) throw new TypedDataSignError(field, value);
    return value;
  }
  if (typeof value === 'string') {
    if (UNSIGNED_DIGITS.test(value)) return BigInt(value);
    if (signed && SIGNED_DIGITS.test(value)) return BigInt(value);
    if (!signed && NEGATIVE_DIGITS.test(value)) throw new TypedDataSignError(field, value);
    throw new TypedDataPrecisionError(field, value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypedDataPrecisionError(field, value);
    if (value >= 0 || signed) return BigInt(value);
    throw new TypedDataSignError(field, value);
  }
  throw new TypedDataPrecisionError(field, value);
}

function coerceIntegerValue(
  field: string,
  value: unknown,
  isArray: boolean,
  signed: boolean,
  declaredType: string,
): unknown {
  if (isArray) {
    if (!Array.isArray(value)) throw new TypedDataShapeError(field, declaredType, value);
    // ORDER, LENGTH and MEMBERSHIP are untouched here — `.map` preserves all
    // three. Only each element's own representation changes (string/number
    // -> BigInt), and each element's error attribution gets its index
    // (`"fees[1]"`) so a failure in a multi-element array names which one —
    // that indexing is metadata for the thrown error only, never a
    // transformation applied to the array itself. No `int`/`uint` array
    // exists on `PurchaseIntent` today (`scopes`/`resources`/`conditions`
    // are all `string[]`), but a struct that gains one in the future gets
    // the same guarantee this function already gives every other array
    // field: never sorted, deduped, or filtered — see Canon LBD 2026-JUL-14.
    return value.map((element, index) => toExactBigInt(`${field}[${index}]`, element, signed));
  }
  if (Array.isArray(value)) throw new TypedDataShapeError(field, declaredType, value);
  return toExactBigInt(field, value, signed);
}

/**
 * Coerce every integer-typed field of `message` (for the given struct
 * `type`) to BigInt, recursing into nested struct types declared in `types`.
 * Internal — {@link coerceTypedDataIntegers} is the public entry point.
 */
function coerceMessage(
  message: Record<string, unknown>,
  structType: string,
  types: Record<string, readonly Eip712TypeField[]>,
): Record<string, unknown> {
  const fields = types[structType];
  if (!fields) return message;

  const result: Record<string, unknown> = { ...message };
  for (const field of fields) {
    const value = result[field.name];
    if (value === undefined || value === null) continue;

    const isUint = UINT_TYPE.test(field.type);
    const isInt = !isUint && INT_TYPE.test(field.type);
    if (isUint || isInt) {
      result[field.name] = coerceIntegerValue(
        field.name,
        value,
        field.type.endsWith('[]'),
        isInt,
        field.type,
      );
      continue;
    }

    // Recurse into nested struct types (and arrays thereof). No field of
    // `PurchaseIntent` is a nested struct today — this branch is exercised
    // defensively, ported unchanged from the source it mirrors, so a future
    // struct that does nest is coerced correctly on day one rather than
    // silently skipped.
    const baseType = field.type.replace(/\[\]$/, '');
    if (types[baseType]) {
      if (field.type.endsWith('[]') && Array.isArray(value)) {
        result[field.name] = value.map((element) =>
          isPlainObject(element) ? coerceMessage(element, baseType, types) : element,
        );
      } else if (isPlainObject(value)) {
        result[field.name] = coerceMessage(value, baseType, types);
      }
    }
  }
  return result;
}

/**
 * Coerce every integer-typed field of a server-prepared EIP-712 payload
 * (`uint256`, `int8`, `uint256[]`, … — signed and unsigned matched
 * separately so each field's declared sign is known before its value is
 * coerced) to BigInt,
 * recursing into nested struct types declared in `payload.types`.
 *
 * Ported from sumvin-app-v2's `toSignableTypedData`
 * (`src/lib/pint/eip712.ts`) — a server-prepared PENDING errand's
 * `IpaData.approval_payload` serialises every `uint256` as a JSON number or
 * numeric string (JSON has no BigInt), and an injected {@link
 * SignTypedDataFn} (a viem `WalletClient`, in practice) requires a real
 * BigInt for those fields.
 *
 * Array **order, length and membership are untouched** — only the
 * representation of each element changes, never its position or presence.
 * Per Canon LBD 2026-JUL-14, `scopes`/`resources`/`conditions` are the sole
 * cryptographic truth and travel byte-for-byte into the signed message; none
 * of the three is integer-typed, so this function copies them through
 * unchanged rather than touching them.
 *
 * `domain.chainId` is normalised from an all-digit string to a `Number` when
 * the server (or an intermediary re-serialising the JSON) sends it as a
 * string; the generated {@link Eip712Payload}'s `domain.chainId` is typed
 * `number`, but nothing on the wire guarantees that at runtime. Any other
 * `chainId` shape passes through unchanged — this is a defensive guard, not
 * a validation.
 *
 * An integer-typed field whose value can't be converted to `BigInt` exactly
 * throws {@link TypedDataPrecisionError} naming the offending field, rather
 * than letting a bare `RangeError`/`SyntaxError` from `BigInt()` escape.
 *
 * @example
 * const { data } = await getIpa({ client, path: { ipa_id } });
 * const payload = data?.intent.approval_payload;
 * if (payload) {
 *   const typedData = coerceTypedDataIntegers(payload);
 *   const signature = await signTypedData(typedData);
 * }
 */
export function coerceTypedDataIntegers(payload: Eip712Payload): SignableTypedData {
  // The generated `Eip712Payload['types']` blob is `{[key: string]:
  // Array<{[key: string]: string}>}` — a permissive dict, because the spec
  // can't know a struct's field names ahead of time. Every entry the backend
  // actually emits is `{name, type}` (`EIP712TypeField = dict[str, str]` in
  // `eip712_types.py`), so this narrowing cast is safe.
  const types = payload.types as unknown as Record<string, readonly Eip712TypeField[]>;

  // The generated type pins `chainId: number`, but the wire has no such
  // guarantee — guard the string form defensively (see the TSDoc above).
  const rawChainId = payload.domain.chainId as unknown;
  const chainId: unknown =
    typeof rawChainId === 'string' && UNSIGNED_DIGITS.test(rawChainId)
      ? Number(rawChainId)
      : rawChainId;

  return {
    domain: { ...payload.domain, chainId },
    types,
    primaryType: payload.primaryType,
    message: coerceMessage(
      payload.message as unknown as Record<string, unknown>,
      payload.primaryType,
      types,
    ),
  };
}
