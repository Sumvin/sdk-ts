/**
 * Integration tests for {@link installAuthInterceptor}, driven through a real
 * generated client and a scripted `fetch` — same harness shape as
 * `src/errors/interceptor.test.ts` / `src/validation/seam.test.ts`. Every
 * assertion reads the header actually sent on the wire (`fakeFetch`'s
 * captured `Request`), not an internal call count — this is the seam D2 is
 * built on: the auth interceptor mutates `request.headers` in place inside
 * `client.interceptors.request`, before `fetch` is invoked.
 */
import { describe, expect, it, vi } from 'vitest';
import { createClient, createConfig } from '../generated/client/index.js';
import { getIpa, listBudgets } from '../generated/sdk.gen.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { installAuthInterceptor } from './interceptor.js';
import { junoJwt, pintToken, sumvinPat } from './provider.js';

function clientWith(f: ReturnType<typeof fakeFetch>) {
  return createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
}

describe('installAuthInterceptor', () => {
  it('when: a single provider yields a token, this sets exactly that header on the outgoing request', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, [sumvinPat('pat-123')]);

    await listBudgets({ client });

    expect(f.lastHeader('x-sumvin-pat')).toBe('pat-123');
    expect(f.lastHeader('x-juno-jwt')).toBeNull();
    expect(f.lastHeader('x-sumvin-pint-token')).toBeNull();
  });

  it('when: multiple providers each yield a token, this sets every header additively (PAT alongside PINT — the ENG-3386-proof case)', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, [sumvinPat('pat-123'), pintToken('pint-456')]);

    await listBudgets({ client });

    // When: this test goes red if a future change reintroduces a
    // one-scheme-per-request selector (Config.auth / per-operation
    // `security`) — D2 exists precisely so the server, which reads a base
    // credential unconditionally before any PINT header (ENG-3386), always
    // receives both.
    expect(f.lastHeader('x-sumvin-pat')).toBe('pat-123');
    expect(f.lastHeader('x-sumvin-pint-token')).toBe('pint-456');
  });

  it('when: three providers (juno-jwt, sumvin-pat, pint-token) all yield tokens, this sets all three headers', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, [
      junoJwt(() => 'jwt-abc'),
      sumvinPat('pat-123'),
      pintToken('pint-456'),
    ]);

    await listBudgets({ client });

    expect(f.lastHeader('x-juno-jwt')).toBe('jwt-abc');
    expect(f.lastHeader('x-sumvin-pat')).toBe('pat-123');
    expect(f.lastHeader('x-sumvin-pint-token')).toBe('pint-456');
  });

  it('when: a provider returns undefined, this skips that header silently rather than sending an empty/undefined value', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, [sumvinPat('pat-123'), pintToken(() => undefined)]);

    await listBudgets({ client });

    expect(f.lastHeader('x-sumvin-pat')).toBe('pat-123');
    expect(f.lastHeader('x-sumvin-pint-token')).toBeNull();
  });

  it('when: every provider returns undefined (fully logged out), this sends the request with none of the three auth headers set', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, [junoJwt(() => undefined), sumvinPat(() => undefined)]);

    await listBudgets({ client });

    expect(f.lastHeader('x-juno-jwt')).toBeNull();
    expect(f.lastHeader('x-sumvin-pat')).toBeNull();
  });

  it('when: a provider is backed by an async getter, this awaits it before the request is sent', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, [junoJwt(async () => 'jwt-async')]);

    await listBudgets({ client });

    expect(f.lastHeader('x-juno-jwt')).toBe('jwt-async');
  });

  it('when: no providers are configured, this leaves the request headers untouched', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, []);

    await listBudgets({ client });

    expect(f.lastHeader('x-juno-jwt')).toBeNull();
    expect(f.lastHeader('x-sumvin-pat')).toBeNull();
    expect(f.lastHeader('x-sumvin-pint-token')).toBeNull();
  });

  // -------------------------------------------------------------------
  // FIX 5 (posture check — bounding D2's additive blast radius): a
  // provider's optional `appliesTo` (`./provider.js`) lets a consumer keep
  // its header off operations it was never meant to reach.
  // -------------------------------------------------------------------
  it("when: a provider's appliesTo returns false for the operation being called, this skips setting its header — even though its token was resolved", async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    const getToken = vi.fn(() => 'pint-456');
    installAuthInterceptor(client, [
      sumvinPat('pat-123'),
      pintToken(getToken, { appliesTo: (operationKey) => operationKey !== 'GET /v0/budgets/' }),
    ]);

    await listBudgets({ client });

    // When: this test goes red if `appliesTo` ever gates whether `getToken`
    // is CALLED rather than whether its result is APPLIED — a provider with
    // side-effecting token fetches should still see one call per request.
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(f.lastHeader('x-sumvin-pat')).toBe('pat-123');
    expect(f.lastHeader('x-sumvin-pint-token')).toBeNull();
  });

  it("when: a provider's appliesTo returns true for the operation being called, this sets its header exactly as if appliesTo were absent", async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'ipa_123' } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, [
      pintToken('pint-456', { appliesTo: (operationKey) => operationKey !== 'GET /v0/budgets/' }),
    ]);

    await getIpa({ client, path: { ipa_id: 'ipa_123' } });

    expect(f.lastHeader('x-sumvin-pint-token')).toBe('pint-456');
  });

  it('when: no appliesTo is given, this applies to every operation — unchanged default behaviour', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, [pintToken('pint-456')]);

    await listBudgets({ client });

    expect(f.lastHeader('x-sumvin-pint-token')).toBe('pint-456');
  });

  // -------------------------------------------------------------------
  // FIX 1 (adversarial verification + posture check, both reproduced this
  // independently): `generated/client/client.gen.ts:86` hardcodes
  // `redirect: 'follow'`, and the fetch spec strips only Authorization /
  // Cookie / Proxy-Authorization across a cross-origin redirect — never a
  // custom `x-*` header, which is this SDK's entire auth scheme. See
  // `../client.test.ts` for the end-to-end proof against a REAL
  // cross-origin redirect (two local HTTP servers, real `fetch`) — this
  // file only proves the unit-level mechanism: every outgoing `Request` is
  // reconstructed with `redirect: 'error'`.
  // -------------------------------------------------------------------
  it("when: this interceptor runs, this sets the outgoing Request's redirect mode to 'error' — even with zero providers configured", async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, []);

    await listBudgets({ client });

    // When: this test goes red if a future change only reconstructs the
    // Request when `providers.length > 0` — an unauthenticated client (no
    // providers) still deserves redirect-safety for whatever headers
    // `createSumvinClient`'s own `headers` option set (e.g. ENG-3425's
    // required CLI `user-agent`).
    expect(f.last().redirect).toBe('error');
  });

  it('when: a provider yields a token AND the request carries a JSON body, this preserves the body across the Request reconstruction needed to set redirect', async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, [sumvinPat('pat-123')]);

    // Raw `client.post` (not a typed SDK binding) — the point here is only
    // to prove `new Request(request, { redirect: 'error' })` clones a body
    // that was already set, not to exercise a specific operation's schema.
    await client.post({ url: '/v0/rules/', body: { name: 'test-rule' } });

    expect(f.lastHeader('x-sumvin-pat')).toBe('pat-123');
    expect(f.last().redirect).toBe('error');
    await expect(f.lastBody()).resolves.toEqual({ name: 'test-rule' });
  });
});
