/**
 * Integration tests for {@link installErrorInterceptor}, driven through a real
 * generated client and generated operations against a scripted `fetch` — the
 * same harness shape `src/validation/seam.test.ts` uses. Every failure mode
 * the interceptor normalizes is exercised at its real seam: a request made
 * through the client, not a hand-built call to an internal parsing function.
 */
import { describe, expect, it } from 'vitest';
import { createClient, createConfig } from '../generated/client/index.js';
import { getBudget, listBudgets } from '../generated/sdk.gen.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { isApiError } from './api-error.js';
import { installErrorInterceptor } from './interceptor.js';

function clientWith(f: ReturnType<typeof fakeFetch>) {
  const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
  installErrorInterceptor(client);
  return client;
}

describe('installErrorInterceptor — RFC 7807 problem (tier 1)', () => {
  it('parses a full ProblemDetail body into a `problem`-kind ApiError', async () => {
    const f = fakeFetch([
      {
        status: 422,
        body: {
          type: 'about:blank',
          title: 'Unprocessable',
          status: 422,
          detail: 'budget_id must be a valid ULID',
          instance: '/v0/budgets/not-a-ulid',
          error_code: 'BUD-400-001',
          trace_id: 'trace-xyz',
        },
      },
    ]);
    const client = clientWith(f);

    const { data, error } = await getBudget({ client, path: { budget_id: 'not-a-ulid' } });

    expect(data).toBeUndefined();
    // When: this test goes red if the interceptor stops recognizing a
    // shape-complete body as a ProblemDetail — the whole point of P3 (the API
    // never sends `application/problem+json`, so detection has to be by shape).
    expect(isApiError(error)).toBe(true);
    if (!isApiError(error)) throw new Error('unreachable');
    expect(error.kind).toBe('problem');
    expect(error.status).toBe(422);
    expect(error.errorCode).toBe('BUD-400-001');
    expect(error.traceId).toBe('trace-xyz');
    expect(error.problem).toEqual({
      type: 'about:blank',
      title: 'Unprocessable',
      status: 422,
      detail: 'budget_id must be a valid ULID',
      instance: '/v0/budgets/not-a-ulid',
      error_code: 'BUD-400-001',
      trace_id: 'trace-xyz',
    });
    // Message is genuinely useful, not a stringified blob.
    expect(error.message).toContain('Unprocessable');
    expect(error.message).toContain('budget_id must be a valid ULID');
    expect(error.message).toContain('BUD-400-001');
    expect(error.request).toBeInstanceOf(Request);
    expect(error.response).toBeInstanceOf(Response);
  });

  it('leaves traceId undefined when the optional field is absent', async () => {
    const f = fakeFetch([
      {
        status: 404,
        body: {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'no such budget',
          instance: '/v0/budgets/x',
          error_code: 'BUD-404-001',
        },
      },
    ]);
    const client = clientWith(f);

    const { error } = await getBudget({ client, path: { budget_id: 'x' } });

    if (!isApiError(error)) throw new Error('expected an ApiError');
    expect(error.traceId).toBeUndefined();
  });
});

describe('installErrorInterceptor — title-only fallback (tier 2)', () => {
  it('falls back to the wire title/detail when error_code is missing (spec drift)', async () => {
    const f = fakeFetch([
      {
        status: 400,
        body: { title: 'Bad Request', detail: 'malformed query parameter' },
      },
    ]);
    const client = clientWith(f);

    const { error } = await listBudgets({ client });

    // When: this test goes red if a ProblemDetail-shaped body missing
    // `error_code` gets mis-detected as tier 1 — the CLI's own
    // `hasUsableTitle` fallback exists precisely for this spec-drift case.
    if (!isApiError(error)) throw new Error('expected an ApiError');
    expect(error.kind).toBe('http');
    expect(error.problem).toBeUndefined();
    expect(error.errorCode).toBeUndefined();
    expect(error.status).toBe(400);
    expect(error.message).toContain('Bad Request');
    expect(error.message).toContain('malformed query parameter');
  });

  it('uses the bare title when there is no usable detail', async () => {
    const f = fakeFetch([{ status: 400, body: { title: 'Bad Request' } }]);
    const client = clientWith(f);

    const { error } = await listBudgets({ client });

    if (!isApiError(error)) throw new Error('expected an ApiError');
    expect(error.message).toBe('Bad Request');
  });
});

describe('installErrorInterceptor — generic-by-status fallback (tier 3)', () => {
  it('produces a generic ApiError for a bare status with no body at all', async () => {
    const f = fakeFetch([{ status: 404 }]);
    const client = clientWith(f);

    const { data, error } = await listBudgets({ client });

    expect(data).toBeUndefined();
    if (!isApiError(error)) throw new Error('expected an ApiError');
    expect(error.kind).toBe('http');
    expect(error.status).toBe(404);
    expect(error.problem).toBeUndefined();
    expect(error.errorCode).toBeUndefined();
    // Genuinely useful, not empty and not a stringified blob (e.g. not `""`).
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message).toContain('404');
  });

  it('produces a generic ApiError for a non-JSON, non-ProblemDetail body', async () => {
    const f = fakeFetch([{ status: 502, body: 'upstream timeout', headers: {} }]);
    const client = clientWith(f);

    const { error } = await listBudgets({ client });

    if (!isApiError(error)) throw new Error('expected an ApiError');
    expect(error.kind).toBe('http');
    expect(error.status).toBe(502);
  });

  it('surfaces the generic tier as an HTTP 429/5xx retry hint distinct from a plain 4xx', async () => {
    const busy = fakeFetch([{ status: 503 }]);
    const notFound = fakeFetch([{ status: 404 }]);

    const { error: busyError } = await listBudgets({ client: clientWith(busy) });
    const { error: notFoundError } = await listBudgets({ client: clientWith(notFound) });

    if (!isApiError(busyError) || !isApiError(notFoundError)) {
      throw new Error('expected ApiErrors');
    }
    // Not asserting exact copy — just that the two are meaningfully different
    // messages, i.e. the generic tier isn't one flat string for every status.
    expect(busyError.message).not.toBe(notFoundError.message);
  });
});

describe('installErrorInterceptor — transport failures', () => {
  it('normalizes a thrown network error into a `network`-kind ApiError with status undefined', async () => {
    const networkFailure = new TypeError('fetch failed');
    const f = fakeFetch([{ throws: networkFailure }]);
    const client = clientWith(f);

    const { data, error } = await listBudgets({ client });

    expect(data).toBeUndefined();
    if (!isApiError(error)) throw new Error('expected an ApiError');
    expect(error.kind).toBe('network');
    expect(error.status).toBeUndefined();
    expect(error.problem).toBeUndefined();
    expect(error.response).toBeUndefined();
    expect(error.cause).toBe(networkFailure);
    expect(error.message).toContain('fetch failed');
  });

  it('normalizes an aborted request into a distinct `abort`-kind ApiError, never `network`', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    const f = fakeFetch([{ throws: abort }]);
    const client = clientWith(f);

    const { error } = await listBudgets({ client });

    // When: this test goes red if abort ever collapses into the same `kind`
    // as a genuine network failure — task item 3 requires the two stay
    // distinguishable so a caller can treat "user cancelled" as a non-error.
    if (!isApiError(error)) throw new Error('expected an ApiError');
    expect(error.kind).toBe('abort');
    expect(error.kind).not.toBe('network');
    expect(error.status).toBeUndefined();
    expect(error.cause).toBe(abort);
  });

  it('also treats a plain Error named AbortError as an abort, not a network failure', async () => {
    // Some runtimes/polyfills throw a plain Error with `.name === 'AbortError'`
    // instead of a DOMException — the guard must not be DOMException-specific.
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const f = fakeFetch([{ throws: abort }]);
    const client = clientWith(f);

    const { error } = await listBudgets({ client });

    if (!isApiError(error)) throw new Error('expected an ApiError');
    expect(error.kind).toBe('abort');
  });
});

describe('installErrorInterceptor — success paths are untouched', () => {
  it('never produces an ApiError for a 2xx response', async () => {
    const f = fakeFetch([{ status: 200, body: { data: [] } }]);
    const client = clientWith(f);

    const { data, error } = await listBudgets({ client });

    expect(error).toBeUndefined();
    expect(data).toEqual({ data: [] });
  });

  it('never produces an ApiError for a 204 response', async () => {
    const f = fakeFetch([{ status: 204 }]);
    const client = clientWith(f);

    const { data, error } = await listBudgets({ client });

    // Observed, not guessed: with no `Content-Type` header the generated
    // client's `getParseAs` falls back to `'stream'`, so `data` for a
    // bodyless 204 is `response.body` (`null`), not `{}`. The point of this
    // test is that `error` stays undefined — a 2xx never reaches the error
    // interceptor at all.
    expect(error).toBeUndefined();
    expect(data).toBeNull();
  });
});
