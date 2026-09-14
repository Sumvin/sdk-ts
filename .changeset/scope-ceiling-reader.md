---
"@sumvin/sdk": minor
---

Add `readScopeCeiling`, which reads the spend ceiling a PINT scope states, using the API's display-unit `max` convention.

Every `max` is an amount of the currency or asset the scope names. `sr:us:pint:spend:visa_checkout?max=25&currency=USD` is $25.00, and `spend:x402?max=0.5&asset=USDC` is 0.5 USDC. Clients that render a signed ceiling should call this reader instead of parsing scope strings. Before this convention, checkout's `max` was read as minor units, which would now show a ceiling 100× too small.

- Returns `{ kind: 'fiat', amount, currency, decimals }` or `{ kind: 'asset', amount, asset, symbol, decimals }`. `amount` is an exact decimal string. Returns `null` when the scope states no `max`.
- Throws `ScopeCeilingError` (a `SumvinError`, detectable with `isScopeCeilingError`) with a `reason`. It never truncates an over-precise amount or guesses an unknown denomination's decimals.
- The vendored OpenAPI spec is re-pinned to sumvin-api `4ced3079` and the generated client is regenerated from it. Every change is an addition; nothing is removed or renamed:
  - five operations: list and revoke agent identities, read and decide a mandate ceremony, and the Para wallet-claimed webhook
  - 13 schemas, including `MandateCeremonyResponse`, whose example uses a display-unit `visa_checkout?max=500.00&currency=USD`
  - no change to the security schemes
