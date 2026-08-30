/**
 * Integration tests for {@link installAuthInterceptor}, driven through a real
 * generated client and a scripted `fetch` — same harness shape as
 * `src/errors/interceptor.test.ts` / `src/validation/seam.test.ts`. Every
 * assertion reads the header actually sent on the wire (`fakeFetch`'s
 * captured `Request`), not an internal call count — this is the seam D2 is
 * built on: the auth interceptor mutates `request.headers` in place inside
 * `client.interceptors.request`, before `fetch` is invoked.
 */
import { describe, expect, it } from 'vitest';
import { createClient, createConfig } from '../generated/client/index.js';
import { listBudgets } from '../generated/sdk.gen.js';
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
});
