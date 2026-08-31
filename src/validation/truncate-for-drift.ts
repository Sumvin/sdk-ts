/** The longest JSON-encoded form a value may keep before being truncated. */
const MAX_CHARS = 2000;

/**
 * A best-effort, bounded view of a value for inclusion in a
 * {@link import('./types.js').ContractDriftEvent}.
 *
 * Response bodies feeding a validated operation can carry money amounts or
 * PII, or simply be large paginated lists — dumping one unbounded into a
 * caller's telemetry sink is the wrong default. This never throws: an
 * unserializable value (a circular reference, for instance) is reported as a
 * placeholder rather than letting the attempt to describe a contract
 * violation raise a second, unrelated one.
 */
export function truncateForDrift(value: unknown): unknown {
  let json: string;
  try {
    const stringified = JSON.stringify(value);
    json = stringified === undefined ? String(value) : stringified;
  } catch {
    return '[unserializable value]';
  }

  if (json.length <= MAX_CHARS) {
    return value;
  }

  return `${json.slice(0, MAX_CHARS)}…[truncated, ${json.length} chars total]`;
}
