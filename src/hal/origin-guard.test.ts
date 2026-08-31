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

  // -----------------------------------------------------------------------
  // FIX 1 (both re-verification passes, independently converged): a raw
  // `href.startsWith('//')` is a byte-prefix test. The WHATWG URL parser
  // strips leading C0 controls/space, removes ASCII tab/CR/LF from
  // ANYWHERE in the string, and treats `\` as `/` — none of which a raw
  // `startsWith` accounts for. Every spelling below resolves to a
  // different host under `new URL(href, base)` and walked straight past
  // the commit-5731f24 guard.
  // -----------------------------------------------------------------------
  describe('FIX 1: spellings that normalize to protocol-relative', () => {
    it.each([
      [' //evil.com/x', 'leading space'],
      ['\t//evil.com/x', 'leading tab'],
      ['\n//evil.com/x', 'leading newline'],
      ['\r\n//evil.com/x', 'leading CRLF'],
      ['\f//evil.com/x', 'leading form feed'],
      ['/\\evil.com/x', 'single backslash, normalizes to //'],
      ['\\\\evil.com\\x', 'double backslash, normalizes to //'],
      ['/\t/evil.com/x', 'tab between the slashes'],
    ])('refuses %j (%s)', (vector) => {
      const client = clientWith('https://api.test');
      // When: this test goes red if any of these spellings is ever again
      // treated as "relative" and handed to `client.request` unchanged.
      expect(() => resolveRequestUrl(client, vector)).toThrow(HalOriginRefusedError);
    });

    it('still refuses the already-covered literal spellings (no regression)', () => {
      const client = clientWith('https://api.test');
      for (const vector of ['///evil.com/x', '////evil.com/x', '//@evil.com/x']) {
        expect(() => resolveRequestUrl(client, vector)).toThrow(HalOriginRefusedError);
      }
    });

    it('does not refuse a legitimate absolute-path relative href', () => {
      const client = clientWith('https://api.test');
      expect(resolveRequestUrl(client, '/v0/budgets/')).toBe('/v0/budgets/');
    });

    // A relative href with no leading slash at all must keep working — the
    // fix must not turn every bare relative href into a false positive by,
    // say, trimming/rewriting hrefs that never had a leading slash.
    it('does not refuse a legitimate relative href with no leading slash', () => {
      const client = clientWith('https://api.test');
      expect(resolveRequestUrl(client, 'v0/budgets/')).toBe('v0/budgets/');
    });

    // -----------------------------------------------------------------------
    // Premise pin for the future the guard is defending against, not just
    // the present string-concatenation implementation detail: monkey-patch
    // resolution to `new URL(url, baseUrl)` (what a future `@hey-api`
    // upgrade could switch `getUrl` to) and confirm every one of the FIX 1
    // vectors is STILL refused under that model — i.e. the check does not
    // merely happen to work today, it holds under the actual threat model.
    // A legitimate relative href resolves to the SAME origin either way,
    // proving the fix does not over-refuse.
    // -----------------------------------------------------------------------
    it('holds under the future new URL(url, baseUrl) resolution model, not just the current string-concatenation one', () => {
      const baseUrl = 'https://api.test';
      const dangerous = [
        ' //evil.com/x',
        '\t//evil.com/x',
        '\n//evil.com/x',
        '\r\n//evil.com/x',
        '\f//evil.com/x',
        '/\\evil.com/x',
        '\\\\evil.com\\x',
        '/\t/evil.com/x',
        '//evil.com/x',
      ];
      for (const vector of dangerous) {
        // Under the future resolution model this WOULD cross origin if
        // nothing guarded it...
        expect(new URL(vector, baseUrl).origin).toBe('https://evil.com');
        // ...and the guard refuses it today, before that model is ever
        // reached.
        const client = clientWith(baseUrl);
        expect(() => resolveRequestUrl(client, vector)).toThrow(HalOriginRefusedError);
      }

      // A legitimate href resolves to the SAME origin under the future
      // model — the guard must not refuse this one.
      expect(new URL('/v0/budgets/', baseUrl).origin).toBe(baseUrl);
      const client = clientWith(baseUrl);
      expect(resolveRequestUrl(client, '/v0/budgets/')).toBe('/v0/budgets/');
    });
  });

  // -----------------------------------------------------------------------
  // FIX 2 (medium): `..` traversal in a relative href escapes a BFF
  // `baseUrl` path prefix. A relative href is handed to `client.request`
  // UNCHANGED (this module never parses it), so `../../evil` survives all
  // the way to the generated client's own string-concatenated
  // `${baseUrl}${pathUrl}` — which is THEN parsed as a URL by `fetch`, and
  // THAT is where the dot segments collapse: `/api/proxy/../../evil` -> a
  // request for `/evil`, off the proxy mount, with the app's cookies, at a
  // path the proxy never sees. This falsifies D5's own claim that the
  // prefix "keep[s] applying to a followed link exactly as it does to
  // every other call."
  // -----------------------------------------------------------------------
  describe('FIX 2: relative-href traversal past a baseUrl path prefix', () => {
    it('refuses a relative href whose ".." segments walk outside the baseUrl path prefix', () => {
      const client = clientWith('/api/proxy');
      expect(() => resolveRequestUrl(client, '../../evil')).toThrow(HalOriginRefusedError);
    });

    it('refuses a single-level escape too', () => {
      const client = clientWith('/api/proxy');
      expect(() => resolveRequestUrl(client, '../evil')).toThrow(HalOriginRefusedError);
    });

    it('names the href and the baseUrl prefix on refusal', () => {
      const client = clientWith('/api/proxy');
      let error: unknown;
      try {
        resolveRequestUrl(client, '../../evil');
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(HalOriginRefusedError);
      const originError = error as HalOriginRefusedError;
      expect(originError.href).toBe('../../evil');
      expect(originError.reasonDetail).toContain('/api/proxy');
    });

    it('still allows a legitimate relative href that stays inside the baseUrl path prefix', () => {
      const client = clientWith('/api/proxy');
      expect(resolveRequestUrl(client, '/v0/budgets/')).toBe('/v0/budgets/');
    });

    it('still allows a legitimate relative href with no leading slash', () => {
      const client = clientWith('/api/proxy');
      expect(resolveRequestUrl(client, 'v0/budgets/')).toBe('v0/budgets/');
    });

    // When baseUrl carries no path prefix (root, or absent), there is
    // nothing for a relative href to escape from — the same request lands
    // on the same origin either way, so this rule stays scoped to the case
    // it exists for.
    it('does not refuse traversal when the baseUrl has no path prefix to escape', () => {
      const client = clientWith('https://api.test');
      expect(resolveRequestUrl(client, '../../evil')).toBe('../../evil');
    });

    it('does not refuse traversal when the client has no baseUrl at all', () => {
      const client = clientWith(undefined);
      expect(resolveRequestUrl(client, '../../evil')).toBe('../../evil');
    });

    // Premise pin: prove the escape is real under how the generated client
    // actually builds the URL (string concatenation) plus how any URL
    // parser (fetch's own) then collapses dot segments — not an
    // implementation detail of this test file.
    it("pins the generated client's own concatenation: the escaped path is what buildUrl actually produces", () => {
      const client = clientWith('/api/proxy');
      const built = client.buildUrl({ url: '../../evil' });
      expect(built).toBe('/api/proxy/../../evil');
      // ...which is exactly the string a real fetch/Request call would
      // normalize to a path outside the proxy prefix.
      expect(new URL(built, 'https://example.test').pathname).toBe('/evil');
    });
  });
});
