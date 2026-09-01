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
import { ApiError } from '../errors/api-error.js';
import { installErrorInterceptor } from '../errors/interceptor.js';
import { createClient, createConfig } from '../generated/client/index.js';
import { getIpa, listBudgets } from '../generated/sdk.gen.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { installAuthInterceptor } from './interceptor.js';
import { type AuthProvider, junoJwt, pintToken, sumvinPat } from './provider.js';

function clientWith(f: ReturnType<typeof fakeFetch>) {
  return createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
}

/**
 * Composes `installAuthInterceptor` with `installErrorInterceptor`, in the
 * same order `createSumvinClient` does (`src/client.ts`). Used only where a
 * test needs proof that a specific failure survives the FULL chain — the
 * 304-still-fails test and the redirect-refused-passthrough test both
 * exercise `installErrorInterceptor`'s `error instanceof ApiError` bypass,
 * not just the auth interceptor's own throw in isolation.
 */
function clientWithErrors(
  f: ReturnType<typeof fakeFetch>,
  providers: readonly AuthProvider[] = [],
) {
  const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
  installAuthInterceptor(client, providers);
  installErrorInterceptor(client);
  return client;
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
  // reconstructed with `redirect: 'manual'` (ENG-3486: 'error' is rejected
  // outright by Cloudflare Workers' workerd at `Request` construction, so
  // it can never be this SDK's own setting — see the interceptor's TSDoc).
  // -------------------------------------------------------------------
  it("when: this interceptor runs, this sets the outgoing Request's redirect mode to 'manual' — even with zero providers configured", async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, []);

    await listBudgets({ client });

    // When: this test goes red if a future change only reconstructs the
    // Request when `providers.length > 0` (an unauthenticated client still
    // deserves redirect-safety for whatever headers `createSumvinClient`'s
    // own `headers` option set — e.g. ENG-3425's required CLI `user-agent`)
    // — or if 'manual' ever regresses back to 'error', which workerd
    // rejects at construction on every single request.
    expect(f.last().redirect).toBe('manual');
  });

  it('when: a provider yields a token AND the request carries a JSON body, this preserves the body across the Request reconstruction needed to set redirect', async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, [sumvinPat('pat-123')]);

    // Raw `client.post` (not a typed SDK binding) — the point here is only
    // to prove `new Request(request, { redirect: 'manual' })` clones a body
    // that was already set, not to exercise a specific operation's schema.
    await client.post({ url: '/v0/rules/', body: { name: 'test-rule' } });

    expect(f.lastHeader('x-sumvin-pat')).toBe('pat-123');
    expect(f.last().redirect).toBe('manual');
    await expect(f.lastBody()).resolves.toEqual({ name: 'test-rule' });
  });

  it('when: the captured outgoing Request is cloned, redirect: "manual" survives the clone — not only the original instance (O2, verified against a real workerd/Node/Bun/Chromium fetch before this plan was written)', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);
    installAuthInterceptor(client, [sumvinPat('pat-123')]);

    await listBudgets({ client });

    const clone = f.last().clone();
    expect(clone.redirect).toBe('manual');
    expect(clone.headers.get('x-sumvin-pat')).toBe('pat-123');
  });

  // -------------------------------------------------------------------
  // ENG-3486 §4.2 — the response-side classifier's five outcomes, in the
  // order `classifyRedirectResponse` checks them. The refused/followed
  // split maps directly onto `ApiError.redirectOutcome`:
  //   refused-opaque, refused-status   -> redirectOutcome: 'refused'
  //   followed-cross-origin, followed-same-origin -> redirectOutcome: 'followed'
  // (never keyed off row numbers — the plan's original §4.2b draft had
  // that inverted before the F1 ordering fix; this file maps by OUTCOME
  // NAME, and every outcome below has its own assertion on the correct
  // side of the split, so swapping the mapping fails at least one test.)
  // -------------------------------------------------------------------
  describe('response-side redirect classification (redirect: "manual" never throws — every check happens here)', () => {
    it.each([300, 301, 302, 303, 305, 306, 307, 308])(
      'when: the response status is %i — the whole 300-399 band this API never legitimately returns, not only the five WHATWG-named redirect statuses — this refuses it: kind "redirect-refused", redirectOutcome "refused", status carried through',
      async (status) => {
        const f = fakeFetch([{ status }]);
        const client = clientWith(f);
        installAuthInterceptor(client, []);

        const { data, error } = await listBudgets({ client });

        expect(data).toBeUndefined();
        expect(error).toBeInstanceOf(ApiError);
        if (!(error instanceof ApiError)) throw new Error('unreachable');
        expect(error.kind).toBe('redirect-refused');
        expect(error.redirectOutcome).toBe('refused');
        expect(error.status).toBe(status);
        // When: this test goes red if the message ever claims "the API
        // redirected" instead of staying honest about the whole band —
        // 300/305/306 are anomalies here too, not genuine redirects.
        expect(error.message).toContain('no operation in this API returns');
      },
    );

    it('when: a status of 400 arrives (just outside the 300-399 band), the classifier leaves it untouched — the ordinary HTTP error path reports kind "http", never "redirect-refused"', async () => {
      const f = fakeFetch([{ status: 400, body: { title: 'Bad Request', detail: 'nope' } }]);
      const client = clientWithErrors(f);

      const { error } = await listBudgets({ client });

      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw new Error('unreachable');
      // When: this test goes red if the status-band upper bound is ever
      // widened from `< 400` to `<= 400`.
      expect(error.kind).toBe('http');
      expect(error.redirectOutcome).toBeUndefined();
    });

    it('when: response.type is "opaqueredirect" (what a real browser\'s redirect: "manual" surfaces for a refused redirect — O3/O6), this reports refused: kind "redirect-refused", redirectOutcome "refused", and never reads the redirect target', async () => {
      // Status deliberately 200, not a 3xx: this isolates the
      // `response.type === 'opaqueredirect'` predicate from the status-band
      // predicate below it. If the opaqueredirect check is ever removed, a
      // 200 falls through every remaining check untouched (no ApiError at
      // all) instead of masquerading as refused-status.
      const f = fakeFetch([{ status: 200, type: 'opaqueredirect' }]);
      const client = clientWith(f);
      installAuthInterceptor(client, []);

      const { error } = await listBudgets({ client });

      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw new Error('unreachable');
      expect(error.kind).toBe('redirect-refused');
      expect(error.redirectOutcome).toBe('refused');
      expect(error.status).toBe(200);
      expect(error.message).toContain('never contacted');
    });

    it('when: the response is an ordinary 200 with no redirect signal at all, the classifier leaves it untouched — no ApiError, data returned normally', async () => {
      const f = fakeFetch([{ status: 200, body: { data: [] } }]);
      const client = clientWith(f);
      installAuthInterceptor(client, []);

      const { data, error } = await listBudgets({ client });

      expect(error).toBeUndefined();
      expect(data).toEqual({ data: [] });
    });

    it('when: response.status is 304, the classifier does not treat it as a redirect (it sits inside the 3xx band, but a 304 is a conditional-GET success) — yet the call still fails, because 304 is not response.ok: kind "http", status 304, redirectOutcome left undefined', async () => {
      const f = fakeFetch([{ status: 304 }]);
      const client = clientWithErrors(f);

      const { data, error } = await listBudgets({ client });

      expect(data).toBeUndefined();
      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw new Error('unreachable');
      // When: this test goes red if the classifier ever starts treating 304
      // as a redirect (kind would become 'redirect-refused') OR if it
      // starts silently swallowing the 304 into a false success (error
      // would be undefined). Assert the exact shape, not just "an error
      // exists".
      expect(error.kind).toBe('http');
      expect(error.status).toBe(304);
      expect(error.redirectOutcome).toBeUndefined();
    });

    it('when: response.url reports a different origin than baseUrl (a rebuilding fetch already followed a cross-origin redirect), this reports followed-cross-origin: kind "redirect-refused", redirectOutcome "followed" — assume the credential is compromised', async () => {
      const f = fakeFetch([
        { status: 200, redirected: true, url: 'https://evil.example/whatever', body: { ok: true } },
      ]);
      const client = clientWith(f);
      installAuthInterceptor(client, [sumvinPat('pat-123')]);

      const { error } = await listBudgets({ client });

      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw new Error('unreachable');
      expect(error.kind).toBe('redirect-refused');
      expect(error.redirectOutcome).toBe('followed');
      expect(error.status).toBe(200);
      expect(error.message).toMatch(/compromised|rotate/);
      // When: this test goes red if the cross-origin check ever stops
      // firing and the response falls through to the same-origin check
      // instead — `redirectOutcome` alone would still read 'followed'
      // (both outcomes map to it), so the message's own wording is what
      // discriminates which of the two branches actually fired.
      expect(error.message).toContain('different origin');
    });

    it('when: response.redirected is true but response.url carries no cross-origin signal (a rebuilding fetch already followed a same-origin redirect), this reports followed-same-origin: kind "redirect-refused", redirectOutcome "followed"', async () => {
      const f = fakeFetch([{ status: 200, redirected: true, body: { ok: true } }]);
      const client = clientWith(f);
      installAuthInterceptor(client, []);

      const { error } = await listBudgets({ client });

      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw new Error('unreachable');
      expect(error.kind).toBe('redirect-refused');
      expect(error.redirectOutcome).toBe('followed');
      expect(error.message).toMatch(/compromised|rotate/);
      // When: this test goes red if the `response.redirected` check is
      // ever removed — a genuinely same-origin-redirected response (no
      // `url` override at all) would then fall all the way through to
      // "no redirect signal", and `error` would be undefined instead.
      expect(error.message).toContain('same origin');
    });

    // -----------------------------------------------------------------
    // ENG-3486 §4.2, F1: the single most dangerous predicate-ordering
    // detail in the plan. A response that is BOTH a leak signal AND a 3xx
    // status must be classified as the leak — never as a mere refusal.
    // -----------------------------------------------------------------
    it('when: status is 307 AND redirected is true AND url is cross-origin — an attacker whose own reply happens to itself be a 3xx (F1) — this reports followed-cross-origin, NEVER refused-status; the leak check must win over the status-band check', async () => {
      const f = fakeFetch([
        { status: 307, redirected: true, url: 'https://evil.example/again', body: { ok: true } },
      ]);
      const client = clientWith(f);
      installAuthInterceptor(client, []);

      const { error } = await listBudgets({ client });

      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw new Error('unreachable');
      // When: this test goes red if `classifyRedirectResponse` ever checks
      // the 300-399 status band before the origin/redirected leak checks —
      // a status-band-first classifier reports this exact response as
      // refused-status ("nothing leaked"), which is false: the credential
      // was already sent to https://evil.example on the first hop.
      expect(error.redirectOutcome).toBe('followed');
      expect(error.message).toMatch(/compromised|rotate/);
      expect(error.status).toBe(307);
    });

    // -----------------------------------------------------------------
    // ENG-3486 §4.2, F1 (adversarial-verification finding): the same
    // predicate-ordering mistake one status code over. An attacker's own
    // reply can be a 304 just as easily as a 307 — 304 is not evidence of
    // safety, only evidence of "not a redirect." A classifier that checks
    // 304 above the leak checks reports this exact response as
    // `undefined` (no ApiError at all — the strongest possible false
    // "nothing happened" signal), instead of `followed-cross-origin`.
    // -----------------------------------------------------------------
    it('when: status is 304 AND redirected is true AND url is cross-origin — an attacker whose own reply happens to be a 304 (F1, 304 variant) — this reports followed-cross-origin, NEVER undefined; the leak check must win over the 304 "not a redirect" check', async () => {
      const f = fakeFetch([{ status: 304, redirected: true, url: 'https://evil.example/again' }]);
      const client = clientWith(f);
      installAuthInterceptor(client, []);

      const { error } = await listBudgets({ client });

      // When: this test goes red if `classifyRedirectResponse` ever checks
      // `response.status === 304` before the origin/redirected leak
      // checks — a 304-first classifier returns `undefined` for this
      // exact response (no ApiError, no redirectOutcome, no signal to
      // rotate the credential), even though the credential was already
      // sent to https://evil.example on the first hop.
      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw new Error('unreachable');
      expect(error.kind).toBe('redirect-refused');
      expect(error.redirectOutcome).toBe('followed');
      expect(error.message).toMatch(/compromised|rotate/);
    });

    it('when: the auth interceptor throws a redirect-refused ApiError, this reaches result.error identity-equal through the FULL composed client (auth + error interceptors together) — not only when the auth interceptor is exercised in isolation', async () => {
      const f = fakeFetch([{ status: 302 }]);
      const client = clientWithErrors(f, [sumvinPat('pat-123')]);

      const { data, error } = await listBudgets({ client });

      expect(data).toBeUndefined();
      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw new Error('unreachable');
      // When: this test goes red if `installErrorInterceptor`'s `error
      // instanceof ApiError` passthrough (src/errors/interceptor.ts) is
      // ever narrowed or removed — without it, a 302 with no
      // ProblemDetail-shaped body would be re-parsed by `parseProblemBody`
      // into a generic kind: 'http' error, silently losing
      // 'redirect-refused' and `redirectOutcome` both.
      expect(error.kind).toBe('redirect-refused');
      expect(error.redirectOutcome).toBe('refused');
    });
  });
});
