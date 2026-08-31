/**
 * Errors `src/signing`'s coercion throws.
 *
 * Local to this module by design — same rationale as `src/hal/errors.ts`: an
 * integer that cannot be converted to `BigInt` without changing what a
 * signature covers is not an HTTP-shaped failure, so it gets its own typed
 * error instead of being forced through `ApiError`.
 */

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
 * @example
 * try {
 *   coerceTypedDataIntegers(payload);
 * } catch (e) {
 *   if (e instanceof TypedDataPrecisionError) {
 *     console.log(`re-fetch the payload: "${e.field}" (${String(e.value)}) can't be signed exactly`);
 *   }
 * }
 */
export class TypedDataPrecisionError extends Error {
  /** The struct field name whose value could not be converted exactly. */
  readonly field: string;
  /** The offending value, exactly as received — a string, number, or other JSON type. */
  readonly value: unknown;

  constructor(field: string, value: unknown) {
    const shown = typeof value === 'string' ? JSON.stringify(value) : String(value);
    super(
      `integer field "${field}" cannot be converted to BigInt exactly: expected a ` +
        `non-negative safe integer or an all-digit string, got ${shown}`,
    );
    this.name = 'TypedDataPrecisionError';
    this.field = field;
    this.value = value;
  }
}
