/**
 * Composed, end-to-end tests for {@link createSumvinClient} — the proof the
 * curated layer actually works TOGETHER, not just as isolated modules. Every
 * other test file in this repo exercises one installer against a bare
 * generated client; this one drives a single client built the way a real
 * consumer would build it, through `fakeFetch`, and inspects what actually
 * reaches (or comes back from) the wire.
 *
 * This file is also where a real composition defect was found and fixed:
 * `src/errors/interceptor.ts`'s bypass for `ContractDriftError` did not
 * exist until this test (`fails a strict operation closed…`) was written —
 * without it, `installErrorInterceptor` silently rewrote a fail-closed
 * `ContractDriftError` into a generic `ApiError`, because the two installers
 * share the SAME `interceptors.error` queue inside the generated client.
 * `src/validation/seam.test.ts` alone could never have caught this: it never
 * installs `installErrorInterceptor` in the same client.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createSumvinClient } from './client.js';
import { isApiError } from './errors/api-error.js';
import { getBudget, listAccounts, listBudgets } from './generated/sdk.gen.js';
import { fakeFetch } from './testing/fake-fetch.js';
import { ContractDriftError } from './validation/contract-drift-error.js';
import type { ContractDriftEvent } from './validation/types.js';

const validBudgetList = { _links: {}, budgets: [], total: 0, offset: 0, limit: 20 };
const malformedBudgetList = { _links: {}, budgets: 'not-an-array', total: 0, offset: 0, limit: 20 };
const validAccountList = { _links: {}, accounts: [], total: 0 };
const malformedAccountList = { _links: {}, accounts: 'not-an-array', total: 0 };

const problemDetail = {
  type: 'about:blank',
  title: 'Unprocessable',
  status: 422,
  detail: 'budget_id must be a valid ULID',
  instance: '/v0/budgets/not-a-ulid',
  error_code: 'BUD-400-001',
};

describe('createSumvinClient — composition', () => {
  it('when: two auth providers each yield a token, this sends both headers on the same request', async () => {
    const f = fakeFetch([{ status: 200, body: validBudgetList }]);
    const client = createSumvinClient({
      baseUrl: 'https://api.test',
      fetch: f.fetch,
      auth: [
        { header: 'x-sumvin-pat', getToken: () => 'pat-123' },
        { header: 'x-sumvin-pint-token', getToken: () => 'pint-456' },
      ],
    });

    await listBudgets({ client });

    expect(f.lastHeader('x-sumvin-pat')).toBe('pat-123');
    expect(f.lastHeader('x-sumvin-pint-token')).toBe('pint-456');
  });

  it('when: the server returns a full RFC 7807 problem, this normalizes it into an ApiError with the parsed fields', async () => {
    const f = fakeFetch([{ status: 422, body: problemDetail }]);
    const client = createSumvinClient({ baseUrl: 'https://api.test', fetch: f.fetch });

    const { data, error } = await getBudget({ client, path: { budget_id: 'not-a-ulid' } });

    expect(data).toBeUndefined();
    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) throw new Error('unreachable');
    expect(error.kind).toBe('problem');
    expect(error.errorCode).toBe('BUD-400-001');
    expect(error.status).toBe(422);
  });

  it('when: a strict operation returns a body that fails its schema, this fails the call closed as a ContractDriftError — NOT rewritten into a generic ApiError by the error interceptor — and fires onContractDrift', async () => {
    const f = fakeFetch([{ status: 200, body: malformedBudgetList }]);
    const onContractDrift = vi.fn();
    const client = createSumvinClient({
      baseUrl: 'https://api.test',
      fetch: f.fetch,
      validation: { onContractDrift },
    });

    const result = await listBudgets({ client });

    // When: this test goes red if installErrorInterceptor's ContractDriftError
    // bypass regresses — both installers share one `interceptors.error`
    // queue on the generated client, so without the bypass this becomes a
    // generic `ApiError` that has lost `operationKey`/`tier`/`reason`.
    expect(result.data).toBeUndefined();
    expect(result.error).toBeInstanceOf(ContractDriftError);
    expect(isApiError(result.error)).toBe(false);
    if (!(result.error instanceof ContractDriftError)) throw new Error('unreachable');
    expect(result.error.operationKey).toBe('GET /v0/budgets/');
    expect(result.error.tier).toBe('strict');
    expect(onContractDrift).toHaveBeenCalledTimes(1);
    const event = onContractDrift.mock.calls[0]?.[0] as ContractDriftEvent;
    expect(event.reason).toBe('schema-mismatch');
  });

  it('when: an observe-tier operation returns a body that fails its schema, this lets the data through unchanged and still fires onContractDrift', async () => {
    const f = fakeFetch([{ status: 200, body: malformedAccountList }]);
    const onContractDrift = vi.fn();
    const client = createSumvinClient({
      baseUrl: 'https://api.test',
      fetch: f.fetch,
      validation: { onContractDrift },
    });

    const result = await listAccounts({ client });

    expect(result.data).toEqual(malformedAccountList);
    expect(result.error).toBeUndefined();
    expect(onContractDrift).toHaveBeenCalledTimes(1);
    const event = onContractDrift.mock.calls[0]?.[0] as ContractDriftEvent;
    expect(event.tier).toBe('observe');
  });

  it('when: validation is not overridden, this is on by default (the ENG-3424 acceptance criterion — no `validation` option needed)', async () => {
    const f = fakeFetch([{ status: 200, body: validAccountList }]);
    const client = createSumvinClient({ baseUrl: 'https://api.test', fetch: f.fetch });

    const result = await listAccounts({ client });

    // A passing observe-tier body proves the validator actually ran and
    // matched — an unvalidated call could never distinguish this from a
    // client with no validation installed at all.
    expect(result.data).toEqual(validAccountList);
    expect(result.error).toBeUndefined();
  });

  it('when: timeoutMs is set and the request hangs past it, this aborts with an ApiError instead of hanging forever', async () => {
    // Never resolves on its own — only settles when its Request's (combined)
    // signal aborts. Models a server that never answers, so the ONLY thing
    // that can end this test is the timeout interceptor's AbortSignal.
    const hangingFetch = (async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason));
      });
    }) as typeof fetch;

    const client = createSumvinClient({
      baseUrl: 'https://api.test',
      fetch: hangingFetch,
      timeoutMs: 20,
    });

    const { data, error } = await getBudget({ client, path: { budget_id: 'x' } });

    expect(data).toBeUndefined();
    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) throw new Error('unreachable');
    // `AbortSignal.timeout` rejects with a `TimeoutError`, not an
    // `AbortError` — src/errors/transport.ts's `isAbortError` only matches
    // the latter, so this must land as 'network', never 'abort' (which
    // would misrepresent an involuntary timeout as an intentional cancel).
    expect(error.kind).toBe('network');
    // Message wording for a `TimeoutError` DOMException is runtime-specific
    // ("the operation timed out" on Node, "aborted due to timeout" on Bun) —
    // assert on the substring both phrasings share, not the exact sentence.
    expect(error.message.toLowerCase()).toContain('timeout');
  });

  it("when: headers are injected (ENG-3425's CLI user-agent requirement), this sends them on every request AND keeps the default Content-Type — merges, never replaces the whole header set", async () => {
    const f = fakeFetch([{ status: 200, body: validBudgetList }]);
    const client = createSumvinClient({
      baseUrl: 'https://api.test',
      fetch: f.fetch,
      headers: { 'user-agent': 'sumvin-cli/1.0.0' },
    });

    // When: this test goes red if a future change passes `options.headers`
    // straight into `createConfig({ headers })` — that replaces the whole
    // object (createConfig's own `{ headers: defaultHeaders, ...override }`
    // spread order), silently dropping `Content-Type` for every request
    // with a body the moment a consumer supplies any header of their own.
    // `client.getConfig().headers` is a real `Headers` instance by this
    // point (`createClient`'s own `mergeConfigs` converts it), so read it
    // through the `Headers` API rather than a plain-object match.
    const configHeaders = client.getConfig().headers as Headers;
    expect(configHeaders.get('content-type')).toBe('application/json');
    expect(configHeaders.get('user-agent')).toBe('sumvin-cli/1.0.0');

    await listBudgets({ client });
    expect(f.lastHeader('user-agent')).toBe('sumvin-cli/1.0.0');
  });

  it('when: called with the minimal required options (just baseUrl), this returns a working client with every curated behaviour installed', async () => {
    const f = fakeFetch([{ status: 200, body: validAccountList }]);
    const client = createSumvinClient({ baseUrl: 'https://api.test', fetch: f.fetch });

    const { data, error } = await listAccounts({ client });

    expect(error).toBeUndefined();
    expect(data).toEqual(validAccountList);
  });
});

/**
 * FIX 1 (adversarial verification + posture check, both reproduced this
 * independently): `generated/client/client.gen.ts:86` hardcodes
 * `redirect: 'follow'`, and the fetch spec strips only `Authorization`,
 * `Cookie`, and `Proxy-Authorization` across a cross-origin redirect — never
 * a custom `x-*` header, which is this SDK's ENTIRE auth scheme
 * (`x-juno-jwt`, `x-sumvin-pat`, `x-sumvin-pint-token`). `installAuthInterceptor`
 * (`src/auth/interceptor.ts`) now reconstructs every outgoing `Request` with
 * `redirect: 'error'`.
 *
 * `fakeFetch` cannot prove this: it is a single-hop scripted `fetch` that
 * never actually follows a `Location` header, so a `redirect: 'follow'` bug
 * would look identical to a fixed one under it. This test uses the REAL
 * global `fetch` against two real local HTTP servers — one standing in for
 * the API origin, one for an attacker's origin the API redirects to — so
 * the runtime's actual credential/redirect behaviour is what's on trial,
 * not a simulation of it.
 */
describe('createSumvinClient — cross-origin redirect (FIX 1)', () => {
  it('when: the API origin 302s a credentialed request to a different origin, this refuses to follow it — the attacker origin is never contacted, and the caller gets a legible network-kind ApiError', async () => {
    let attackerWasContacted = false;
    let attackerReceivedAuthHeaders: Record<string, string | undefined> | undefined;
    const attackerServer = createServer((req, res) => {
      attackerWasContacted = true;
      attackerReceivedAuthHeaders = {
        'x-sumvin-pat': req.headers['x-sumvin-pat'] as string | undefined,
        'x-sumvin-pint-token': req.headers['x-sumvin-pint-token'] as string | undefined,
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stolen: true }));
    });
    await new Promise<void>((resolve) => attackerServer.listen(0, '127.0.0.1', () => resolve()));
    const attackerPort = (attackerServer.address() as AddressInfo).port;

    const apiServer = createServer((_req, res) => {
      // The "API" 302s every request straight to the attacker's origin —
      // modelling a malicious or compromised API, an open-redirect
      // vulnerability on it, or a misconfigured proxy in front of it.
      res.writeHead(302, { location: `http://127.0.0.1:${attackerPort}/steal` });
      res.end();
    });
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', () => resolve()));
    const apiPort = (apiServer.address() as AddressInfo).port;

    try {
      const client = createSumvinClient({
        baseUrl: `http://127.0.0.1:${apiPort}`,
        auth: [
          { header: 'x-sumvin-pat', getToken: () => 'super-secret-pat' },
          { header: 'x-sumvin-pint-token', getToken: () => 'super-secret-pint' },
        ],
      });

      const { data, error } = await listBudgets({ client });

      // What the caller observes: not a silent "success" carrying stolen
      // data, and not an opaque shape either. `kind: 'network'` would be
      // satisfied by a DNS failure or a dropped connection just as well,
      // so asserting it would not distinguish a refused redirect from any
      // other transport fault — which is the whole thing this test exists
      // to prove happened. The refusal gets its own kind so a caller can
      // tell the two apart, and so can this assertion.
      expect(data).toBeUndefined();
      expect(isApiError(error)).toBe(true);
      if (!isApiError(error)) throw new Error('unreachable');
      expect(error.kind).toBe('redirect-refused');
      expect(error.message.toLowerCase()).toContain('redirect');

      // The credential never had the CHANCE to leak — the attacker origin
      // was never even connected to, let alone handed a header.
      expect(attackerWasContacted).toBe(false);
      expect(attackerReceivedAuthHeaders).toBeUndefined();
    } finally {
      await new Promise((resolve) => apiServer.close(resolve));
      await new Promise((resolve) => attackerServer.close(resolve));
    }
  });
});
