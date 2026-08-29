import { describe, expect, it } from 'vitest';
import { ApiError, isApiError } from './api-error.js';

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
