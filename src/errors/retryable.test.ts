import { describe, expect, it } from 'vitest';
import type { ApiErrorCode } from '../generated/types.gen.js';
import { ApiError, type ApiErrorKind } from './api-error.js';
import { isRetryableError, isRetryableErrorCode } from './retryable.js';

function problemError(errorCode: ApiErrorCode, status: number): ApiError {
  return new ApiError({
    kind: 'problem',
    message: errorCode,
    status,
    errorCode,
    problem: {
      type: `https://api.sumvin.com/errors/${errorCode}`,
      title: 'Problem',
      status,
      detail: 'detail',
      instance: '/v0/user/me/mandate-key/wallet',
      error_code: errorCode,
    },
  });
}

describe('isRetryableError', () => {
  // When: this goes red, a client retries a failure the API says no retry can
  // fix (a permanent 5xx), or strands a user on one it says is transient —
  // the per-code answer must come from the API's published map, not from the
  // HTTP status family. The PAR-* pairs are the mandate-key bind outcomes
  // sigil-app retries on.
  it.each<[ApiErrorCode, number, boolean]>([
    ['PAR-503-002', 503, true],
    ['PAR-409-002', 409, true],
    ['SYS-500-001', 500, true],
    ['PAR-502-004', 502, false],
    ['PAR-503-001', 503, false],
    ['PAR-409-004', 409, false],
  ])('a %s problem (HTTP %i) is retryable: %s', (code, status, expected) => {
    expect(isRetryableError(problemError(code, status))).toBe(expected);
  });

  // When: this goes red, a failure with no readable error code — a gateway
  // error page, a lost reply — is classified by the wrong rule: a transient
  // infra blip left terminal, or a cancellation retried behind the user's back.
  it.each<[ApiErrorKind, number | undefined, boolean]>([
    ['http', 502, true],
    ['http', 429, true],
    ['http', 404, false],
    ['network', undefined, true],
    ['abort', undefined, false],
    ['redirect-refused', 302, false],
  ])('a %s failure (status %s) is retryable: %s', (kind, status, expected) => {
    expect(isRetryableError(new ApiError({ kind, message: kind, status }))).toBe(expected);
  });

  // When: this goes red, a non-request error (a thrown bug, a contract-drift
  // failure) would be retried as if it were transient.
  it('never retries something that is not an ApiError', () => {
    expect(isRetryableError(new Error('bug'))).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe('isRetryableErrorCode', () => {
  // When: this goes red, a code the API added after this SDK was built is
  // assumed transient and retried — an unknown code must never be retried.
  it('treats a code this SDK does not know, or no code at all, as not retryable', () => {
    expect(isRetryableErrorCode('NEW-503-999')).toBe(false);
    expect(isRetryableErrorCode('toString')).toBe(false);
    expect(isRetryableErrorCode(undefined)).toBe(false);
  });
});
