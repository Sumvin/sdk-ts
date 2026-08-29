/**
 * Integration tests for {@link unwrap} and {@link replayOutcome}, driven
 * through real generated operations against a scripted `fetch`.
 */
import { describe, expect, it } from 'vitest';
import { createClient, createConfig } from '../generated/client/index.js';
import { createIpa, getBudget } from '../generated/sdk.gen.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { isApiError } from './api-error.js';
import { installErrorInterceptor } from './interceptor.js';
import { replayOutcome } from './replay-outcome.js';
import { unwrap } from './unwrap.js';

function clientWith(f: ReturnType<typeof fakeFetch>) {
  const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
  installErrorInterceptor(client);
  return client;
}

describe('unwrap', () => {
  // When: this test goes red if unwrap stops returning `data` on the success
  // branch — the whole point of offering it as an alternative to
  // destructuring `{ data, error }` at every call site.
  it('returns `data` on the success branch', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'bud_1', name: 'Groceries' } }]);
    const client = clientWith(f);

    const budget = await getBudget({ client, path: { budget_id: 'bud_1' } }).then(unwrap);

    expect(budget).toEqual({ id: 'bud_1', name: 'Groceries' });
  });

  // When: this test goes red if unwrap stops throwing on the error branch —
  // that's the entire reason flow code reaches for it instead of the
  // non-throwing `{ data, error }` shape.
  it('throws the ApiError on the error branch', async () => {
    const f = fakeFetch([
      {
        status: 404,
        body: {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'no such budget',
          instance: '/v0/budgets/missing',
          error_code: 'BUD-404-001',
        },
      },
    ]);
    const client = clientWith(f);

    const result = await getBudget({ client, path: { budget_id: 'missing' } });

    let thrown: unknown;
    try {
      unwrap(result);
    } catch (e) {
      thrown = e;
    }

    expect(isApiError(thrown)).toBe(true);
    if (!isApiError(thrown)) throw new Error('unreachable');
    expect(thrown.errorCode).toBe('BUD-404-001');
  });
});

describe('replayOutcome', () => {
  // When: this test goes red if a fresh 202 ever reads as a replay — the
  // whole reason this function exists is to name the two outcomes correctly
  // off `response.status` (P6), since `createIpa`'s body is identical either
  // way.
  it('names a 202 as "created"', async () => {
    const f = fakeFetch([{ status: 202, body: { id: 'ipa_1', status: 'pending' } }]);
    const client = clientWith(f);

    const result = await createIpa({ client, body: { raw_intent: 'buy oat milk' } });

    expect(replayOutcome(result)).toBe('created');
  });

  it('names a 208 as "replayed"', async () => {
    const f = fakeFetch([{ status: 208, body: { id: 'ipa_1', status: 'pending' } }]);
    const client = clientWith(f);

    const result = await createIpa({ client, body: { raw_intent: 'buy oat milk' } });

    expect(replayOutcome(result)).toBe('replayed');
  });

  it('is undefined for any other status, including a plain success or an error', async () => {
    const success = fakeFetch([{ status: 200, body: { id: 'bud_1' } }]);
    const notFound = fakeFetch([{ status: 404 }]);

    const successResult = await getBudget({
      client: clientWith(success),
      path: { budget_id: 'bud_1' },
    });
    const errorResult = await getBudget({
      client: clientWith(notFound),
      path: { budget_id: 'bud_1' },
    });

    expect(replayOutcome(successResult)).toBeUndefined();
    expect(replayOutcome(errorResult)).toBeUndefined();
  });
});
