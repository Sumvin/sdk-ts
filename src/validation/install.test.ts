import { describe, expect, it, vi } from 'vitest';
import { createClient, createConfig } from '../generated/client/index.js';
import {
  deleteBudget,
  getBudget,
  getIpa,
  listAccounts,
  listBudgets,
} from '../generated/sdk.gen.js';
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

  // ---------------------------------------------------------------------
  // FIX 2 (posture check + adversarial verification, both reproduced this
  // independently): the generated client returns `{}` (or raw text/bytes)
  // WITHOUT ever calling `opts.responseValidator` for a 204, an explicit
  // `Content-Length: 0`, or a non-JSON `Content-Type` — so a strict
  // operation's schema was silently never consulted at all. Each case below
  // reproduces one of the passed-through rows from the finding and proves it
  // now fails closed instead.
  // ---------------------------------------------------------------------
  describe('a strict operation whose response the client would never hand to responseValidator', () => {
    it('fails closed on a 204 No Content, instead of the client synthesizing an unvalidated {}', async () => {
      const f = fakeFetch([{ status: 204 }]);
      const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
      const onContractDrift = vi.fn();
      installResponseValidation(client, { onContractDrift });

      const result = await listBudgets({ client });

      expect(result.data).toBeUndefined();
      expect(result.error).toBeInstanceOf(ContractDriftError);
      expect((result.error as ContractDriftError).reason).toBe('empty-or-non-json-response');
      expect((result.error as ContractDriftError).tier).toBe('strict');
      expect(onContractDrift).toHaveBeenCalledTimes(1);
    });

    it('fails closed on a 200 with an explicit Content-Length: 0', async () => {
      const f = fakeFetch([{ status: 200, headers: { 'content-length': '0' } }]);
      const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
      const onContractDrift = vi.fn();
      installResponseValidation(client, { onContractDrift });

      const result = await listBudgets({ client });

      expect(result.data).toBeUndefined();
      expect(result.error).toBeInstanceOf(ContractDriftError);
      expect((result.error as ContractDriftError).reason).toBe('empty-or-non-json-response');
      expect(onContractDrift).toHaveBeenCalledTimes(1);
    });

    it('fails closed on a 200 served as content-type: text/plain, even with a JSON-looking body', async () => {
      const f = fakeFetch([
        { status: 200, headers: { 'content-type': 'text/plain' }, body: validBudgetList },
      ]);
      const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
      const onContractDrift = vi.fn();
      installResponseValidation(client, { onContractDrift });

      const result = await listBudgets({ client });

      expect(result.data).toBeUndefined();
      expect(result.error).toBeInstanceOf(ContractDriftError);
      expect((result.error as ContractDriftError).reason).toBe('empty-or-non-json-response');
      expect(onContractDrift).toHaveBeenCalledTimes(1);
    });

    it('fails closed on a 200 served as content-type: application/octet-stream', async () => {
      const f = fakeFetch([
        {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: validBudgetList,
        },
      ]);
      const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
      const onContractDrift = vi.fn();
      installResponseValidation(client, { onContractDrift });

      const result = await listBudgets({ client });

      expect(result.data).toBeUndefined();
      expect(result.error).toBeInstanceOf(ContractDriftError);
      expect((result.error as ContractDriftError).reason).toBe('empty-or-non-json-response');
      expect(onContractDrift).toHaveBeenCalledTimes(1);
    });

    it('carries response metadata (status, content-type, content-length), not a body it never got to read', async () => {
      const f = fakeFetch([{ status: 204 }]);
      const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
      const onContractDrift = vi.fn();
      installResponseValidation(client, { onContractDrift });

      await listBudgets({ client });

      const event = onContractDrift.mock.calls[0]?.[0] as ContractDriftEvent;
      expect(event.value).toMatchObject({ status: 204 });
      expect(event.issues).toBeUndefined();
    });

    it('does NOT fire for an observe-tier operation — this rule is scoped to strict only', async () => {
      const f = fakeFetch([{ status: 204 }]);
      const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
      const onContractDrift = vi.fn();
      installResponseValidation(client, { onContractDrift });

      // listAccounts (GET /v0/accounts/) is observe-tier, not a
      // STRICT_OPERATIONS key. When: this test goes red if the bypass check
      // is ever hoisted above the tier check and starts failing observe-tier
      // calls closed too — observe never fails a call closed, by design.
      const result = await listAccounts({ client });

      // The exact placeholder the generated client synthesizes for an empty
      // observe-tier body isn't this rule's concern (it's whatever the
      // client's own 204 branch already does) — only that observe never
      // fails the call closed and never fires a drift event over it.
      expect(result.error).toBeUndefined();
      expect(onContractDrift).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // FIX 1 (fifth vector from the original strict-tier finding, reproduced
  // separately): a 200 `application/json` reply whose body is not valid
  // JSON at all. The generated client's own `JSON.parse(text)` throws
  // (`generated/client/client.gen.ts`'s `parseAs === 'json'` branch) BEFORE
  // it ever reaches `opts.responseValidator` — so, unguarded, this SDK's
  // validation layer never sees the response, `onContractDrift` never
  // fires, and the raw `SyntaxError` surfaces to the caller as a
  // status-200-reported-as-a-failure with no trace of what actually broke.
  // ---------------------------------------------------------------------
  describe('an operation whose 200 response body is not valid JSON at all', () => {
    it('fails a strict operation closed with its own reason, preserving the SyntaxError as cause, and fires the drift event', async () => {
      const f = fakeFetch([{ status: 200, body: '{not-valid-json' }]);
      const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
      const onContractDrift = vi.fn();
      installResponseValidation(client, { onContractDrift });

      const result = await getBudget({ client, path: { budget_id: 'b_1' } });

      expect(result.data).toBeUndefined();
      expect(result.error).toBeInstanceOf(ContractDriftError);
      const error = result.error as ContractDriftError;
      expect(error.operationKey).toBe('GET /v0/budgets/{budget_id}');
      expect(error.tier).toBe('strict');
      expect(error.reason).toBe('unparsable-json-response');
      expect(error.cause).toBeInstanceOf(SyntaxError);

      expect(onContractDrift).toHaveBeenCalledTimes(1);
      const event = onContractDrift.mock.calls[0]?.[0] as ContractDriftEvent;
      expect(event.reason).toBe('unparsable-json-response');
      expect(event.cause).toBeInstanceOf(SyntaxError);
    });

    it('fires onContractDrift for an observe-tier (but validated) operation too, without failing the call closed itself', async () => {
      // listAccounts (GET /v0/accounts/) is `observe` tier but IS a
      // VALIDATED_OPERATIONS entry (has a schema) — the case D4 describes
      // as "an unparseable body is a contract violation at any tier."
      const f = fakeFetch([{ status: 200, body: '{not-valid-json' }]);
      const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
      const onContractDrift = vi.fn();
      installResponseValidation(client, { onContractDrift });

      await listAccounts({ client });

      expect(onContractDrift).toHaveBeenCalledTimes(1);
      const event = onContractDrift.mock.calls[0]?.[0] as ContractDriftEvent;
      expect(event.operationKey).toBe('GET /v0/accounts/');
      expect(event.tier).toBe('observe');
      expect(event.reason).toBe('unparsable-json-response');
      expect(event.cause).toBeInstanceOf(SyntaxError);
    });
  });

  // ---------------------------------------------------------------------
  // FIX 2: a strict operation called with a deliberate `parseAs` override
  // against a perfectly good `200 application/json` reply still fails
  // closed (defensible — the SDK cannot validate what it did not parse as
  // JSON) but must not be reported under the SAME reason a genuinely
  // empty/non-JSON server reply gets — that would tell a consumer "my
  // server is misbehaving" when the truth is "my own call opted out of
  // JSON parsing."
  // ---------------------------------------------------------------------
  describe('a strict operation called with a deliberate parseAs override', () => {
    it('gets its own reason, distinct from a server-caused empty/non-JSON response', async () => {
      const f = fakeFetch([{ status: 200, body: validBudgetList }]);
      const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
      const onContractDrift = vi.fn();
      installResponseValidation(client, { onContractDrift });

      const result = await getBudget({ client, path: { budget_id: 'b_1' }, parseAs: 'text' });

      expect(result.data).toBeUndefined();
      expect(result.error).toBeInstanceOf(ContractDriftError);
      const error = result.error as ContractDriftError;
      expect(error.reason).toBe('parse-as-opts-out-of-json');
      expect(error.reason).not.toBe('empty-or-non-json-response');
      expect(error.tier).toBe('strict');

      expect(onContractDrift).toHaveBeenCalledTimes(1);
      const event = onContractDrift.mock.calls[0]?.[0] as ContractDriftEvent;
      expect(event.reason).toBe('parse-as-opts-out-of-json');
    });

    it('still reports the server-caused case under the original reason', async () => {
      // Unchanged control: content-type actually IS wrong (server-caused),
      // parseAs was left at its 'auto' default — this must keep the
      // original 'empty-or-non-json-response' reason.
      const f = fakeFetch([
        { status: 200, headers: { 'content-type': 'text/plain' }, body: validBudgetList },
      ]);
      const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
      const onContractDrift = vi.fn();
      installResponseValidation(client, { onContractDrift });

      const result = await getBudget({ client, path: { budget_id: 'b_1' } });

      expect((result.error as ContractDriftError).reason).toBe('empty-or-non-json-response');
    });
  });
});
