---
"@sumvin/sdk": minor
---

Add `putMandateKeyWallet` and `getMandateKeyShare`, generated from sumvin-api's new mandate-key wallet-bind surface: verifying and binding a browser-created Para wallet as the account holder's mandate key, and reading back its encrypted key share.

- `putMandateKeyWallet` — `PUT /v0/user/me/mandate-key/wallet` — binds a browser-created wallet as the mandate key and starts adding it as a smart-wallet owner.
- `getMandateKeyShare` — `GET /v0/user/me/mandate-key/share` — reads the wallet's encrypted key share back once binding has completed.
- `getUserMandateKey`'s response (`MandateKeyActivationResponse`) now carries a strongly-typed `_links` (`MandateKeyLinks`): `self` is always present, `wallet` and `share` are nullable — `share` is explicitly `null` until a wallet is bound, since there is nothing to read back yet.
- New `PAR-*` error codes on `ApiErrorCode` for the embedded-wallet provider's failure modes (unauthorized signature, not-found wallet, conflicting binding state, validation, rate limiting, and upstream provider errors).

The vendored OpenAPI spec is re-pinned to sumvin-api `8c4cb17` (the merged `main` commit for PR #2043; superseding this PR's earlier `201eb459` pre-review pin) and the generated client is regenerated from it. Post-review changes from `201eb459` to `8c4cb17`, on top of the additions above:

- `putMandateKeyWallet`'s `422` response is now `ProblemDetail` (was `HttpValidationErrorDetail`), so a malformed body or a failed possession-signature check now carries a `PAR-422-*` or `GEN-400-001` error code instead of FastAPI's bare validation-error shape.
- `MandateKeyWalletShareResponse.encryption` is now typed `WalletShareEncryptionData`, a response-side counterpart to the existing request-side `WalletShareEncryption` (unchanged, still used on the bind request) — not a rename, the two schemas now coexist.
- `MandateKeyWalletLinks` (the share response's `_links`) drops its own `share` field — the share link now lives solely on `MandateKeyLinks` above — and `wallet`'s doc clarifies binding is safe to repeat.
- `MandateKeyActivationResponse.address` is documented checksummed, not lowercased.
- No security-scheme changes between `201eb459` and `8c4cb17` (`bun run spec:diff-security` reports none); `sendSafeRpc` still gains `PintBearer` as an additional accepted auth scheme relative to this branch's original base, as already noted below.

Every operation/schema change from the original base pin is still additive; nothing is removed or renamed at the operation level:

- five operations: read/bind/read-share for the mandate key, the new `/v0/webhooks/para` embedded-wallet-provider webhook (`receiveParaWebhookEvent`), and reading a mandate ceremony's status
- one existing operation (`sendSafeRpc`) gains `PintBearer` as an additional accepted auth scheme, alongside the two it already accepted
- 11 net new schemas, including `MandateKeyActivationResponse`, `BindMandateKeyWalletRequest`, `MandateKeyLinks`, and `WalletShareEncryptionData`
