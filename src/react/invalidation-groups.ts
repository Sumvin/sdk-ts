/**
 * `@sumvin/sdk/react` — family-level cache invalidation over generated query
 * keys.
 *
 * A generated key is a single-element tuple `[{ _id, baseUrl, body?, headers?,
 * path?, query?, _infinite?, tags? }]` — one object, no hierarchical prefix.
 * TanStack matches query keys structurally (`exact: false` by default), so a
 * filter naming only `_id` spans every variant of that operation: every path
 * parameter, every query, and its infinite-query sibling (which shares the
 * same `_id` and differs only by the `_infinite` flag). A resource family
 * therefore cannot be expressed as a tuple prefix the way it could with a
 * hierarchical key — it is an explicit list of operations, and
 * {@link invalidateFamily} issues one filter per operation.
 *
 * Groups hold the generated `{op}QueryKey` **builder functions** — imported
 * from `../generated/@tanstack/react-query.gen.js` and called to recover
 * their `_id` — never operation-id string literals. If an operation is
 * renamed or removed upstream, the import fails to resolve and the build
 * breaks. A string list would keep compiling and silently match nothing,
 * which is exactly the stale-UI failure this module exists to prevent.
 *
 * Ported from sumvin-app-v2's cache-invalidation module, adapted to this
 * package's flatter generated operation ids (no path-segment suffix).
 */
import type { QueryClient, QueryFilters } from '@tanstack/react-query';
import {
  getAccountQueryKey,
  getAgentTaskByIdQueryKey,
  getAgentTaskQueryKey,
  getBankConnectionQueryKey,
  getBudgetQueryKey,
  getCardQueryKey,
  getChallengeQueryKey,
  getConnectorQueryKey,
  getExploreQueryKey,
  getInsightQueryKey,
  getIpaEventsQueryKey,
  getIpaQueryKey,
  getKycDetailsQueryKey,
  getKycDocumentImageQueryKey,
  getKycRequiredDocsQueryKey,
  getKycStatusQueryKey,
  getOnboardingEventsQueryKey,
  getOnboardingStepsQueryKey,
  getPintQueryKey,
  getRampQuotesQueryKey,
  getRampTransactionQueryKey,
  getRuleQueryKey,
  getSessionQueryKey,
  getStrategyQueryKey,
  getTransactionQueryKey,
  getUserAccountQueryKey,
  getUserConnectorQueryKey,
  getUserCtasQueryKey,
  getUserStrategyQueryKey,
  getWalletBalanceSummaryQueryKey,
  getWalletQueryKey,
  getWidgetQueryKey,
  listAccountsQueryKey,
  listAgentTasksQueryKey,
  listAllAgentTasksQueryKey,
  listBankConnectionsQueryKey,
  listBudgetsQueryKey,
  listCardsQueryKey,
  listConnectorsQueryKey,
  listInsightsQueryKey,
  listIpasQueryKey,
  listKycDocumentsQueryKey,
  listMessagesQueryKey,
  listPintsQueryKey,
  listPintTokensQueryKey,
  listRampTransactionsQueryKey,
  listRulesQueryKey,
  listSessionsQueryKey,
  listStrategiesQueryKey,
  listTransactionsQueryKey,
  listUserConnectorsQueryKey,
  listUserStrategiesQueryKey,
  listWalletAssetsQueryKey,
  listWalletAssetTransactionsQueryKey,
  listWalletsQueryKey,
  listWidgetsQueryKey,
  resolveUsernameQueryKey,
} from '../generated/@tanstack/react-query.gen.js';

/**
 * A generated `{op}QueryKey` builder function.
 *
 * Arity varies — path-parameterised operations declare their options
 * argument as required, query-only operations leave it optional — but every
 * builder assigns `_id` before it reads anything else from `options`, so the
 * operation id is always recoverable by invoking the builder with no
 * arguments. That is the one place this module casts away the required-arg
 * signature ({@link operationIdOf}); every other function here reaches the id
 * through it.
 */
export type QueryKeyBuilder = (...args: never[]) => readonly [{ readonly _id: string }];

/**
 * Named families of generated query-key builders, grouped by the resource
 * they read. Pass a family name to {@link invalidateFamily},
 * {@link familyOperationFilters}, or {@link unionFamilies}.
 *
 * @example
 * ```ts
 * import { useQueryClient } from '@tanstack/react-query';
 * import { invalidateFamily } from '@sumvin/sdk/react';
 *
 * const queryClient = useQueryClient();
 * await invalidateFamily(queryClient, 'wallets');
 * ```
 */
export const invalidationGroups = {
  /**
   * `getUserAccountQueryKey` caches a pre-account-creation 404 as a
   * non-retryable error, and TanStack attaches that error state to the query
   * observer. `invalidateQueries` and `setQueryData` both leave the error
   * state attached, so immediately after creating the account the next
   * render can still replay the cached 404 before a refetch resolves.
   * Cancel this group's filters and then `removeQueries` them — never just
   * `invalidateQueries` — before seeding post-create data with
   * `setQueryData`; `removeQueries` is the only one of the three that
   * actually clears the attached error state.
   */
  user: [getUserAccountQueryKey],
  users: [resolveUsernameQueryKey],
  wallets: [
    listWalletsQueryKey,
    getWalletQueryKey,
    getWalletBalanceSummaryQueryKey,
    listWalletAssetsQueryKey,
    listWalletAssetTransactionsQueryKey,
  ],
  accounts: [listAccountsQueryKey, getAccountQueryKey],
  bankLinkingConnections: [listBankConnectionsQueryKey, getBankConnectionQueryKey],
  cards: [listCardsQueryKey, getCardQueryKey],
  transactions: [listTransactionsQueryKey, getTransactionQueryKey],
  strategies: [listStrategiesQueryKey, getStrategyQueryKey],
  // Spans two resources — a user's own strategy subscriptions own the agent
  // tasks running under them, so a strategy-subscription change invalidates
  // the tasks hanging off it too.
  userStrategies: [
    listUserStrategiesQueryKey,
    getUserStrategyQueryKey,
    listAgentTasksQueryKey,
    getAgentTaskQueryKey,
  ],
  userStrategiesTasks: [listAgentTasksQueryKey, getAgentTaskQueryKey],
  agentTasks: [listAllAgentTasksQueryKey, getAgentTaskByIdQueryKey],
  connectors: [listConnectorsQueryKey, getConnectorQueryKey],
  userConnectors: [listUserConnectorsQueryKey, getUserConnectorQueryKey],
  rules: [listRulesQueryKey, getRuleQueryKey],
  /** Same pre-account-creation-404 hazard as `user` above: onboarding reads
   * 404 until the account exists, so a post-create seed needs the same
   * cancel-then-`removeQueries` treatment before `setQueryData`. */
  onboarding: [getOnboardingStepsQueryKey, getOnboardingEventsQueryKey],
  budgets: [listBudgetsQueryKey, getBudgetQueryKey],
  chatSessions: [listSessionsQueryKey, getSessionQueryKey, listMessagesQueryKey],
  ctas: [getUserCtasQueryKey],
  insights: [listInsightsQueryKey, getInsightQueryKey],
  widgets: [listWidgetsQueryKey, getWidgetQueryKey],
  siwe: [getChallengeQueryKey],
  ipas: [listIpasQueryKey, getIpaQueryKey, getIpaEventsQueryKey],
  pints: [listPintsQueryKey, getPintQueryKey, listPintTokensQueryKey],
  explore: [getExploreQueryKey],
  ramp: [getRampQuotesQueryKey, listRampTransactionsQueryKey, getRampTransactionQueryKey],
  /**
   * Existing Sumvin consumers invalidate KYC reads by individual operation
   * rather than as a family — a KYC status change rarely needs every KYC
   * read refreshed at once. This group is provided anyway: a consumer that
   * does want to refresh the whole KYC surface at once (after
   * `submitKycForReview`, say) can invalidate one family instead of
   * enumerating five operations by hand.
   */
  kyc: [
    getKycStatusQueryKey,
    getKycDetailsQueryKey,
    getKycRequiredDocsQueryKey,
    listKycDocumentsQueryKey,
    getKycDocumentImageQueryKey,
  ],
} satisfies Record<string, readonly QueryKeyBuilder[]>;

/** The name of one entry in {@link invalidationGroups}. */
export type InvalidationFamily = keyof typeof invalidationGroups;

/**
 * `_id` is assigned before a builder reads anything else from its options,
 * so calling a builder with no arguments yields the operation id regardless
 * of its declared arity. This is the only place in the module that writes
 * the argless-invoke cast; every other function reaches the operation id
 * through this or through {@link operationFilter}.
 */
function operationIdOf(builder: QueryKeyBuilder): string {
  return (builder as () => readonly [{ readonly _id: string }])()[0]._id;
}

function operationIdFilter(id: string): QueryFilters {
  return { queryKey: [{ _id: id }] };
}

/**
 * The partial filter that names one operation and nothing else. Omitting
 * `baseUrl`, `path`, and `query` is what makes it span every variant of the
 * operation, regardless of the origin the client was configured with.
 * Structural partial-matching fails silently on a shape mismatch, so the
 * envelope is built once here rather than assembled per call site.
 *
 * @example
 * ```ts
 * import { getWalletQueryKey } from '@sumvin/sdk/react';
 * import { operationFilter } from '@sumvin/sdk/react';
 *
 * await queryClient.invalidateQueries(operationFilter(getWalletQueryKey));
 * ```
 */
export function operationFilter(builder: QueryKeyBuilder): QueryFilters {
  return operationIdFilter(operationIdOf(builder));
}

/**
 * An operation filter narrowed to one set of path parameters. Still partial
 * on `query`, so it spans every query variant of that one resource. Naming
 * `path` is the only supported narrowing — adding `query` here would pin the
 * parameters and match a single cache entry instead of a resource.
 *
 * @example
 * ```ts
 * await queryClient.invalidateQueries(
 *   operationPathFilter(getWalletQueryKey, { wallet_id })
 * );
 * ```
 */
export function operationPathFilter(
  builder: QueryKeyBuilder,
  path: Readonly<Record<string, string>>,
): QueryFilters {
  return { queryKey: [{ _id: operationIdOf(builder), path }] };
}

/**
 * Invalidates every variant of one operation.
 *
 * @example
 * ```ts
 * await invalidateOperation(queryClient, getWalletQueryKey);
 * ```
 */
export function invalidateOperation(
  queryClient: QueryClient,
  builder: QueryKeyBuilder,
): Promise<void> {
  return queryClient.invalidateQueries(operationFilter(builder));
}

/**
 * Cancels in-flight reads of every variant of one operation. Call this
 * before `removeQueries` when clearing cached error state (see the note on
 * the `user` group above) — otherwise a request that settles after the
 * removal can reattach the very error being cleared.
 *
 * @example
 * ```ts
 * await cancelOperation(queryClient, getWalletQueryKey);
 * ```
 */
export function cancelOperation(queryClient: QueryClient, builder: QueryKeyBuilder): Promise<void> {
  return queryClient.cancelQueries(operationFilter(builder));
}

/**
 * The operation ids backing one family, in group-definition order.
 *
 * @example
 * ```ts
 * familyOperationIds('wallets'); // ['listWallets', 'getWallet', ...]
 * ```
 */
export function familyOperationIds(family: InvalidationFamily): readonly string[] {
  return invalidationGroups[family].map(operationIdOf);
}

/**
 * One partial filter per operation in a family — for a caller that wants to
 * batch or otherwise customise how each filter is applied (`invalidateQueries`
 * vs `removeQueries` vs `cancelQueries`) rather than using
 * {@link invalidateFamily}'s fixed policy.
 *
 * @example
 * ```ts
 * const filters = familyOperationFilters('wallets');
 * await Promise.all(filters.map((f) => queryClient.invalidateQueries(f)));
 * ```
 */
export function familyOperationFilters(family: InvalidationFamily): readonly QueryFilters[] {
  return familyOperationIds(family).map(operationIdFilter);
}

/**
 * Invalidates every operation in a family. One filter per operation — a
 * single filter cannot span several `_id`s, so the fan-out is the mechanism,
 * not an optimisation gap.
 *
 * @example
 * ```ts
 * await invalidateFamily(queryClient, 'wallets');
 * ```
 */
export async function invalidateFamily(
  queryClient: QueryClient,
  family: InvalidationFamily,
): Promise<void> {
  await Promise.all(
    familyOperationFilters(family).map((filter) => queryClient.invalidateQueries(filter)),
  );
}

/**
 * Combines any number of families into one flat, deduplicated list of
 * filters — the composition primitive for a consumer whose mutation crosses
 * more than one family (e.g. creating a transaction affects both `wallets`
 * and `transactions`). Deduplicated by operation id, so families that
 * deliberately overlap (`userStrategies` and `userStrategiesTasks`, both of
 * which cover agent tasks) don't produce a redundant filter per shared
 * operation.
 *
 * Returns filters, not a fixed invalidation policy — the caller decides
 * `invalidateQueries` vs `removeQueries` vs `cancelQueries` per filter, the
 * same choice {@link familyOperationFilters} leaves open for a single family.
 *
 * @example
 * ```ts
 * const filters = unionFamilies('wallets', 'transactions');
 * await Promise.all(filters.map((f) => queryClient.invalidateQueries(f)));
 * ```
 */
export function unionFamilies(...families: readonly InvalidationFamily[]): readonly QueryFilters[] {
  const seen = new Set<string>();
  const filters: QueryFilters[] = [];
  for (const family of families) {
    for (const id of familyOperationIds(family)) {
      if (!seen.has(id)) {
        seen.add(id);
        filters.push(operationIdFilter(id));
      }
    }
  }
  return filters;
}
