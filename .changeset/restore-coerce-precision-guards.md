---
"@sumvin/sdk": patch
---

`src/signing`'s `coerceTypedDataIntegers` now guards two failure modes that could
previously reach a signature silently or unhelpfully:

- **`domain.chainId` normalization.** A server (or an intermediary re-serialising the
  JSON) that sends `domain.chainId` as an all-digit string now gets it normalised to a
  `Number` before signing, instead of being passed through untouched — the generated
  `Eip712Payload.domain.chainId` is typed `number`, but nothing on the wire guarantees
  that at runtime.
- **Exact integer conversion.** An integer-typed field's value that cannot be converted
  to `BigInt` exactly — above `Number.MAX_SAFE_INTEGER`, fractional, or non-numeric — now
  throws the new, exported `TypedDataPrecisionError` (naming the offending field) instead
  of letting a bare `RangeError`/`SyntaxError` from `BigInt()` escape as an unnamed
  library error. `TypedDataPrecisionError` is exported from `@sumvin/sdk/signing`.
