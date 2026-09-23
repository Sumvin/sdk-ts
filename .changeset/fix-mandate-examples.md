---
"@sumvin/sdk": patch
---

Documentation only; no code change. The README's agent quickstart and the `mintPint` / `mintPintAsAgent` examples now use real scopes: a fiat spend ceiling goes in the scope's `max` in the currency's display unit (`sr:us:pint:spend:visa_checkout?max=450.00&currency=USD`), with `maxAmount: '0'`. The `readScopeCeiling` examples no longer put `currency` on an `errand:search` scope, which the API refuses. The README and doc comments also describe each function in terms of what it does for the caller.
