/**
 * Which operations are checked against a schema at all, and against which one.
 *
 * Entries hold the schema *value*, imported directly from the generated Zod
 * module — never the schema's name as a string. A renamed or removed
 * generated export is therefore a TypeScript build failure right here, not a
 * runtime lookup that silently resolves to nothing and downgrades the
 * operation to unvalidated. This is the discipline `hal.follow()`'s naming
 * (D5) and the query-key layer (D10) both apply for the same reason: a
 * string key "keeps compiling and stops checking."
 *
 * Ported from sumvin-app-v2's `RESPONSE_SCHEMAS` (54 entries,
 * `src/lib/api/core/response-schemas.ts`) — the set of operations the app
 * actually calls, one schema per response the app renders or acts on. Every
 * entry resolved cleanly against this repo's `spec/openapi.json` and
 * `src/generated/zod.gen.ts`; none were dropped or renamed in the port (see
 * the Wave A handoff for the verification).
 *
 * Presence here decides *whether* a response is checked; `STRICT_OPERATIONS`
 * (./strict-operations.js) decides *how hard the check fails* for the subset
 * that must fail closed. The two are independent: an operation absent from
 * this map is never validated, whatever tier it would nominally sit in — and
 * a `STRICT_OPERATIONS` key absent from this map is a defect the installer in
 * `./install.js` reports as `strict-operation-unvalidated` rather than
 * silently skipping, so a strict money operation can never fall out of both
 * maps unnoticed.
 *
 * Keys are `METHOD /path/template` — see `./strict-operations.js` and
 * `./seam.test.ts` for why that is exactly what a response interceptor
 * observes on `opts.method` / `opts.url`.
 *
 * Overridable: pass a replacement map to `installResponseValidation`'s
 * `operations` option (see `./types.js`). To change a handful of keys while
 * keeping every other default, spread this export:
 * `{ ...VALIDATED_OPERATIONS, 'GET /v0/x': mySchema }`. There is no automatic
 * merge — a merge cannot distinguish "I forgot this key" from "I meant to
 * remove it."
 */
import type { ZodType } from 'zod';
import {
  zGetAccountResponse,
  zGetBankConnectionResponse,
  zGetBudgetResponse,
  zGetCardResponse,
  zGetChallengeResponse,
  zGetExploreResponse,
  zGetInsightResponse,
  zGetInstitutionsResponse,
  zGetIpaEventsResponse,
  zGetIpaResponse,
  zGetKycDetailsResponse,
  zGetKycRequiredDocsResponse,
  zGetKycStatusResponse,
  zGetNonceResponse,
  zGetOnboardingEventsResponse,
  zGetOnboardingSafeResponse,
  zGetOnboardingStepsResponse,
  zGetPintResponse,
  zGetRampQuotesResponse,
  zGetRampTransactionResponse,
  zGetRuleResponse,
  zGetSessionResponse,
  zGetTransactionResponse,
  zGetUserAccountResponse,
  zGetUserAssetsResponse,
  zGetUserConnectorResponse,
  zGetUserCtasResponse,
  zGetUserStrategyResponse,
  zGetWalletBalanceSummaryResponse,
  zGetWidgetResponse,
  zListAccountsResponse,
  zListAllAgentTasksResponse,
  zListBankConnectionsResponse,
  zListBudgetsResponse,
  zListCardsResponse,
  zListInsightsResponse,
  zListInvestmentHoldingsResponse,
  zListInvestmentTransactionsResponse,
  zListIpasResponse,
  zListKycDocumentsResponse,
  zListPintsResponse,
  zListRampTransactionsResponse,
  zListRulesResponse,
  zListSessionsResponse,
  zListStrategiesResponse,
  zListTransactionsResponse,
  zListUserConnectorsResponse,
  zListUserStrategiesResponse,
  zListWalletAssetsResponse,
  zListWalletAssetTransactionsResponse,
  zListWalletsResponse,
  zListWidgetsResponse,
  zReplaceIpaConditionsResponse,
  zResolveUsernameResponse,
} from '../generated/zod.gen.js';

/**
 * Which operations are checked at all, and against which schema — see this
 * file's module-level comment above the imports for the full rationale.
 */
export const VALIDATED_OPERATIONS: Readonly<Record<string, ZodType>> = {
  'GET /v0/budgets/': zListBudgetsResponse,
  'GET /v0/budgets/{budget_id}': zGetBudgetResponse,
  'GET /v0/transactions/': zListTransactionsResponse,
  'GET /v0/transactions/{transaction_id}': zGetTransactionResponse,
  'GET /v0/wallets/{wallet_id}/balances': zGetWalletBalanceSummaryResponse,
  'GET /v0/wallets/{wallet_id}/assets': zListWalletAssetsResponse,
  'GET /v0/user/me/assets': zGetUserAssetsResponse,
  'GET /v0/user/ipa/': zListIpasResponse,
  'GET /v0/user/ipa/{ipa_id}': zGetIpaResponse,
  'PUT /v0/user/ipa/{ipa_id}/conditions': zReplaceIpaConditionsResponse,
  'GET /v0/pint/': zListPintsResponse,
  'GET /v0/pint/{pint_id}': zGetPintResponse,
  'GET /v0/user/me/onboarding/steps': zGetOnboardingStepsResponse,
  'GET /v0/user/me/onboarding/safe': zGetOnboardingSafeResponse,
  'GET /v0/kyc/status': zGetKycStatusResponse,
  'GET /v0/card/': zListCardsResponse,
  'GET /v0/card/{card_id}': zGetCardResponse,
  'GET /v0/accounts/': zListAccountsResponse,
  'GET /v0/accounts/{account_id}': zGetAccountResponse,
  'GET /v0/auth/siwe/challenge': zGetChallengeResponse,
  'GET /v0/bank-linking/accounts/{account_id}/holdings': zListInvestmentHoldingsResponse,
  'GET /v0/bank-linking/accounts/{account_id}/investment-transactions':
    zListInvestmentTransactionsResponse,
  'GET /v0/bank-linking/connections': zListBankConnectionsResponse,
  'GET /v0/bank-linking/connections/{connection_id}': zGetBankConnectionResponse,
  'GET /v0/bank-linking/institutions': zGetInstitutionsResponse,
  'GET /v0/chat/sessions': zListSessionsResponse,
  'GET /v0/chat/sessions/{session_id}': zGetSessionResponse,
  'GET /v0/explore/': zGetExploreResponse,
  'GET /v0/insights/': zListInsightsResponse,
  'GET /v0/insights/{insight_id}': zGetInsightResponse,
  'GET /v0/kyc/details': zGetKycDetailsResponse,
  'GET /v0/kyc/documents': zListKycDocumentsResponse,
  'GET /v0/kyc/documents/required': zGetKycRequiredDocsResponse,
  'GET /v0/pint/nonce': zGetNonceResponse,
  'GET /v0/ramp/quotes': zGetRampQuotesResponse,
  'GET /v0/ramp/transactions': zListRampTransactionsResponse,
  'GET /v0/ramp/transactions/{transaction_id}': zGetRampTransactionResponse,
  'GET /v0/strategies/': zListStrategiesResponse,
  'GET /v0/user/agent-tasks/': zListAllAgentTasksResponse,
  'GET /v0/user/connectors/': zListUserConnectorsResponse,
  'GET /v0/user/connectors/{user_connector_id}': zGetUserConnectorResponse,
  'GET /v0/user/ipa/{ipa_id}/events': zGetIpaEventsResponse,
  'GET /v0/user/me': zGetUserAccountResponse,
  'GET /v0/user/me/cta': zGetUserCtasResponse,
  'GET /v0/user/me/onboarding/events': zGetOnboardingEventsResponse,
  'GET /v0/user/rules/': zListRulesResponse,
  'GET /v0/user/rules/{rule_id}': zGetRuleResponse,
  'GET /v0/user/strategies/': zListUserStrategiesResponse,
  'GET /v0/user/strategies/{user_strategy_id}': zGetUserStrategyResponse,
  'GET /v0/users/username/{username}': zResolveUsernameResponse,
  'GET /v0/wallets/': zListWalletsResponse,
  'GET /v0/wallets/{wallet_id}/assets/{symbol}/transactions': zListWalletAssetTransactionsResponse,
  'GET /v0/widgets/': zListWidgetsResponse,
  'GET /v0/widgets/{widget_id}': zGetWidgetResponse,
};
