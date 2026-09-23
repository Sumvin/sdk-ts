import { describe, expect, it } from 'vitest';
import type { ApiErrorCode } from '../generated/types.gen.js';
import { ContractDriftError } from '../validation/contract-drift-error.js';
import { ApiError } from './api-error.js';
import { parseProblemBody } from './problem.js';
import { isRetryableError, isRetryableErrorCode } from './retryable.js';

/** A problem-kind ApiError built the way the error interceptor builds one. */
function problemError(status: number, errorCode: ApiErrorCode): ApiError {
  return parseProblemBody({
    body: {
      type: 'about:blank',
      title: 'Failed',
      status,
      detail: 'detail',
      instance: '/v0/test',
      error_code: errorCode,
    },
    status,
    request: undefined,
    response: new Response(null, { status }),
  });
}

/** An http-kind ApiError: a failure whose body carried no readable error code. */
function httpError(status: number | undefined): ApiError {
  return new ApiError({ kind: 'http', message: 'failed', status });
}

describe('isRetryableErrorCode', () => {
  // When: this test goes red if the suffix check stops distinguishing the two
  // halves of a code the API split in two, or if an unknown code or no code
  // at all is read as retryable.
  it('is true exactly for a code ending in -R', () => {
    expect(isRetryableErrorCode('IPA-424-002-R' satisfies ApiErrorCode)).toBe(true);
    expect(isRetryableErrorCode('IPA-424-004' satisfies ApiErrorCode)).toBe(false);
    expect(isRetryableErrorCode('SAF-409-003-R' satisfies ApiErrorCode)).toBe(true);
    expect(isRetryableErrorCode('SAF-409-001' satisfies ApiErrorCode)).toBe(false);
    expect(isRetryableErrorCode('ZZZ-503-999-R')).toBe(true);
    expect(isRetryableErrorCode('R-503-001')).toBe(false);
    expect(isRetryableErrorCode('PAR-503-002R')).toBe(false);
    expect(isRetryableErrorCode(undefined)).toBe(false);
  });

  // When: this goes red at typecheck if the vendored spec still carries a
  // pre-suffix code string — the renamed codes have no aliases.
  it('rejects a pre-suffix code at compile time', () => {
    // @ts-expect-error PAR-503-002 was renamed PAR-503-002-R; the old string is not an ApiErrorCode.
    const renamed: ApiErrorCode = 'PAR-503-002';
    expect(renamed).toBe('PAR-503-002');
  });
});

describe('isRetryableError', () => {
  // When: this test goes red if a problem's code stops deciding, including when
  // its HTTP status alone would say "retry" (a terminal 503).
  it('follows the error code for a problem, whatever the status', () => {
    expect(isRetryableError(problemError(424, 'IPA-424-002-R'))).toBe(true);
    expect(isRetryableError(problemError(424, 'IPA-424-004'))).toBe(false);
    expect(isRetryableError(problemError(409, 'SAF-409-003-R'))).toBe(true);
    expect(isRetryableError(problemError(409, 'SAF-409-001'))).toBe(false);
    expect(isRetryableError(problemError(503, 'KYC-503-003-R'))).toBe(true);
    expect(isRetryableError(problemError(503, 'KYC-503-002'))).toBe(false);
  });

  // When: this test goes red if a codeless HTTP failure stops retrying on 429
  // or on the bottom of the 5xx range, or starts retrying a plain 4xx or a
  // failure with no status.
  it('retries a codeless HTTP failure on 429 and 5xx only', () => {
    expect(isRetryableError(httpError(429))).toBe(true);
    expect(isRetryableError(httpError(500))).toBe(true);
    expect(isRetryableError(httpError(503))).toBe(true);
    expect(isRetryableError(httpError(404))).toBe(false);
    expect(isRetryableError(httpError(undefined))).toBe(false);
  });

  // When: this test goes red if a transport failure changes its answer: a lost
  // request retries, a cancelled or refused-redirect request never does.
  it('retries a network failure but never an abort or a refused redirect', () => {
    expect(isRetryableError(new ApiError({ kind: 'network', message: 'lost' }))).toBe(true);
    expect(isRetryableError(new ApiError({ kind: 'abort', message: 'cancelled' }))).toBe(false);
    expect(
      isRetryableError(
        new ApiError({ kind: 'redirect-refused', message: 'refused', redirectOutcome: 'refused' }),
      ),
    ).toBe(false);
  });

  // When: this test goes red if something that is not a request failure is
  // treated as one worth resending.
  it('is false for anything that is not an ApiError', () => {
    const drift = new ContractDriftError({
      operationKey: 'GET /v0/budgets/',
      tier: 'strict',
      reason: 'schema-mismatch',
      issues: [],
      value: {},
    });
    expect(isRetryableError(drift)).toBe(false);
    expect(isRetryableError(new Error('boom'))).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});
