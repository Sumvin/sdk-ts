import { describe, expect, it, vi } from 'vitest';
import { createClient, createConfig } from '../generated/client/index.js';
import { deleteBudget, getIpa, listAccounts, listBudgets } from '../generated/sdk.gen.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { ContractDriftError } from './contract-drift-error.js';
import { installResponseValidation } from './install.js';
import type { ContractDriftEvent } from './types.js';

const validBudgetList = { _links: {}, budgets: [], total: 0, offset: 0, limit: 20 };
const malformedBudgetList = { _links: {}, budgets: 'not-an-array', total: 0, offset: 0, limit: 20 };
const validAccountList = { _links: {}, accounts: [], total: 0 };
const malformedAccountList = { _links: {}, accounts: 'not-an-array', total: 0 };

describe('installResponseValidation', () => {
  it('when: a strict operation returns a body matching its schema, this passes data through with no drift event', async () => {
    const f = fakeFetch([{ status: 200, body: validBudgetList }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const onContractDrift = vi.fn();
    installResponseValidation(client, { onContractDrift });

    const result = await listBudgets({ client });

    expect(result.data).toEqual(validBudgetList);
    expect(result.error).toBeUndefined();
    expect(onContractDrift).not.toHaveBeenCalled();
  });

  it('when: a strict operation returns a body that fails its schema, this fails the call closed, fires drift, and leaves response.status untouched', async () => {
    const f = fakeFetch([{ status: 200, body: malformedBudgetList }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const onContractDrift = vi.fn();
    installResponseValidation(client, { onContractDrift });

    const result = await listBudgets({ client });

    expect(result.data).toBeUndefined();
    expect(result.error).toBeInstanceOf(ContractDriftError);
    expect((result.error as ContractDriftError).operationKey).toBe('GET /v0/budgets/');
    expect((result.error as ContractDriftError).tier).toBe('strict');
    expect((result.error as ContractDriftError).reason).toBe('schema-mismatch');
    expect(result.response?.status).toBe(200);
    expect(onContractDrift).toHaveBeenCalledTimes(1);
  });

  it('when: an observe-tier operation returns a body that fails its schema, this lets data through unchanged but still fires drift', async () => {
    const f = fakeFetch([{ status: 200, body: malformedAccountList }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const onContractDrift = vi.fn();
    installResponseValidation(client, { onContractDrift });

    const result = await listAccounts({ client });

    // Observe never fails the call closed — the malformed body still comes
    // back as `data`, unlike the strict case above.
    expect(result.data).toEqual(malformedAccountList);
    expect(result.error).toBeUndefined();
    expect(onContractDrift).toHaveBeenCalledTimes(1);
    const event = onContractDrift.mock.calls[0]?.[0] as ContractDriftEvent;
    expect(event.tier).toBe('observe');
    expect(event.reason).toBe('schema-mismatch');
  });

  it('when: an observe-tier operation returns a body matching its schema, this fires no drift event', async () => {
    const f = fakeFetch([{ status: 200, body: validAccountList }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const onContractDrift = vi.fn();
    installResponseValidation(client, { onContractDrift });

    const result = await listAccounts({ client });

    expect(result.data).toEqual(validAccountList);
    expect(onContractDrift).not.toHaveBeenCalled();
  });

  it('when: the operation has no entry in VALIDATED_OPERATIONS at all, this neither validates nor fires an event', async () => {
    const f = fakeFetch([{ status: 200, body: { anything: 'goes' } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const onContractDrift = vi.fn();
    installResponseValidation(client, { onContractDrift });

    // DELETE /v0/budgets/{budget_id} is neither validated nor strict — only
    // GET /v0/budgets/{budget_id} is in either map.
    const result = await deleteBudget({ client, path: { budget_id: 'b_1' } });

    expect(result.data).toEqual({ anything: 'goes' });
    expect(result.error).toBeUndefined();
    expect(onContractDrift).not.toHaveBeenCalled();
  });

  it('when: the response is a 4xx, this fires no spurious drift event even for a strict operation', async () => {
    const f = fakeFetch([
      {
        status: 422,
        body: {
          type: 'about:blank',
          title: 'Unprocessable',
          status: 422,
          detail: 'bad input',
          instance: '/v0/user/ipa/ipa_123',
          error_code: 'IPA-422-001',
        },
      },
    ]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const onContractDrift = vi.fn();
    installResponseValidation(client, { onContractDrift });

    // getIpa (GET /v0/user/ipa/{ipa_id}) is strict — without the
    // `response.ok` guard this would fire a drift event over an RFC 7807
    // problem body that was never meant to satisfy zGetIpaResponse.
    await getIpa({ client, path: { ipa_id: 'ipa_123' } });

    expect(onContractDrift).not.toHaveBeenCalled();
  });

  it('when: a strict key has no resolvable schema, this fires drift with the distinct reason and fails closed', async () => {
    const f = fakeFetch([{ status: 200, body: validBudgetList }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const onContractDrift = vi.fn();

    // Override both maps: a strict key with an empty operations map behind
    // it — the shape a real STRICT_OPERATIONS entry would be in if it ever
    // fell out of VALIDATED_OPERATIONS.
    installResponseValidation(client, {
      operations: {},
      strictOperations: { 'GET /v0/budgets/': 'test: exercising the no-schema path' },
      onContractDrift,
    });

    const result = await listBudgets({ client });

    expect(result.data).toBeUndefined();
    expect(result.error).toBeInstanceOf(ContractDriftError);
    expect((result.error as ContractDriftError).reason).toBe('strict-operation-unvalidated');
    expect((result.error as ContractDriftError).tier).toBe('strict');
    expect(onContractDrift).toHaveBeenCalledTimes(1);
    const event = onContractDrift.mock.calls[0]?.[0] as ContractDriftEvent;
    expect(event.reason).toBe('strict-operation-unvalidated');
    expect(event.issues).toBeUndefined();
  });

  it('when: a mismatch fires, this hands the hook actionable detail: operation, tier, zod issues, and the offending value', async () => {
    const f = fakeFetch([{ status: 200, body: malformedBudgetList }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const onContractDrift = vi.fn();
    installResponseValidation(client, { onContractDrift });

    await listBudgets({ client });

    expect(onContractDrift).toHaveBeenCalledTimes(1);
    const event = onContractDrift.mock.calls[0]?.[0] as ContractDriftEvent;
    expect(event.operationKey).toBe('GET /v0/budgets/');
    expect(event.tier).toBe('strict');
    expect(event.reason).toBe('schema-mismatch');
    expect(event.issues).toBeDefined();
    expect(event.issues?.length).toBeGreaterThan(0);
    // The path of the failing field is present — enough to act on without
    // re-parsing the whole body by hand.
    expect(event.issues?.some((issue) => issue.path.includes('budgets'))).toBe(true);
    expect(event.value).toEqual(malformedBudgetList);
  });

  it('overrides `operations` wholesale, not merged with the defaults', async () => {
    const f = fakeFetch([{ status: 200, body: { anything: 'goes' } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const onContractDrift = vi.fn();

    // listAccounts (GET /v0/accounts/) is `observe` tier by default (it is
    // not a STRICT_OPERATIONS key), so replacing `operations` wholesale with
    // an empty map — losing its default VALIDATED_OPERATIONS entry — simply
    // stops it being validated at all: no event, no failure, whatever the
    // default would have done with this body.
    installResponseValidation(client, { operations: {}, onContractDrift });

    const result = await listAccounts({ client });

    expect(result.data).toEqual({ anything: 'goes' });
    expect(onContractDrift).not.toHaveBeenCalled();
  });

  it('overrides `strictOperations` wholesale: dropping a key downgrades it to observe', async () => {
    const f = fakeFetch([{ status: 200, body: malformedBudgetList }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const onContractDrift = vi.fn();

    // GET /v0/budgets/ keeps its schema (default `operations`) but is no
    // longer in the (now-empty) strict set, so a mismatch fires the hook and
    // still lets the malformed body through instead of failing closed.
    installResponseValidation(client, { strictOperations: {}, onContractDrift });

    const result = await listBudgets({ client });

    expect(result.data).toEqual(malformedBudgetList);
    expect(result.error).toBeUndefined();
    expect(onContractDrift).toHaveBeenCalledTimes(1);
    const event = onContractDrift.mock.calls[0]?.[0] as ContractDriftEvent;
    expect(event.tier).toBe('observe');
  });
});
