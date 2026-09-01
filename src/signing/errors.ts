/**
 * Errors `src/signing`'s coercion throws.
 *
 * Local to this module by design — same rationale as `src/hal/errors.ts`: an
 * integer that cannot be converted to `BigInt` without changing what a
 * signature covers is not an HTTP-shaped failure, so it gets its own typed
 * error instead of being forced through `ApiError`. Each class here extends
 * `SumvinError` so `isSumvinError`/`instanceof SumvinError` still catches
 * these alongside every other SDK error family — a marker for one funnel,
 * not a normalization into `ApiError`'s shape.
 */
import { SumvinError } from '../errors/sumvin-error.js';

/**
 * Thrown by {@link coerceTypedDataIntegers} when an integer-typed EIP-712
 * field's value cannot be converted to `BigInt` exactly.
 *
 * A JSON number above `Number.MAX_SAFE_INTEGER` has already lost precision
 * before reaching this function — the JS runtime rounded it on parse —
 * so converting the rounded value would produce a structurally valid
 * signature over the wrong digest, with no indication anything went wrong.
 * A fractional value is refused for the same reason: it cannot be the exact
 * on-chain integer the server declared. A non-numeric value is refused
 * because it isn't a number at all. Bare `BigInt(1.5)` and `BigInt('abc')`
 * throw an unnamed `RangeError`/`SyntaxError` that would otherwise escape a
 * signing call site as an unhandled library error; this refusal is named so
 * a consumer can catch and map it instead.
 *
 * Refuses only on *precision* grounds — the value is the wrong shape or
 * magnitude to convert exactly. A value that converts exactly but violates
 * its field's declared sign (a negative value on a `uint*` field) is a
 * different failure and throws {@link TypedDataSignError} instead; a value
 * whose array-ness doesn't match its field's declared type throws
 * {@link TypedDataShapeError}. None of the three is a "worse" version of
 * another — each names a distinct reason the same signature cannot be
 * trusted.
 *
 * @example
 * try {
 *   coerceTypedDataIntegers(payload);
 * } catch (e) {
 *   if (e instanceof TypedDataPrecisionError) {
 *     console.log(`re-fetch the payload: "${e.field}" (${String(e.value)}) can't be signed exactly`);
 *   }
 * }
 */
export class TypedDataPrecisionError extends SumvinError {
  /** The struct field name whose value could not be converted exactly. */
  readonly field: string;
  /** The offending value, exactly as received — a string, number, or other JSON type. */
  readonly value: unknown;

  constructor(field: string, value: unknown) {
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    super(
      `integer field "${field}" cannot be converted to BigInt exactly: expected a ` +
        `safe integer or an all-digit decimal string with no loss of precision, got ${shown}`,
    );
    this.name = 'TypedDataPrecisionError';
    this.field = field;
    this.value = value;
  }
}

/**
 * Thrown by {@link coerceTypedDataIntegers} when a `uint*`-typed EIP-712
 * field receives a negative value — in `bigint`, `number`, or all-digit
 * decimal-string form (`"-1"`, `"-0"`). This is deliberately **not**
 * {@link TypedDataPrecisionError}: nothing was lost converting the value,
 * and a `bigint` in particular converts with zero loss by definition. The
 * value is exact and still refused, because an unsigned type has no
 * representation for a sign at all — signing it anyway would produce a
 * structurally valid BigInt whose sign the verifying contract's `uint256`
 * ABI slot cannot carry, so the signature would commit to a struct the
 * server can never reconstruct from the same inputs.
 *
 * A leading `-` on an otherwise-zero string (`"-0"`) is refused the same
 * way as any other negative string: this class treats the wire
 * representation, not the resulting magnitude, as the contract violation —
 * an unsigned field's wire contract is "no sign character, ever," and
 * `"-0"` carries one. (A `bigint` literal has no negative-zero
 * representation at all — `-0n === 0n` — so this case can only arise from
 * the string form.)
 *
 * @example
 * try {
 *   coerceTypedDataIntegers(payload);
 * } catch (e) {
 *   if (e instanceof TypedDataSignError) {
 *     console.log(`"${e.field}" is declared unsigned but received ${String(e.value)}`);
 *   }
 * }
 */
export class TypedDataSignError extends SumvinError {
  /**
   * The struct field name whose value carried an illegal sign. For an
   * array element, indexed as `"fees[1]"` — see {@link TypedDataPrecisionError}'s
   * sibling attribution in `coerce.ts`.
   */
  readonly field: string;
  /** The offending value, exactly as received. */
  readonly value: unknown;

  constructor(field: string, value: unknown) {
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    super(
      `integer field "${field}" is declared unsigned but received a negative value ` +
        `${shown}: this is not a precision problem — the declared type forbids a sign at all`,
    );
    this.name = 'TypedDataSignError';
    this.field = field;
    this.value = value;
  }
}

/**
 * Thrown by {@link coerceTypedDataIntegers} when an integer-typed EIP-712
 * field's declared array-ness doesn't match the shape of the value it
 * actually received — an array-declared field (`uint256[]`) handed a
 * scalar, or a scalar-declared field (`uint256`) handed an array. Either
 * mismatch would sign a struct whose ABI encoding cannot match what the
 * declared type says the struct contains.
 *
 * The scalar-declared-plus-array case is easy to miss without this class:
 * `String([5]) === '5'`, so a scalar-declared field handed `[5]` used to be
 * misattributed to {@link TypedDataPrecisionError} with a message reading
 * `got 5` — correct-looking output that silently hides the fact that the
 * input was an array at all.
 *
 * @example
 * try {
 *   coerceTypedDataIntegers(payload);
 * } catch (e) {
 *   if (e instanceof TypedDataShapeError) {
 *     console.log(`"${e.field}" declares "${e.declaredType}" but got a mismatched shape`);
 *   }
 * }
 */
export class TypedDataShapeError extends SumvinError {
  /** The struct field name whose declared shape didn't match its value. */
  readonly field: string;
  /** The field's declared EIP-712 type, e.g. `"uint256[]"` or `"uint256"`. */
  readonly declaredType: string;
  /** The offending value, exactly as received. */
  readonly value: unknown;

  constructor(field: string, declaredType: string, value: unknown) {
    const gotShape = Array.isArray(value) ? 'an array' : typeof value;
    super(
      `integer field "${field}" declares type "${declaredType}" but received ${gotShape}, ` +
        'which does not match the declared shape',
    );
    this.name = 'TypedDataShapeError';
    this.field = field;
    this.declaredType = declaredType;
    this.value = value;
  }
}
