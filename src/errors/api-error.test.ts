import { describe, expect, it } from 'vitest';
import { ApiError, isApiError } from './api-error.js';

/** A stand-in credential value — asserted absent from every rendering below. */
const SENTINEL_CREDENTIAL = 'sentinel-credential-do-not-leak-9f3a1c';

/** Builds an ApiError carrying a request whose headers hold {@link SENTINEL_CREDENTIAL}. */
function errorWithCredential(): ApiError {
  const request = new Request('https://api.test/v0/budgets/', {
    headers: { 'x-sumvin-pat': SENTINEL_CREDENTIAL },
  });
  const response = new Response(null, { status: 500, statusText: 'Internal Server Error' });
  return new ApiError({ kind: 'http', message: 'boom', status: 500, request, response });
}

describe('ApiError', () => {
  // When: this test goes red if ApiError stops extending the built-in Error —
  // callers that `catch (e)` and check `e instanceof Error` (a very common
  // pattern) would stop recognizing it.
  it('is a genuine Error subclass', () => {
    const error = new ApiError({ kind: 'network', message: 'boom' });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.name).toBe('ApiError');
    expect(error.message).toBe('boom');
  });

  // When: this test goes red if a field goes missing from the constructor
  // wiring — each one is part of the documented contract callers branch on.
  it('carries every documented field through from its init object', () => {
    const problem = {
      type: 'about:blank',
      title: 'Unprocessable',
      status: 422,
      detail: 'bad input',
      instance: '/v0/user/ipa/ipa_123',
      error_code: 'IPA-422-001' as const,
    };
    const request = new Request('https://api.test/v0/user/ipa/ipa_123');
    const response = new Response(null, { status: 422 });

    const error = new ApiError({
      kind: 'problem',
      message: 'Unprocessable: bad input (IPA-422-001)',
      status: 422,
      problem,
      errorCode: 'IPA-422-001',
      traceId: 'trace-abc',
      request,
      response,
    });

    expect(error.kind).toBe('problem');
    expect(error.status).toBe(422);
    expect(error.problem).toBe(problem);
    expect(error.errorCode).toBe('IPA-422-001');
    expect(error.traceId).toBe('trace-abc');
    expect(error.request).toBe(request);
    expect(error.response).toBe(response);
  });

  // When: this test goes red if the transport-failure fields stop defaulting
  // to `undefined` — a caller checking `error.status === undefined` is how
  // "this was never an HTTP response" is meant to be detected (D3 / task item 3).
  it('leaves status, problem, errorCode, traceId, request and response undefined when omitted', () => {
    const error = new ApiError({ kind: 'abort', message: 'aborted' });

    expect(error.status).toBeUndefined();
    expect(error.problem).toBeUndefined();
    expect(error.errorCode).toBeUndefined();
    expect(error.traceId).toBeUndefined();
    expect(error.request).toBeUndefined();
    expect(error.response).toBeUndefined();
  });

  // When: this test goes red if `cause` stops propagating to the underlying
  // `Error` — the only thread back to the original thrown value (a raw fetch
  // rejection, a DOMException) for anyone debugging a network/abort failure.
  it('threads a `cause` through to the underlying Error', () => {
    const original = new TypeError('fetch failed');
    const error = new ApiError({ kind: 'network', message: 'wrapped', cause: original });

    expect(error.cause).toBe(original);
  });

  // -------------------------------------------------------------------
  // FIX 3 (adversarial verification, third pass): `ApiError.request`'s
  // TSDoc claimed two safety properties — "JSON.stringify was already
  // safe" and "confirmed by this file's own test, not assumed" — while
  // citing no test that existed. These are that test, for each rendering
  // path named in the TSDoc.
  // -------------------------------------------------------------------

  // When: this test goes red if JSON.stringify(error) ever starts
  // serializing header data — proving the TSDoc's "Request/Response expose
  // their fields through prototype getters, which JSON.stringify does not
  // serialize" claim, independent of the util.inspect.custom hook below.
  it('never leaks a credential header through JSON.stringify, independent of the util.inspect hook', () => {
    const error = errorWithCredential();

    const json = JSON.stringify(error);

    expect(json).not.toContain(SENTINEL_CREDENTIAL);
    // Not vacuous: request/response really are present on the serialized
    // error, just as empty objects — this is not passing because nothing
    // got serialized at all.
    expect(json).toContain('"request":{}');
    expect(json).toContain('"response":{}');
  });

  // When: this test goes red if `util.inspect(error)` (what `console.log`/
  // `console.error` call internally on Node.js and Bun) ever renders a
  // credential header — the exact claim the removed TSDoc line asserted
  // "on Node.js and Bun" without a test. Runtime-agnostic on purpose: this
  // repo's own battery only actually executes under Bun (`bun run test`),
  // but `node:util` is available under both, so this exercises the real
  // hook Node.js/Bun's console machinery looks up, not a re-implementation
  // of it.
  //
  // Covers the TSDoc's "console.error(error) / console.log(error) … are
  // safe" claim too, not just util.inspect: Node's Console.error/.log
  // implementation calls util.formatWithOptions on a non-string argument,
  // which looks up this same Symbol.for('nodejs.util.inspect.custom') hook
  // — there is exactly one rendering code path for both, and this is it.
  // Mutation-checked: a version of this test that instead spied on
  // console.error and re-derived the printed string via util.format(...args)
  // failed on the identical mutation, at the identical line, as this one —
  // it exercised no code this test doesn't already reach.
  it('renders request as only its method and URL via the util.inspect.custom hook, never headers', async () => {
    const { inspect } = await import('node:util');
    const error = errorWithCredential();

    const rendered = inspect(error);

    expect(rendered).not.toContain(SENTINEL_CREDENTIAL);
    expect(rendered).toContain('GET https://api.test/v0/budgets/');
    expect(rendered).toContain('(headers redacted)');
    expect(rendered).toContain('response: 500 Internal Server Error');
  });

  // When: this test goes red if console.dir(error) ever prints a credential
  // header. Reconstructed with `customInspect: false` — Node.js's own
  // console.dir explicitly bypasses a target's custom inspect function by
  // default (confirmed by running this file's reproduction directly under
  // both Node.js and Bun: Bun's console.dir DOES invoke the hook, Node's
  // does not — a genuine cross-runtime divergence). Either way, no leak
  // occurs: on Node the fallback rendering of a bare Request/Response still
  // shows no header data, for the same prototype-getter reason
  // JSON.stringify is safe. This test asserts the OUTCOME both runtimes
  // must share (`customInspect: false`, the stricter of the two — proving
  // safety even when the redaction hook is bypassed entirely), not the
  // mechanism, which they do not share.
  it('never writes a credential header via console.dir, even with the redaction hook bypassed entirely (Node.js default)', async () => {
    const { inspect } = await import('node:util');
    const error = errorWithCredential();

    const printed = inspect(error, { customInspect: false });

    expect(printed).not.toContain(SENTINEL_CREDENTIAL);
  });

  // When: this test goes red if the util.inspect.custom hook ever starts
  // firing from an ordinary, non-Node-specific coercion path (String(),
  // template-literal interpolation, .toString()) — the TSDoc's "inert on a
  // runtime with no concept of util.inspect" claim rests on nothing calling
  // this hook unless it explicitly looks it up via
  // Symbol.for('nodejs.util.inspect.custom'); a browser or edge runtime
  // never does that lookup, so ordinary stringification must fall back to
  // plain Error behaviour untouched by this class's redaction logic.
  it('leaves ordinary Error stringification (String(), template literals, .toString()) untouched by the inspect hook', () => {
    const error = errorWithCredential();

    expect(String(error)).toBe('ApiError: boom');
    expect(`${error}`).toBe('ApiError: boom');
    expect(error.toString()).toBe('ApiError: boom');
  });
});

describe('isApiError', () => {
  // When: this test goes red if the guard stops narrowing correctly —
  // callers use this exact pattern to decide whether `result.error` is safe
  // to read `.kind` / `.errorCode` off.
  it('narrows an ApiError instance to true, and anything else to false', () => {
    const error = new ApiError({ kind: 'http', message: 'nope' });

    expect(isApiError(error)).toBe(true);
    expect(isApiError(new Error('plain'))).toBe(false);
    expect(isApiError('nope')).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError({ kind: 'http', message: 'duck-typed, not an instance' })).toBe(false);
  });
});
