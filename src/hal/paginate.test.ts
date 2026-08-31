import { describe, expect, it } from 'vitest';
import { createClient, createConfig } from '../generated/client/index.js';
import type { AssetListResponse } from '../generated/index.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { HalPaginationGuardError } from './errors.js';
import { paginate } from './paginate.js';

function page(overrides: Partial<AssetListResponse>): AssetListResponse {
  return {
    _links: { self: { href: '/v0/assets?offset=0' } },
    assets: [],
    total: 0,
    offset: 0,
    limit: 1,
    ...overrides,
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}

describe('paginate', () => {
  it('yields the first page directly, without a network call', async () => {
    const f = fakeFetch([{ status: 200, body: page({}) }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const first = page({ _links: { self: { href: '/v0/assets?offset=0' } } });

    const pages = await collect(paginate(client, first));

    expect(pages).toEqual([first]);
    expect(f.calls).toHaveLength(0);
  });

  it('walks _links.next until it is absent, yielding each page', async () => {
    const first = page({
      _links: {
        self: { href: '/v0/assets?offset=0' },
        next: { href: '/v0/assets?offset=1' },
      },
      assets: [{ symbol: 'ETH', name: 'Ether', asset_type: 'crypto', decimals: 18 }],
      offset: 0,
    });
    const second = page({
      _links: { self: { href: '/v0/assets?offset=1' } }, // no `next` -> terminates
      assets: [{ symbol: 'USD', name: 'US Dollar', asset_type: 'fiat', decimals: 2 }],
      offset: 1,
      total: 2,
    });
    const f = fakeFetch([{ status: 200, body: second }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    const pages = await collect(paginate(client, first));

    expect(pages).toEqual([first, second]);
    // Exactly one fetch: the first page was handed in directly, so only
    // walking to the second page issues a request.
    expect(f.calls).toHaveLength(1);
    expect(f.last().url).toBe('https://api.test/v0/assets?offset=1');
  });

  it('follows next through the same guarded follow (refuses a cross-origin next link)', async () => {
    const first = page({
      _links: {
        self: { href: '/v0/assets?offset=0' },
        next: { href: 'https://evil.example/v0/assets?offset=1' },
      },
    });
    const f = fakeFetch([{ status: 200, body: page({}) }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    const iter = paginate(client, first)[Symbol.asyncIterator]();
    await iter.next(); // first page, no fetch
    await expect(iter.next()).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  // When: this goes red if the cycle guard stops firing — an infinite
  // `for await` loop over a misbehaving server's pagination is the failure
  // mode this guards against.
  it('throws HalPaginationGuardError when next points back to an already-visited page', async () => {
    const first = page({
      _links: {
        self: { href: '/v0/assets?offset=0' },
        next: { href: '/v0/assets?offset=1' },
      },
    });
    const cyclingSecond = page({
      _links: {
        self: { href: '/v0/assets?offset=1' },
        next: { href: '/v0/assets?offset=0' }, // points back at the first page
      },
    });
    const f = fakeFetch([{ status: 200, body: cyclingSecond }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    const iter = paginate(client, first)[Symbol.asyncIterator]();
    await iter.next(); // yields `first`
    await iter.next(); // fetches + yields `cyclingSecond`

    await expect(iter.next()).rejects.toBeInstanceOf(HalPaginationGuardError);
    // Only the one legitimate hop (to `cyclingSecond`) — the cycle is
    // detected before a second request is ever issued.
    expect(f.calls).toHaveLength(1);
  });

  // When: this goes red if the AbortSignal is only decorative — the whole
  // point is that an aborted pagination stops issuing requests.
  it('stops and rejects once the signal is aborted, without issuing the next request', async () => {
    const first = page({
      _links: {
        self: { href: '/v0/assets?offset=0' },
        next: { href: '/v0/assets?offset=1' },
      },
    });
    const f = fakeFetch([{ status: 200, body: page({}) }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
    const controller = new AbortController();

    const iter = paginate(client, first, { signal: controller.signal })[Symbol.asyncIterator]();
    const firstResult = await iter.next();
    expect(firstResult.value).toEqual(first);

    controller.abort();

    await expect(iter.next()).rejects.toBeTruthy();
    expect(f.calls).toHaveLength(0);
  });
});
