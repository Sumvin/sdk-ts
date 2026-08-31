import { describe, expect, it } from 'vitest';
import { HalTemplateError } from './errors.js';
import { expandTemplate } from './template.js';

// When: these go red if a `@hey-api/openapi-ts` upgrade (or a spec change)
// starts emitting an RFC 6570 expression form beyond level-1 simple string
// expansion — this module implements exactly that subset because it is
// exactly what `spec/openapi.json` emits (checked directly, not assumed).
describe('expandTemplate', () => {
  it('substitutes a single simple variable', () => {
    expect(expandTemplate('/v0/assets/{symbol}', { symbol: 'ETH' })).toBe('/v0/assets/ETH');
  });

  it('substitutes multiple variables in one href', () => {
    expect(
      expandTemplate('/v0/wallets/{wallet_id}/assets/{symbol}', {
        wallet_id: 'w_1',
        symbol: 'USDC',
      }),
    ).toBe('/v0/wallets/w_1/assets/USDC');
  });

  it('percent-encodes reserved characters in the substituted value', () => {
    // A transaction id containing a space and a slash must not be allowed to
    // introduce a stray path segment or break the URL — this is the one
    // property that makes template expansion a security-relevant transform,
    // not just string interpolation.
    const href = expandTemplate('/v0/transactions/{transaction_id}', {
      transaction_id: 'a b/c',
    });
    expect(href).toBe('/v0/transactions/a%20b%2Fc');
    expect(href).not.toContain(' ');
  });

  it('coerces number and boolean values to their string form before encoding', () => {
    expect(expandTemplate('/v0/budgets/{budget_id}', { budget_id: 42 })).toBe('/v0/budgets/42');
  });

  it('throws HalTemplateError naming every unresolved variable when required vars are missing', () => {
    let error: unknown;
    try {
      expandTemplate('/v0/wallets/{wallet_id}/assets/{symbol}', { wallet_id: 'w_1' });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(HalTemplateError);
    const templateError = error as HalTemplateError;
    expect(templateError.unresolved).toEqual(['symbol']);
    expect(templateError.href).toBe('/v0/wallets/{wallet_id}/assets/{symbol}');
  });

  it('throws when no vars are supplied at all, rather than emitting a literal brace', () => {
    expect(() => expandTemplate('/v0/assets/{symbol}', {})).toThrow(HalTemplateError);
  });

  it('treats an RFC 6570 expression form beyond level-1 simple expansion as unresolved', () => {
    // The vendored spec never emits `{?a,b}`/`{+var}`/etc (checked directly),
    // so this module doesn't implement them — but if one ever appeared, it
    // must fail loudly rather than being substituted incorrectly or left as
    // a literal brace in the outgoing URL.
    let error: unknown;
    try {
      expandTemplate('/v0/search{?q,limit}', { q: 'x', limit: 1 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HalTemplateError);
    expect((error as HalTemplateError).unresolved).toEqual(['?q,limit']);
  });

  it('leaves a href with no template expressions unchanged', () => {
    expect(expandTemplate('/v0/budgets/', {})).toBe('/v0/budgets/');
  });
});
