import { describe, expect, it } from 'vitest';
import { STRICT_OPERATIONS } from './strict-operations.js';
import { VALIDATED_OPERATIONS } from './validated-operations.js';

describe('VALIDATED_OPERATIONS coverage of STRICT_OPERATIONS', () => {
  // When: this goes red the moment any of the 17 strict keys loses its
  // VALIDATED_OPERATIONS entry — a rename, a typo introduced during a future
  // edit, or a schema dropped for being "unused" without checking here first.
  // `installResponseValidation` degrades a strict-but-unresolved key to a
  // reported-and-failed-closed `strict-operation-unvalidated` event rather
  // than silently passing unvalidated data, but this test exists so that
  // degradation is caught in CI before it ever reaches that fallback — a
  // strict money operation should never rely on the fallback to stay safe.
  it('every STRICT_OPERATIONS key resolves to a VALIDATED_OPERATIONS schema', () => {
    const strictKeys = Object.keys(STRICT_OPERATIONS);
    expect(strictKeys).toHaveLength(17);

    const unresolved = strictKeys.filter((key) => !(key in VALIDATED_OPERATIONS));
    expect(unresolved).toEqual([]);
  });
});
