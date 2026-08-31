/**
 * Standing tests for the invalidation-group builder discipline: groups are
 * built by *calling* generated `{op}QueryKey` builders, never by naming an
 * operation as a string. A string list would keep compiling and silently
 * match nothing if an operation were renamed or removed upstream — these
 * tests are what turns that failure mode into something observable in CI
 * instead of a stale UI discovered in production.
 */
import { QueryClient, type QueryFilters } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  getAccountQueryKey,
  getWalletBalanceSummaryQueryKey,
  getWalletQueryKey,
} from '../generated/@tanstack/react-query.gen.js';
import {
  cancelOperation,
  familyOperationFilters,
  familyOperationIds,
  invalidateFamily,
  invalidateOperation,
  invalidationGroups,
  operationFilter,
  operationPathFilter,
  unionFamilies,
} from './invalidation-groups.js';

/** `filter.queryKey` is typed loosely by TanStack (`unknown[] | undefined`) since
 * `QueryFilters` is generic over the consumer's own key shape — every filter this
 * module builds always carries `{ _id }` as its first element, so this narrows it
 * back for test assertions without weakening the library's own return type. */
function idOf(filter: QueryFilters): string {
  const key = filter.queryKey;
  if (!key || key.length === 0) {
    throw new Error('filter has no queryKey');
  }
  return (key[0] as { _id: string })._id;
}

const FAMILIES = Object.keys(invalidationGroups) as (keyof typeof invalidationGroups)[];

describe('invalidationGroups', () => {
  // When: a generated operation is renamed or removed and a group's builder
  // import silently resolves to `undefined` at the call site (a broken
  // re-export, not a missing import — a missing import fails the build
  // before this test runs at all) — this goes red because the group stops
  // resolving to a real, non-empty set of operation ids.
  it('every group is non-empty', () => {
    for (const family of FAMILIES) {
      expect(invalidationGroups[family].length).toBeGreaterThan(0);
    }
  });

  // When: two entries in the same group resolve to the same operation id —
  // either a copy-paste duplicate or two builders that happen to share an
  // id — invalidateFamily would issue a redundant filter. Not harmful by
  // itself, but a duplicate is also the shape a broken builder import takes
  // if it silently falls back to a sibling's id instead of failing outright.
  it('every group has no duplicate operation ids', () => {
    for (const family of FAMILIES) {
      const ids = familyOperationIds(family);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  // When: a builder is called and its `_id` comes back `undefined` — the
  // shape produced by invoking something that is not actually a
  // `{op}QueryKey` builder (e.g. a stale re-export resolving to `undefined`
  // at runtime despite typechecking, or a mis-imported value).
  it('every group resolves to real ids, never undefined', () => {
    for (const family of FAMILIES) {
      for (const id of familyOperationIds(family)) {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('operationFilter', () => {
  // When: the emitted filter shape stops being what TanStack's structural
  // partial-match actually accepts — e.g. a future refactor nests `_id`
  // under the wrong key, or switches to exact matching. Proven against a
  // real QueryClient, not just asserted structurally, because partial-match
  // is a runtime behavior of `invalidateQueries`, not a type-level property.
  it('matches every path-variant of the same operation, and nothing else', () => {
    const queryClient = new QueryClient();
    const walletA = getWalletQueryKey({ path: { wallet_id: 'wallet_a' } });
    const walletB = getWalletQueryKey({ path: { wallet_id: 'wallet_b' } });
    const account = getAccountQueryKey({ path: { account_id: 'account_a' } });

    queryClient.setQueryData(walletA, { ok: true });
    queryClient.setQueryData(walletB, { ok: true });
    queryClient.setQueryData(account, { ok: true });

    queryClient.invalidateQueries(operationFilter(getWalletQueryKey));

    expect(queryClient.getQueryState(walletA)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(walletB)?.isInvalidated).toBe(true);
    // The other operation's query must be untouched by a filter naming only
    // `getWallet`'s id.
    expect(queryClient.getQueryState(account)?.isInvalidated).toBe(false);
  });
});

describe('operationPathFilter', () => {
  it('narrows to one path-parameter set, leaving sibling resources of the same operation alone', () => {
    const queryClient = new QueryClient();
    const walletA = getWalletQueryKey({ path: { wallet_id: 'wallet_a' } });
    const walletB = getWalletQueryKey({ path: { wallet_id: 'wallet_b' } });

    queryClient.setQueryData(walletA, { ok: true });
    queryClient.setQueryData(walletB, { ok: true });

    queryClient.invalidateQueries(
      operationPathFilter(getWalletQueryKey, { wallet_id: 'wallet_a' }),
    );

    expect(queryClient.getQueryState(walletA)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(walletB)?.isInvalidated).toBe(false);
  });
});

describe('invalidateOperation / cancelOperation', () => {
  it('invalidateOperation invalidates every variant of the named operation', async () => {
    const queryClient = new QueryClient();
    const key = getWalletQueryKey({ path: { wallet_id: 'wallet_a' } });
    queryClient.setQueryData(key, { ok: true });

    await invalidateOperation(queryClient, getWalletQueryKey);

    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it('cancelOperation resolves without throwing when nothing is in flight', async () => {
    const queryClient = new QueryClient();
    await expect(cancelOperation(queryClient, getWalletQueryKey)).resolves.toBeUndefined();
  });
});

describe('invalidateFamily', () => {
  // When: the family fans out to only some of its operations — e.g. a
  // `Promise.all` is dropped for a sequential loop that silently swallows a
  // rejection, or a filter is built for one operation and reused for
  // another — real money/balance data would go stale on screen after a
  // mutation the family is supposed to cover.
  it('invalidates every operation query key in the family, not a subset', async () => {
    const queryClient = new QueryClient();
    // Two distinct operations in the `wallets` family — proves the fan-out
    // actually spans the family rather than only ever touching the first
    // entry (the bug a sequential loop with an early return would produce).
    const wallet = getWalletQueryKey({ path: { wallet_id: 'wallet_a' } });
    const balances = getWalletBalanceSummaryQueryKey({ path: { wallet_id: 'wallet_a' } });
    queryClient.setQueryData(wallet, { ok: true });
    queryClient.setQueryData(balances, { ok: true });

    await invalidateFamily(queryClient, 'wallets');

    expect(queryClient.getQueryState(wallet)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(balances)?.isInvalidated).toBe(true);
  });
});

describe('familyOperationFilters', () => {
  it('emits one filter per operation, matching familyOperationIds 1:1', () => {
    const filters = familyOperationFilters('cards');
    const ids = familyOperationIds('cards');
    expect(filters.length).toBe(ids.length);
    expect(filters.map(idOf)).toEqual(ids);
  });
});

describe('unionFamilies', () => {
  // When: composition regresses to concatenation without dedup — a consumer
  // unioning two overlapping families (e.g. `userStrategies` and
  // `userStrategiesTasks`, which deliberately share operations) would issue
  // a redundant filter per shared operation, which is harmless but signals
  // the primitive isn't doing the one thing this test is for: producing a
  // flat, deduplicated filter set safe to hand straight to
  // `invalidateQueries`.
  it('unions two groups into one deduplicated filter list', () => {
    const filters = unionFamilies('userStrategies', 'userStrategiesTasks');
    const ids = filters.map(idOf);

    expect(new Set(ids).size).toBe(ids.length);
    // Every id from both source families must be represented once.
    const expected = new Set([
      ...familyOperationIds('userStrategies'),
      ...familyOperationIds('userStrategiesTasks'),
    ]);
    expect(new Set(ids)).toEqual(expected);
  });

  it('is usable directly as invalidateQueries filters', async () => {
    const queryClient = new QueryClient();
    const wallet = getWalletQueryKey({ path: { wallet_id: 'wallet_a' } });
    const account = getAccountQueryKey({ path: { account_id: 'account_a' } });
    queryClient.setQueryData(wallet, { ok: true });
    queryClient.setQueryData(account, { ok: true });

    const filters = unionFamilies('wallets', 'accounts');
    await Promise.all(filters.map((filter) => queryClient.invalidateQueries(filter)));

    expect(queryClient.getQueryState(wallet)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(account)?.isInvalidated).toBe(true);
  });
});
