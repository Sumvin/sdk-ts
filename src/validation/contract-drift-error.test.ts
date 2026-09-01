import { describe, expect, it } from 'vitest';
import { isSumvinError } from '../errors/sumvin-error.js';
import { ContractDriftError, isContractDriftError } from './contract-drift-error.js';
import type { ContractDriftEvent } from './types.js';

const event: ContractDriftEvent = {
  operationKey: 'GET /v0/budgets/',
  tier: 'strict',
  reason: 'schema-mismatch',
  issues: [],
  value: { budgets: 'not-an-array' },
};

describe('isContractDriftError', () => {
  // When: this test goes red if the guard stops narrowing correctly — today
  // there is no guard at all, so a caller reaches for a bare `instanceof`;
  // this is the replacement.
  it('narrows a ContractDriftError instance to true, and anything else to false', () => {
    const error = new ContractDriftError(event);

    expect(isContractDriftError(error)).toBe(true);
    expect(isContractDriftError(new Error('plain'))).toBe(false);
    expect(isContractDriftError(undefined)).toBe(false);
    expect(isContractDriftError({ operationKey: 'duck-typed, not an instance' })).toBe(false);
  });
});

describe('ContractDriftError', () => {
  // When: this test goes red if ContractDriftError stops extending
  // SumvinError — the whole point of the funnel is that a caller doing
  // `isSumvinError(e)` catches a contract drift alongside an ApiError.
  it('is a SumvinError', () => {
    expect(isSumvinError(new ContractDriftError(event))).toBe(true);
  });
});
