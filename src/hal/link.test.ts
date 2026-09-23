import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createClient, createConfig } from '../generated/client/index.js';
import type { AssetResponse } from '../generated/index.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { ContractDriftError } from '../validation/contract-drift-error.js';
import { HalOriginRefusedError, HalRelNotFoundError, HalTemplateError } from './errors.js';
import { halOf } from './link.js';

// A real generated response shape (P1): `AssetResponse._links` is `AssetLinks`
// — `self: Link` plus an optional `price?: Link | null` and an
// `[key: string]: unknown` index signature. Exercising `halOf` against this
// (rather than a hand-rolled fixture) proves it works against what the spec
// actually emits, not an idealized shape.
const assetWithPrice: AssetResponse = {
  _links: {
    self: { href: '/v0/assets/eth' },
    price: { href: '/v0/assets/eth/price' },
  },
  asset: {
    symbol: 'ETH',
    name: 'Ether',
    asset_type: 'crypto',
    decimals: 18,
  },
};

const assetWithoutPrice: AssetResponse = {
  _links: { self: { href: '/v0/assets/usd' } },
  asset: { symbol: 'USD', name: 'US Dollar', asset_type: 'fiat', decimals: 2 },
};

describe('halOf: has/get', () => {
  it('has() is true and get() returns the typed Link for a present relation', () => {
    const hal = halOf(assetWithPrice);
    expect(hal.has('price')).toBe(true);
    expect(hal.get('price')).toEqual({ href: '/v0/assets/eth/price' });
  });

  it('has() is false and get() is undefined for an absent relation', () => {
    const hal = halOf(assetWithoutPrice);
    expect(hal.has('price')).toBe(false);
    expect(hal.get('price')).toBeUndefined();
  });

  it('self is always present on a real response shape', () => {
    const hal = halOf(assetWithPrice);
    expect(hal.has('self')).toBe(true);
    expect(hal.get('self')?.href).toBe('/v0/assets/eth');
  });

  it('treats a non-link-shaped _links entry as absent rather than throwing', () => {
    // A future backend bug (or a genuinely non-link `_links` entry some
    // response types carry) must not crash `has`/`get` — it should just
    // read as "not a link".
    const malformed = { _links: { self: { href: '/x' }, garbage: 'not-a-link', empty: null } };
    const hal = halOf(malformed);
    expect(hal.has('garbage')).toBe(false);
    expect(hal.has('empty')).toBe(false);
    expect(hal.get('garbage')).toBeUndefined();
  });
});

describe('halOf: follow', () => {
  it('follows a relative href through the configured client', async () => {
    const f = fakeFetch([{ status: 200, body: { symbol: 'ETH', price: '3000' } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    const result = await halOf(assetWithPrice).follow(client, 'price');

    expect(result).toEqual({ symbol: 'ETH', price: '3000' });
    expect(f.last().method).toBe('GET');
    expect(f.last().url).toBe('https://api.test/v0/assets/eth/price');
  });

  it('follows a same-origin absolute href', async () => {
    const f = fakeFetch([{ status: 200, body: { symbol: 'ETH', price: '3000' } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const absolute = {
      _links: { self: { href: 'https://api.test/v0/assets/eth/price' } },
    };

    const result = await halOf(absolute).follow(client, 'self');

    expect(result).toEqual({ symbol: 'ETH', price: '3000' });
    expect(f.last().url).toBe('https://api.test/v0/assets/eth/price');
  });

  // When: this goes red if the origin guard is ever bypassed for `follow` —
  // the security property the guard exists for. No request may reach `fetch`.
  it('refuses to follow a cross-origin absolute href, and never calls fetch', async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const crossOrigin = {
      _links: { self: { href: 'https://evil.example/v0/assets/eth' } },
    };

    await expect(halOf(crossOrigin).follow(client, 'self')).rejects.toBeInstanceOf(
      HalOriginRefusedError,
    );
    expect(f.calls).toHaveLength(0);
  });

  // When: this goes red if `follow` ever falls back to some ambient origin
  // (e.g. treating a relative baseUrl as same-origin) instead of refusing —
  // a browser client's `baseUrl: '/api/proxy'` case.
  it('refuses an absolute href when the client baseUrl is relative, and never calls fetch', async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const client = createClient(createConfig({ baseUrl: '/api/proxy', fetch: f.fetch }));
    const absolute = {
      _links: { self: { href: 'https://api.test/v0/assets/eth' } },
    };

    await expect(halOf(absolute).follow(client, 'self')).rejects.toBeInstanceOf(
      HalOriginRefusedError,
    );
    expect(f.calls).toHaveLength(0);
  });

  it('expands a templated href with the supplied vars, percent-encoding the value', async () => {
    const f = fakeFetch([{ status: 200, body: { transaction_id: 'a b/c' } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const withAction = {
      _links: {
        self: { href: '/v0/transactions/' },
        transaction: { href: '/v0/transactions/{transaction_id}', templated: true },
      },
    };

    await halOf(withAction).follow(client, 'transaction', { transaction_id: 'a b/c' });

    expect(f.last().url).toBe('https://api.test/v0/transactions/a%20b%2Fc');
  });

  it('rejects with HalTemplateError when a required template var is missing, and never calls fetch', async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const withAction = {
      _links: { transaction: { href: '/v0/transactions/{transaction_id}', templated: true } },
    };

    await expect(halOf(withAction).follow(client, 'transaction')).rejects.toBeInstanceOf(
      HalTemplateError,
    );
    expect(f.calls).toHaveLength(0);
  });

  it('rejects with HalRelNotFoundError, naming the available relations, and never calls fetch', async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    let error: unknown;
    try {
      await halOf(assetWithoutPrice).follow(client, 'price');
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(HalRelNotFoundError);
    expect((error as HalRelNotFoundError).rel).toBe('price');
    expect((error as HalRelNotFoundError).available).toEqual(['self']);
    expect(f.calls).toHaveLength(0);
  });

  it('uses the method named on the link, defaulting to GET when absent', async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const withAction = {
      _links: { approve: { href: '/v0/user/ipa/ipa_1/decision', method: 'PUT' } },
    };

    await halOf(withAction).follow(client, 'approve');

    expect(f.last().method).toBe('PUT');
  });
});

const priceSchema = z.object({ symbol: z.string(), price: z.string() });

describe('halOf: followValidated', () => {
  // When: this goes red if `followValidated` ever returns the raw body
  // unparsed (e.g. an unchecked cast in place of `schema.safeParse`) — the
  // whole point of this method over `follow()` is a real parse.
  it('returns the schema-parsed, typed body on a match', async () => {
    const f = fakeFetch([{ status: 200, body: { symbol: 'ETH', price: '3000' } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    const result = await halOf(assetWithPrice).followValidated(client, 'price', priceSchema);

    expect(result).toEqual({ symbol: 'ETH', price: '3000' });
    expect(f.last().url).toBe('https://api.test/v0/assets/eth/price');
  });

  // When: this goes red if a schema mismatch is ever allowed through
  // unparsed — i.e. if the implementation ever swaps `schema.safeParse` for
  // a cast, since a cast cannot fail no matter what `body` actually is.
  it('throws ContractDriftError naming the rel in operationKey on a schema mismatch', async () => {
    // `price` is a number here, not the string the schema declares.
    const f = fakeFetch([{ status: 200, body: { symbol: 'ETH', price: 3000 } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    let error: unknown;
    try {
      await halOf(assetWithPrice).followValidated(client, 'price', priceSchema);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ContractDriftError);
    const drift = error as ContractDriftError;
    expect(drift.operationKey).toBe('FOLLOW price');
    expect(drift.tier).toBe('strict');
    expect(drift.reason).toBe('schema-mismatch');
    expect(drift.issues?.length).toBeGreaterThan(0);
  });

  // When: this goes red if the origin guard is ever bypassed for
  // `followValidated`, or if the schema is consulted before the guard has
  // had a chance to refuse the request — the guard's security property
  // must hold on this entry point exactly as it does on `follow`.
  it('refuses a cross-origin href before the schema runs, and never calls fetch', async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const crossOrigin = {
      _links: { self: { href: 'https://evil.example/v0/assets/eth' } },
    };
    const schema = z.object({});
    const safeParse = vi.spyOn(schema, 'safeParse');

    await expect(halOf(crossOrigin).followValidated(client, 'self', schema)).rejects.toBeInstanceOf(
      HalOriginRefusedError,
    );

    expect(f.calls).toHaveLength(0);
    expect(safeParse).not.toHaveBeenCalled();
  });
});
