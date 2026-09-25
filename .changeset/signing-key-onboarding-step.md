---
"@sumvin/sdk": minor
---

Regenerate the client for the `signing_key` onboarding step and the mandate-key setup-failure report.

- `OnboardingStep` / `zOnboardingStep` gain `signing_key`, between `kyc_verification` and `byo_safe`. It is in the flow for accounts that arrive through an agent and have their smart wallet deployed for them: the step is done once the account holder binds the wallet key they created in their browser (`putMandateKeyWallet`). It is waived when identity verification was skipped.
  - `GET /v0/user/me/onboarding/steps` is a strict-validated operation. A client from `createSumvinClient` on an older SDK validates responses by default, so it fails the call closed with a contract-drift error the first time the API reports `signing_key`. Upgrade before the API starts sending it.
  - If you `switch` over `OnboardingStep`, add a `signing_key` case.
- New operation `postMandateKeySetupFailure` (`POST /v0/user/me/mandate-key/setup-failures`, `204`), with `postMandateKeySetupFailureMutation` in the React Query helpers. Send it from the account holder's own signed-in browser session each time setting up the mandate key fails, naming the failed `stage` (`create` / `encrypt` / `bind` / `passkey`) and a `cause_class`. `para_status` and `para_code` are optional. The body describes the failure only: never send a wallet share, ciphertext, passkey output, wallet ID or address. A body with any extra field is refused with a `422`. Personal access tokens, agent tokens and connector access tokens are refused.
- New operation `getPublicSigil` (`GET /v0/sigils/public/{sri}`) reads a minted Sigil by its account's Sumvin identifier, with no authentication. Its response types are `SigilPublicData` / `SigilPublicResponse`.
- New `ApiErrorCode` members:
  - `KYC-429-003-R`
  - `RUN-500-001`
  - `RUN-502-001`
  - `SIGIL-404-001`
  - `SIGIL-429-001-R`
- No security-scheme changes (`bun run spec:diff-security` reports none).

The vendored OpenAPI spec is pinned to sumvin-api `f28a82cb` (spec `info.version` 0.43.1). That commit is on an unmerged sumvin-api branch, so re-pin to its merged `main` commit before this is released.
