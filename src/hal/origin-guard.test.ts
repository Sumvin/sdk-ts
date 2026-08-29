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
});
