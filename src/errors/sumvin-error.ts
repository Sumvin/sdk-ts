/**
 * The abstract root of every error class `@sumvin/sdk` throws or returns:
 * {@link ApiError}, `ContractDriftError`, `HalError` (and its subclasses),
 * `DeviceLoginError` (and its subclasses), and `TypedDataPrecisionError`.
 * `instanceof SumvinError` — or {@link isSumvinError} — is the one guard a
 * consumer needs to recognize "this came from the SDK", regardless of which
 * of those five families produced it.
 *
 * This is a marker for the funnel, not a normalization of every family into
 * one shape: each subclass keeps its own fields (`ApiError.kind`,
 * `ContractDriftError.issues`, `HalRelNotFoundError.rel`, …), and the
 * error-handling design deliberately keeps `ApiError` and `ContractDriftError`
 * disjoint from each other rather than folding drift into `ApiError` — see
 * `interceptor.ts`'s bypass and `ContractDriftError`'s own TSDoc. Catching
 * `SumvinError` tells a caller "this SDK produced it"; it does not tell them
 * which of the five shapes it is — that still needs `isApiError` /
 * `isContractDriftError` / an `instanceof` check on the more specific class.
 */
export abstract class SumvinError extends Error {
  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Narrows `x` to {@link SumvinError} — true for an instance of any of the
 * five error families this SDK throws or returns (`ApiError`,
 * `ContractDriftError`, `HalError`, `DeviceLoginError`,
 * `TypedDataPrecisionError`), and everything each of those subclasses.
 * The one guard a consumer needs to catch every error this SDK produces in
 * a single branch, before narrowing further with `isApiError` /
 * `isContractDriftError` / a more specific `instanceof` check.
 *
 * @example
 * try {
 *   await someSdkCall();
 * } catch (e) {
 *   if (!isSumvinError(e)) throw e; // not from this SDK — rethrow
 *   if (isApiError(e)) { ... }
 *   else if (isContractDriftError(e)) { ... }
 * }
 */
export function isSumvinError(x: unknown): x is SumvinError {
  return x instanceof SumvinError;
}
