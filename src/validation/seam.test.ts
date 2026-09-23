/**
 * Standing tests for the three runtime premises response validation is
 * built on. This file runs each probe against the real generated client and
 * a scripted `fetch`, so a `@hey-api/openapi-ts` upgrade that changes any of
 * this fails the build.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ResolvedRequestOptions } from '../generated/client/index.js';
import { createClient, createConfig } from '../generated/client/index.js';
import { getIpa, listBudgets } from '../generated/sdk.gen.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { STRICT_OPERATIONS } from './strict-operations.js';

// ---------------------------------------------------------------------------
// Probe 1 (P5): a response interceptor sees the un-substituted path template
// on `opts.url`, not the resolved request URL — that is what lets
// `${opts.method} ${opts.url}` key a validation-tier lookup by operation
// identity rather than by the caller's actual arguments.
// ---------------------------------------------------------------------------
describe('opts.url inside a response interceptor', () => {
  it('is the path template, braces intact, for an operation with a path parameter', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'ipa_123' } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    let captured: Pick<ResolvedRequestOptions, 'method' | 'url'> | undefined;
    client.interceptors.response.use((response, _request, opts) => {
      captured = { method: opts.method, url: opts.url };
      return response;
    });

    await getIpa({ client, path: { ipa_id: 'ipa_123' } });

    // When: this test goes red if a hey-api upgrade starts resolving `opts.url`
    // before the response interceptor runs — the operation-keyed validation
    // lookup reads exactly this field.
    expect(captured?.url).toBe('/v0/user/ipa/{ipa_id}');
    expect(captured?.method).toBe('GET');
    expect(`${captured?.method} ${captured?.url}`).toBe('GET /v0/user/ipa/{ipa_id}');

    // The template and the substituted request URL genuinely differ — proving
    // the interceptor is reading something distinct from what was fetched,
    // not merely echoing it back.
    expect(f.last().url).toContain('/v0/user/ipa/ipa_123');
    expect(f.last().url).not.toContain('{ipa_id}');
    expect(captured?.url).not.toBe(new URL(f.last().url).pathname);
  });

  it('is also the template for an operation with no path parameters', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    let captured: Pick<ResolvedRequestOptions, 'method' | 'url'> | undefined;
    client.interceptors.response.use((response, _request, opts) => {
      captured = { method: opts.method, url: opts.url };
      return response;
    });

    await listBudgets({ client });

    expect(captured?.url).toBe('/v0/budgets/');
    expect(captured?.method).toBe('GET');
    expect(`${captured?.method} ${captured?.url}`).toBe('GET /v0/budgets/');
    expect(f.last().url).toContain('/v0/budgets/');
  });
});

// ---------------------------------------------------------------------------
// Probe 2: the validation seam is `options.responseValidator`
// assigned from inside a response interceptor, guarded by `response.ok` — not
// `Config.responseValidator` (no per-operation context to key off) and not a
// body read inside the interceptor itself (proven below to break parsing).
// ---------------------------------------------------------------------------
describe('the validation seam', () => {
  it('runs a validator assigned from a response interceptor against the parsed body', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'ipa_123', status: 'pending' } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    let received: unknown;
    client.interceptors.response.use((response, _request, opts) => {
      if (response.ok) {
        opts.responseValidator = async (data) => {
          received = data;
        };
      }
      return response;
    });

    await getIpa({ client, path: { ipa_id: 'ipa_123' } });

    // When: this test goes red if the client starts handing the validator the
    // raw stream/Response instead of the already-decoded object — the
    // contract every tier's zod `safeParse` depends on.
    expect(received).toEqual({ id: 'ipa_123', status: 'pending' });
    expect(received).not.toBeInstanceOf(Response);
    expect(received).not.toBeUndefined();
  });

  it('surfaces a throwing validator as {data: undefined, error}, never as a thrown call, with response.status untouched', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'ipa_123' } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    const contractError = new Error('shape mismatch');
    client.interceptors.response.use((response, _request, opts) => {
      if (response.ok) {
        opts.responseValidator = async () => {
          throw contractError;
        };
      }
      return response;
    });

    // `throwOnError` defaults to false — this is what makes fail-closed
    // *expressible* as a normal result rather than a call the consumer must
    // wrap in try/catch. If this ever throws out of the call, the await
    // itself rejects and this test goes red for that reason.
    const result = await getIpa({ client, path: { ipa_id: 'ipa_123' } });

    expect(result.data).toBeUndefined();
    expect(result.error).toBe(contractError);
    expect(result.response?.status).toBe(200);
  });

  it('documents the failure mode of reading the body inside the interceptor instead of the seam', async () => {
    const f = fakeFetch([{ status: 200, body: { id: 'ipa_123' } }]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    // The naive alternative to `options.responseValidator`: read the body
    // directly inside the interceptor to inspect/validate it there. This
    // consumes the stream before the client's own `response.text()` /
    // `response.json()` parse runs.
    client.interceptors.response.use(async (response, _request, _opts) => {
      if (response.ok) {
        await response.json();
      }
      return response;
    });

    const result = await getIpa({ client, path: { ipa_id: 'ipa_123' } });

    // Observed, not guessed: the client's own parse step throws once the body
    // has already been consumed, `throwOnError` is false so that surfaces as
    // an error result rather than a rejected promise, and no data comes back.
    // This is the negative that justifies the "assign responseValidator,
    // never read the body yourself" rule — a body-reading interceptor cannot
    // hand the client anything to parse.
    expect(result.data).toBeUndefined();
    expect(result.error).toBeInstanceOf(TypeError);
    expect((result.error as TypeError).message.toLowerCase()).toContain('body');
  });

  it('fires on a 4xx response too, which is why an `if (response.ok)` guard is load-bearing', async () => {
    const f = fakeFetch([
      {
        status: 422,
        body: {
          type: 'about:blank',
          title: 'Unprocessable',
          status: 422,
          detail: 'bad input',
          instance: '/v0/user/ipa/ipa_123',
          error_code: 'IPA-422-001',
        },
      },
    ]);
    const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));

    let sawResponse: { status: number; ok: boolean } | undefined;
    let validatorAssignedCount = 0;
    client.interceptors.response.use((response, _request, opts) => {
      sawResponse = { status: response.status, ok: response.ok };
      // Mirrors install.ts: only install the validator when `response.ok`. Proven
      // here by counting installs rather than asserting on validation
      // outcome, since a 4xx never reaches the parse-and-validate branch at
      // all (the client throws the deserialized error body first).
      if (response.ok) {
        validatorAssignedCount += 1;
        opts.responseValidator = async () => {};
      }
      return response;
    });

    await getIpa({ client, path: { ipa_id: 'ipa_123' } });

    // When: this test goes red if a future hey-api version stops invoking
    // response interceptors on non-2xx responses — the whole reason the
    // `response.ok` guard is necessary rather than decorative.
    expect(sawResponse).toEqual({ status: 422, ok: false });
    expect(validatorAssignedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Probe 3: the 17 STRICT_OPERATIONS keys are real operations, not typos
// carried over from the app's map. This only proves the key space is real —
// building the schema map itself (VALIDATED_OPERATIONS) is Wave A's job.
// ---------------------------------------------------------------------------
describe('STRICT_OPERATIONS key space', () => {
  const spec = JSON.parse(readFileSync('spec/openapi.json', 'utf-8')) as {
    paths: Record<string, Record<string, unknown>>;
  };

  it('has exactly 17 entries', () => {
    expect(Object.keys(STRICT_OPERATIONS)).toHaveLength(17);
  });

  it.each(Object.keys(STRICT_OPERATIONS))(
    '%s matches a real operation in the vendored spec',
    (key) => {
      const [method, pathTemplate] = key.split(/ (.+)/) as [string, string];
      const pathItem = spec.paths[pathTemplate];

      // When: this test goes red if a strict key is misspelled, or the
      // operation it names is renamed/removed upstream — a strict key that
      // resolves to nothing fails closed against an operation nobody calls.
      expect(pathItem, `no path "${pathTemplate}" in spec/openapi.json`).toBeDefined();
      expect(
        pathItem?.[method.toLowerCase()],
        `path "${pathTemplate}" has no "${method}" operation in spec/openapi.json`,
      ).toBeDefined();
    },
  );
});
