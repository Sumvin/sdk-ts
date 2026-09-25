---
"@sumvin/sdk": minor
---

Regenerate the client for the `signing_key` onboarding step and the mandate-key setup-failure report.

- `OnboardingStep` / `zOnboardingStep` gain `signing_key`, between `kyc_verification` and `byo_safe`. Accounts that arrive through an agent and have their smart wallet deployed for them go through this step. It is done once the account holder binds the wallet key they created in their browser (`putMandateKeyWallet`). It is waived when identity verification was skipped.
  - `GET /v0/user/me/onboarding/steps` is a strict-validated operation. An older SDK's `createSumvinClient` validates responses by default, so it fails the call closed with a contract-drift error the first time the API reports `signing_key`. Upgrade before the API starts sending it.
  - If you `switch` over `OnboardingStep`, add a `signing_key` case.
- New operation `postMandateKeySetupFailure` (`POST /v0/user/me/mandate-key/setup-failures`, `204`), with `postMandateKeySetupFailureMutation` in the React Query helpers. Its request type is `ReportMandateKeySetupFailureRequest`. Send it from the account holder's own signed-in browser session each time setting up the mandate key fails. Name the failed `stage` (`create` / `encrypt` / `bind` / `passkey`) and give a `cause_class`. `para_status` and `para_code` are optional.
  - The body describes the failure only. Never send a wallet share, ciphertext, passkey output, wallet ID or address.
  - A body with any extra field is refused with a `422`.
  - Personal access tokens, agent tokens and connector access tokens are refused.
- No security-scheme changes (`bun run spec:diff-security` reports none).

These changes merged to sumvin-api `main` as `a90f5369`. See `spec/PIN` for the commit the vendored spec is pinned to.
