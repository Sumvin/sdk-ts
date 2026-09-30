---
"@sumvin/sdk": minor
---

Regenerate the client from sumvin-api main (spec `info.version` 0.44.6, commit `a585d99a`), which adds the payment-method operations.

- **New operations:** `listPaymentMethods` (`GET /v0/payment-methods`), `createPaymentMethod` (`POST /v0/payment-methods`, no request body, answers `202`) and `getPaymentMethod` (`GET /v0/payment-methods/{payment_method_id}`), with their TanStack Query options and Zod schemas.
- **New types:** `PaymentMethodResponse`, `PaymentMethodListResponse`, `PaymentMethodCaptureMode` and `VisaEnrollmentStatus` (`pending` → `tokenized` → `enrolled`, or `failed`). `last_four` and `brand` are optional and nullable.
- **Strict response validation** on both payment-method reads. Each is in `VALIDATED_OPERATIONS` and `STRICT_OPERATIONS`, so a malformed card list or card fails the call closed instead of rendering.
- **Mandates:** `MandateCeremonyResponse` gains an optional, nullable `kind` (`MandateKind`: `spend` | `read`) and `mandate_expires_at`.
- **Error codes:** `ApiErrorCode` gains `PMT-424-001-R`, `VIC-403-001`, `KYC-403-005` and `IPA-410-001`.
