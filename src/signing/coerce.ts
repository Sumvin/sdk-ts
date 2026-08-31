import type { Eip712Payload } from '../generated/types.gen.js';
import { TypedDataPrecisionError } from './errors.js';
import type { Eip712TypeField, SignableTypedData } from './types.js';

// Matches solidity (u)int types, sized or unsized, optionally an array:
// int, uint, uint256, int8, uint256[], int128[] ...
const INTEGER_TYPE = /^u?int\d*(\[\])?$/;

// An all-digit decimal string — the safe wire encoding for a value that could
// exceed `Number.MAX_SAFE_INTEGER` (arbitrary precision, nothing to lose on
// the way here).
const DIGITS_ONLY = /^\d+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Convert one integer-typed field value to an exact `BigInt`, or throw
 * {@link TypedDataPrecisionError} naming `field`.
 *
 * A `bigint` input passes through unchanged (already exact — nothing to
 * lose). A decimal **string** is the safer wire encoding — arbitrary
 * precision, so nothing can have been lost before it reached us — and is
 * accepted whenever it is all digits. A JSON **number** is only safe below
 * 2^53: above that the runtime already rounded it on parse, and
 * `BigInt(rounded)` would yield a structurally valid signature over a digest
 * the server cannot reproduce. `Number.isSafeInteger` rather than `value >
 * Number.MAX_SAFE_INTEGER`: the latter admits fractional values, and
 * `BigInt(1.5)` throws a bare `RangeError` that would otherwise escape as an
 * unhandled library error instead of this named refusal.
 */
function toExactBigInt(field: string, value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && DIGITS_ONLY.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new TypedDataPrecisionError(field, value);
}

function coerceIntegerValue(field: string, value: unknown, isArray: boolean): unknown {
  if (isArray) {
    if (!Array.isArray(value)) return value;
    // ORDER, LENGTH and MEMBERSHIP are untouched here — `.map` preserves all
    // three. Only each element's own representation changes (string/number
    // -> BigInt). No `int`/`uint` array exists on `PurchaseIntent` today
    // (`scopes`/`resources`/`conditions` are all `string[]`), but a struct
    // that gains one in the future gets the same guarantee this function
    // already gives every other array field: never sorted, deduped, or
    // filtered — see Canon LBD 2026-JUL-14.
    return value.map((element) => toExactBigInt(field, element));
  }
  return toExactBigInt(field, value);
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

    if (INTEGER_TYPE.test(field.type)) {
      result[field.name] = coerceIntegerValue(field.name, value, field.type.endsWith('[]'));
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
 * (`^u?int\d*(\[\])?$` — `uint256`, `int8`, `uint256[]`, …) to BigInt,
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
    typeof rawChainId === 'string' && DIGITS_ONLY.test(rawChainId)
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
