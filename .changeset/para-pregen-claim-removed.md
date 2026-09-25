---
"@sumvin/sdk": minor
---

Regenerate the client from sumvin-api main (spec `info.version` 0.44.0, commit `193758fa`), which drops the Para pregenerate-and-claim wallet flow. The user's Para wallet is now created in the browser and bound to the account, so nothing waits for a claim.

- **Breaking type changes**, from the removal of the pregenerate-and-claim flow:
  - `MandateKeyActivationStage` no longer has `awaiting_claim`.
  - `ApiErrorCode` no longer has `PAR-502-001` or `PAR-502-002`.
  - The `handleParaWalletClaimedWebhook` operation (`POST /v0/webhooks/para/wallet-claimed`) is gone.
  - `PAR-503-001` keeps its code. On the server it is now named `PARA_NOT_CONFIGURED`, not `PARA_PREGEN_NOT_CONFIGURED`.
- New operation `getPublicSigil` (`GET /v0/sigils/public/{sri}`) returns what a minted Sigil's public share page shows (`SigilPublicResponse` / `SigilPublicData`).
- New `ApiErrorCode` members:
  - `SIGIL-404-001`
  - `SIGIL-429-001-R`
  - `KYC-429-003-R`
  - `RUN-500-001`
  - `RUN-502-001`
- No security-scheme changes (`bun run spec:diff-security` reports none).
