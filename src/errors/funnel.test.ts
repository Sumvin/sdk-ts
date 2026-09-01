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

    // Neither branch is vacuous: both really did fail, and differently.
    expect(apiError).toBeDefined();
    expect(driftError).toBeDefined();
    expect(apiError).not.toBe(driftError);

    for (const error of [apiError, driftError]) {
      expect(isSumvinError(error)).toBe(true);
    }
  });
});
