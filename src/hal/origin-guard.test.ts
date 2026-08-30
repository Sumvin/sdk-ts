import { describe, expect, it } from 'vitest';
import type { Client } from '../generated/client/index.js';
import { createClient, createConfig } from '../generated/client/index.js';
import { HalOriginRefusedError } from './errors.js';
import { resolveRequestUrl } from './origin-guard.js';

function clientWith(baseUrl: string | undefined): Client {
  return createClient(createConfig({ baseUrl }));
}

describe('resolveRequestUrl', () => {
  it('allows a relative href unchanged, regardless of baseUrl', () => {
    const client = clientWith('https://api.test');
    expect(resolveRequestUrl(client, '/v0/budgets/')).toBe('/v0/budgets/');
  });

  it('allows a same-origin absolute href, reduced to path + search + hash', () => {
    const client = clientWith('https://api.test');
    expect(resolveRequestUrl(client, 'https://api.test/v0/budgets/?limit=5')).toBe(
      '/v0/budgets/?limit=5',
    );
  });

  // When: this test goes red if the guard ever starts allowing a
  // cross-origin absolute href through — the whole reason it exists.
  it('refuses a cross-origin absolute href', () => {
    const client = clientWith('https://api.test');
    expect(() => resolveRequestUrl(client, 'https://evil.example/v0/budgets/')).toThrow(
      HalOriginRefusedError,
    );
  });

  it('names the refused href and reason on a cross-origin refusal', () => {
    const client = clientWith('https://api.test');
    let error: unknown;
    try {
      resolveRequestUrl(client, 'https://evil.example/v0/budgets/');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HalOriginRefusedError);
    const originError = error as HalOriginRefusedError;
    expect(originError.href).toBe('https://evil.example/v0/budgets/');
    expect(originError.reasonDetail).toContain('evil.example');
    expect(originError.reasonDetail).toContain('api.test');
  });

  // When: this test goes red if the guard starts comparing against a
  // fallback origin (e.g. `location.origin`) instead of refusing outright —
  // a relative `baseUrl` (the app's `/api/proxy` case, per D5) has no origin
  // to compare against at all.
  it('refuses every absolute href when the client baseUrl is itself relative', () => {
    const client = clientWith('/api/proxy');
    expect(() => resolveRequestUrl(client, 'https://api.test/v0/budgets/')).toThrow(
      HalOriginRefusedError,
    );
  });

  it('refuses every absolute href when the client has no baseUrl configured', () => {
    const client = clientWith(undefined);
    expect(() => resolveRequestUrl(client, 'https://api.test/v0/budgets/')).toThrow(
      HalOriginRefusedError,
    );
  });

  // -----------------------------------------------------------------------
  // FIX 3 (adversarial verification pass): `new URL('//evil.example/x')`
  // throws without a base — no scheme — so `tryParseAbsoluteUrl` reports a
  // protocol-relative href as "relative", and it would otherwise fall
  // through the first branch of `resolveRequestUrl` UNCHANGED. It stayed
  // safe only because the generated client's own `getUrl`
  // (`generated/core/utils.gen.ts`) builds the final URL by STRING
  // CONCATENATION rather than `new URL(url, baseUrl)` — an implementation
  // detail of regenerated code this module has no control over. This guard
  // now refuses the shape outright instead of depending on that detail.
  // -----------------------------------------------------------------------
  it('refuses a protocol-relative href ("//host/path") outright, before it can fall through as "relative"', () => {
    const client = clientWith('https://api.test');
    // When: this test goes red if the guard ever again lets a
    // protocol-relative href fall through to `client.request` unchanged —
    // see the companion premise-pin test below for what that would mean.
    expect(() => resolveRequestUrl(client, '//evil.example/x')).toThrow(HalOriginRefusedError);
  });

  it('names the refused href and reason on a protocol-relative refusal', () => {
    const client = clientWith('https://api.test');
    let error: unknown;
    try {
      resolveRequestUrl(client, '//evil.example/x');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HalOriginRefusedError);
    const originError = error as HalOriginRefusedError;
    expect(originError.href).toBe('//evil.example/x');
    expect(originError.reasonDetail).toContain('protocol-relative');
  });

  it('refuses a protocol-relative href even when the client has no baseUrl at all', () => {
    // The protocol-relative check runs BEFORE the baseUrl/origin check —
    // there is no baseUrl-dependent escape hatch for this shape.
    const client = clientWith(undefined);
    expect(() => resolveRequestUrl(client, '//evil.example/x')).toThrow(HalOriginRefusedError);
  });

  // -----------------------------------------------------------------------
  // Premise pin, not a safety net (D5's own security note, made concrete):
  // `resolveRequestUrl` refuses a protocol-relative href before it can ever
  // reach the generated client, so this test's outcome no longer determines
  // this SDK's safety either way. It exists so a future `@hey-api/openapi-ts`
  // upgrade that swaps `getUrl`'s string concatenation for `new URL(url,
  // baseUrl)` resolution fails a test in THIS repo — loudly, in CI — instead
  // of silently changing what an unguarded href shape would have resolved
  // to.
  // -----------------------------------------------------------------------
  it("pins the generated client's own URL builder: a protocol-relative url resolves by string concatenation, not URL resolution", () => {
    const client = clientWith('https://api.test');

    const built = client.buildUrl({ url: '//evil.example/x' });

    // When: this test goes red the day `getUrl` starts resolving via `new
    // URL(url, baseUrl)` — the day this exact input WOULD become
    // `https://evil.example/x` if nothing guarded it.
    expect(built).toBe('https://api.test//evil.example/x');
    expect(new URL(built).origin).toBe('https://api.test');
  });
});
