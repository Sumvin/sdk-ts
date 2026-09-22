---
"@sumvin/sdk": minor
---

Add `putMandateKeyWallet` and `getMandateKeyShare`, generated from sumvin-api's new mandate-key wallet-bind surface: verifying and binding a browser-created Para wallet as the account holder's mandate key, and reading back its encrypted key share.

- `putMandateKeyWallet` — `PUT /v0/user/me/mandate-key/wallet` — binds a browser-created wallet as the mandate key and starts adding it as a smart-wallet owner.
- `getMandateKeyShare` — `GET /v0/user/me/mandate-key/share` — reads the wallet's encrypted key share back once binding has completed.
- `getUserMandateKey`'s response (`MandateKeyActivationResponse`) now carries `_links.wallet` and `_links.share`, pointing at the two operations above.
- New `PAR-*` error codes on `ApiErrorCode` for the embedded-wallet provider's failure modes (unauthorized signature, not-found wallet, conflicting binding state, validation, rate limiting, and upstream provider errors).

The vendored OpenAPI spec is re-pinned to sumvin-api `201eb459` and the generated client is regenerated from it. Every change is an addition; nothing is removed or renamed:

- five operations: read/bind/read-share for the mandate key, the new `/v0/webhooks/para` embedded-wallet-provider webhook (`receiveParaWebhookEvent`), and reading a mandate ceremony's status
- one existing operation (`sendSafeRpc`) gains `PintBearer` as an additional accepted auth scheme, alongside the two it already accepted
- 9 net new schemas, including `MandateKeyActivationResponse`, `BindMandateKeyWalletRequest`, and `MandateKeyWalletShareResponse`
