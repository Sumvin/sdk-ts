---
'@sumvin/sdk': minor
---

Add `isRetryableError` and `isRetryableErrorCode`. Sumvin error codes now say whether they are retryable: `DOMAIN-STATUS-SEQ` is terminal and `DOMAIN-STATUS-SEQ-R` is retryable, meaning the identical request, retried after a short backoff, can succeed without anything changing. Clients no longer need a hand-kept retry allowlist.

- `isRetryableErrorCode(code)` is `true` exactly when the code ends in `-R`.
- `isRetryableError(error)` is one retry policy over every `ApiError` kind, usable as a TanStack Query `retry` predicate. A problem follows its error code whatever its HTTP status. An HTTP failure with no readable code is retryable on `429` and `5xx`. A network failure is retryable. An abort, a refused redirect, and anything that is not an `ApiError` are not.

**Breaking for anyone matching error codes as literal strings.** 54 codes were renamed to add the `-R` suffix, and the old strings are gone from `ApiErrorCode` and `zApiErrorCode`, with no aliases. Update any comparison, `switch` or lookup table keyed on them:

| Old | New |
|---|---|
| `AGT-429-001` | `AGT-429-001-R` |
| `AID-503-001` | `AID-503-001-R` |
| `BUD-429-001` | `BUD-429-001-R` |
| `CALLER-503-001` | `CALLER-503-001-R` |
| `CHA-429-001` | `CHA-429-001-R` |
| `CHA-500-001` | `CHA-500-001-R` |
| `GATE-429-001` | `GATE-429-001-R` |
| `INS-503-001` | `INS-503-001-R` |
| `IPA-424-002` | `IPA-424-002-R` |
| `IPA-503-001` | `IPA-503-001-R` |
| `KYC-429-001` | `KYC-429-001-R` |
| `KYC-502-003` | `KYC-502-003-R` |
| `MCP-429-001` | `MCP-429-001-R` |
| `MCP-429-002` | `MCP-429-002-R` |
| `MCR-429-001` | `MCR-429-001-R` |
| `MCR-503-002` | `MCR-503-002-R` |
| `MKY-429-001` | `MKY-429-001-R` |
| `MRC-503-001` | `MRC-503-001-R` |
| `PAR-409-002` | `PAR-409-002-R` |
| `PAR-409-003` | `PAR-409-003-R` |
| `PAR-429-001` | `PAR-429-001-R` |
| `PAR-503-002` | `PAR-503-002-R` |
| `PAR-503-003` | `PAR-503-003-R` |
| `PFP-429-001` | `PFP-429-001-R` |
| `PFP-500-001` | `PFP-500-001-R` |
| `PFP-500-002` | `PFP-500-002-R` |
| `PHONE-429-002` | `PHONE-429-002-R` |
| `PHONE-503-001` | `PHONE-503-001-R` |
| `PINT-409-005` | `PINT-409-005-R` |
| `PINT-409-006` | `PINT-409-006-R` |
| `PINT-409-008` | `PINT-409-008-R` |
| `PINT-424-003` | `PINT-424-003-R` |
| `PINT-429-001` | `PINT-429-001-R` |
| `PINT-503-001` | `PINT-503-001-R` |
| `RCT-429-001` | `RCT-429-001-R` |
| `RCT-500-001` | `RCT-500-001-R` |
| `RCT-500-002` | `RCT-500-002-R` |
| `RCT-500-003` | `RCT-500-003-R` |
| `RMP-502-001` | `RMP-502-001-R` |
| `SAF-429-001` | `SAF-429-001-R` |
| `SAF-502-006` | `SAF-502-006-R` |
| `SAF-503-001` | `SAF-503-001-R` |
| `SAF-503-002` | `SAF-503-002-R` |
| `SAF-503-003` | `SAF-503-003-R` |
| `SAF-503-004` | `SAF-503-004-R` |
| `SAF-503-005` | `SAF-503-005-R` |
| `SGN-429-001` | `SGN-429-001-R` |
| `SGN-503-001` | `SGN-503-001-R` |
| `SIW-429-001` | `SIW-429-001-R` |
| `SIW-429-002` | `SIW-429-002-R` |
| `SYS-500-001` | `SYS-500-001-R` |
| `USR-429-001` | `USR-429-001-R` |
| `UST-503-001` | `UST-503-001-R` |
| `WAL-409-002` | `WAL-409-002-R` |

Seven codes are new, each split out of a code whose failures differed in retryability: `SAF-409-003-R` (the request is still in flight; `SAF-409-001` now means only that the key was reused), `KYC-503-003-R` (the counter is unreachable; `KYC-503-002` now means only the daily cap), `IPA-424-003` (lane mismatch) and `IPA-424-004` (no usable card), split from `IPA-424-002-R` (enrollment pending), `USR-424-002` (no active signer), split from `USR-424-001` (no user record), `SAF-500-002` (Sumvin's credentials or configuration were refused), split from `SAF-503-002-R`, and `SAF-503-006` (onboarding submit; prepare again first), split from `SAF-503-001-R`.

`getSafeConfig`, `getUserOperationStatus` and `sendSafeRpc` now declare a `500` response (`SAF-500-002`), and `sendSafeRpc` also declares `503`.
