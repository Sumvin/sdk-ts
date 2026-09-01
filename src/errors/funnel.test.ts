/**
 * Proves the actual thing `isSumvinError` exists for: one guard catching
 * both an {@link ApiError} and a strict-tier {@link ContractDriftError},
 * built through the same real composition `client.test.ts` uses
 * (`createSumvinClient` + `fakeFetch`) rather than hand-constructed error
 * objects — a hand-built `ContractDriftError` could never exercise the
 * interceptor bypass that keeps it out of `ApiError`'s hands in the first
 * place (see `interceptor.ts`'s TSDoc).
 */
import { describe, expect, it } from 'vitest';
import { createSumvinClient } from '../client.js';
import { getBudget, listBudgets } from '../generated/sdk.gen.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { isContractDriftError } from '../validation/contract-drift-error.js';
import { isApiError } from './api-error.js';
import { isSumvinError } from './sumvin-error.js';

const malformedBudgetList = { _links: {}, budgets: 'not-an-array', total: 0, offset: 0, limit: 20 };
const problemDetail = {
  type: 'about:blank',
  title: 'Unprocessable',
  status: 422,
  detail: 'budget_id must be a valid ULID',
  instance: '/v0/budgets/not-a-ulid',
  error_code: 'BUD-400-001',
};

describe('one funnel over ApiError and ContractDriftError', () => {
  // When: this test goes red if ContractDriftError's parent is ever reverted
  // to plain Error — a real strict-tier drift would then escape the funnel
  // a consumer wrote a single `isSumvinError` branch to catch.
  it('a single isSumvinError branch catches a real ApiError and a real strict-tier ContractDriftError', async () => {
    const problemClient = createSumvinClient({
      baseUrl: 'https://api.test',
      fetch: fakeFetch([{ status: 422, body: problemDetail }]).fetch,
    });
    const { error: apiError } = await getBudget({
      client: problemClient,
      path: { budget_id: 'not-a-ulid' },
    });

    const driftClient = createSumvinClient({
      baseUrl: 'https://api.test',
      fetch: fakeFetch([{ status: 200, body: malformedBudgetList }]).fetch,
    });
    const { error: driftError } = await listBudgets({ client: driftClient });

    // Neither branch is vacuous: both really did fail, and as DIFFERENT
    // families. `toBeDefined` + `not.toBe` alone would be satisfied by two
    // distinct `ApiError`s — which is exactly what this file would become if
    // the error interceptor stopped bypassing `ContractDriftError` and
    // rewrote it into a generic `ApiError` instead. Naming each family is
    // what makes the two-branch claim this file exists for falsifiable here,
    // rather than only in `client.test.ts`.
    expect(apiError).toBeDefined();
    expect(driftError).toBeDefined();
    expect(isApiError(apiError)).toBe(true);
    expect(isContractDriftError(driftError)).toBe(true);
    // Deliberately disjoint: a contract drift is a client-side validation
    // failure, not a request failure. If this ever flips to `true`, a
    // consumer's `isApiError` branch starts reading `status`/`errorCode`/
    // `problem` that are all `undefined` — a quiet misrender in place of a
    // loud miss.
    expect(isApiError(driftError)).toBe(false);

    for (const error of [apiError, driftError]) {
      expect(isSumvinError(error)).toBe(true);
    }
  });
});
