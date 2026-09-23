/**
 * Responses whose contents are acted on numerically or branched on, paired with
 * the reason each one earns a closed failure mode.
 *
 * Ported verbatim (keys, reasons) from the Sumvin web app, which has run
 * these 17 in production. Membership here selects *severity* only — whether an operation is
 * validated at all is a separate map (`VALIDATED_OPERATIONS`)
 * so that a strict money operation can never silently downgrade to unvalidated
 * by falling out of a single combined map.
 *
 * Keys are `METHOD /path/template`, matching what a response interceptor can
 * observe on `opts.method` / `opts.url` — see `seam.test.ts` for why the
 * un-substituted template is exactly what a generated operation call produces.
 */
export const STRICT_OPERATIONS: Readonly<Record<string, string>> = {
  'GET /v0/budgets/': 'spend limits are compared and summed; a wrong figure reads as a real one',
  'GET /v0/budgets/{budget_id}': 'drives the remaining-spend calculation shown as currency',
  'GET /v0/transactions/': 'amounts are aggregated into balances and totals',
  'GET /v0/transactions/{transaction_id}': 'amount and currency are rendered as settled fact',
  'GET /v0/wallets/{wallet_id}/balances':
    'balance arithmetic; a silently absent field reads as zero',
  'GET /v0/wallets/{wallet_id}/assets': 'per-asset quantities feed portfolio totals',
  'GET /v0/user/me/assets': 'aggregated holdings shown as spendable value',
  'GET /v0/user/ipa/': 'status drives which actions are offered',
  'GET /v0/user/ipa/{ipa_id}':
    'status and conditions gate approval; a mis-parsed branch authorises spend',
  'PUT /v0/user/ipa/{ipa_id}/conditions':
    'returns the rewritten payload a user signs; a signature over a mis-parsed struct is indistinguishable from a valid one',
  'GET /v0/pint/': 'authorisation state decides whether an agent may transact',
  'GET /v0/pint/{pint_id}': 'scope and expiry bound what an agent is permitted to do',
  'GET /v0/user/me/onboarding/steps':
    'step state selects the screen; a wrong branch strands the user',
  'GET /v0/user/me/onboarding/safe':
    'deployment mode is a discriminated branch with distinct key material',
  'GET /v0/kyc/status': 'verification state gates access to funded features',
  'GET /v0/card/': 'card state decides whether payment surfaces are offered',
  'GET /v0/card/{card_id}': 'freeze and tokenization state gate payment actions',
} as const;
