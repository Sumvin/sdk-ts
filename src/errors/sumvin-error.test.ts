import { describe, expect, it } from 'vitest';
import { DeviceLoginExpiredError } from '../auth/device.js';
import { HalRelNotFoundError } from '../hal/errors.js';
import { TypedDataPrecisionError } from '../signing/errors.js';
import { ContractDriftError } from '../validation/contract-drift-error.js';
import type { ContractDriftEvent } from '../validation/types.js';
import { ApiError } from './api-error.js';
import { isSumvinError, SumvinError } from './sumvin-error.js';

/** A minimal concrete subclass — `SumvinError` itself is abstract. */
class TestError extends SumvinError {
  // Not actually useless: without an explicit constructor here, TS treats
  // the (protected) SumvinError constructor as the one being invoked at
  // `new TestError(...)` call sites and refuses external callers.
  // biome-ignore lint/complexity/noUselessConstructor: exposes a protected base constructor publicly
  constructor(message: string) {
    super(message);
  }
}

describe('isSumvinError', () => {
  // When: this test goes red if the guard stops narrowing correctly — this
  // is the one check a consumer writes to catch every error family this SDK
  // throws, so a false negative here means the funnel misses a real instance.
  it('narrows a SumvinError subclass instance to true', () => {
    expect(isSumvinError(new TestError('boom'))).toBe(true);
    expect(isSumvinError(new ApiError({ kind: 'network', message: 'boom' }))).toBe(true);
  });

  // When: this test goes red if the guard starts accepting things that were
  // never thrown by this SDK — a plain Error, a duck-typed object shaped
  // like one, or `undefined` from an unset field. Mirrors the existing
  // `isApiError` pinning assertion in `api-error.test.ts`.
  it('is false for a plain Error, a duck-typed object, and undefined', () => {
    expect(isSumvinError(new Error('plain'))).toBe(false);
    expect(isSumvinError({ message: 'duck-typed, not an instance' })).toBe(false);
    expect(isSumvinError(undefined)).toBe(false);
    expect(isSumvinError(null)).toBe(false);
    expect(isSumvinError('nope')).toBe(false);
  });
});

describe('SumvinError', () => {
  // When: this test goes red if the base class stops extending the built-in
  // Error — every family relies on this for `instanceof Error` checks a
  // caller might already have in place.
  it('is a genuine Error subclass', () => {
    const error = new TestError('boom');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('boom');
  });

  // When: this test goes red if the `options`/`cause` parameter stops
  // reaching the underlying Error — the only thread back to an original
  // thrown value for a subclass that wants to preserve it.
  it('threads options.cause through to the underlying Error', () => {
    const original = new TypeError('root cause');
    class CausedError extends SumvinError {
      constructor() {
        super('wrapped', { cause: original });
      }
    }

    const withCause = new CausedError();
    const withoutCause = new TestError('no cause here');

    expect(withCause.cause).toBe(original);
    expect(withoutCause.cause).toBeUndefined();
  });
});

describe('SumvinError family membership', () => {
  const driftEvent: ContractDriftEvent = {
    operationKey: 'GET /v0/budgets/',
    tier: 'strict',
    reason: 'schema-mismatch',
    issues: [],
    value: undefined,
  };

  // When: this test goes red if any one of the SDK's five error families
  // stops extending SumvinError — a guard named `isSumvinError` that misses
  // one of them is a worse lie than no guard at all. One exact-set
  // assertion over a representative of each family, not one test per class.
  it('every error family this SDK throws or returns is a SumvinError', () => {
    const representatives: unknown[] = [
      new ApiError({ kind: 'network', message: 'boom' }),
      new ContractDriftError(driftEvent),
      new HalRelNotFoundError('approve', ['self']),
      new DeviceLoginExpiredError(),
      new TypedDataPrecisionError('amount', 1.5),
    ];

    expect(representatives.every((e) => isSumvinError(e))).toBe(true);
  });
});
