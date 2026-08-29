import { describe, expect, it } from 'vitest';
import { truncateForDrift } from './truncate-for-drift.js';

describe('truncateForDrift', () => {
  it('when the JSON form fits under the cap, returns the value unchanged', () => {
    const value = { id: 'ipa_123', status: 'pending', amount: 42 };
    expect(truncateForDrift(value)).toEqual(value);
  });

  it('when the JSON form exceeds the cap, returns a bounded string carrying a prefix of it', () => {
    const value = { blob: 'x'.repeat(5000) };
    const result = truncateForDrift(value);

    // When: this goes red if a future change stops bounding the output size —
    // an unbounded dump of a response body is exactly what this helper exists
    // to prevent for a telemetry sink that may log money amounts or PII.
    expect(typeof result).toBe('string');
    expect((result as string).length).toBeLessThan(JSON.stringify(value).length);
    expect(result as string).toContain('"blob":"xxx');
  });

  it('when the value contains a circular reference, returns a safe placeholder instead of throwing', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    // When: this goes red if JSON.stringify's TypeError on a circular
    // structure ever escapes uncaught — a validator that throws while
    // building its own drift report would mask the real contract violation.
    expect(() => truncateForDrift(circular)).not.toThrow();
    expect(truncateForDrift(circular)).toBe('[unserializable value]');
  });
});
