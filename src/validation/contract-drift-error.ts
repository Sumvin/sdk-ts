import type { ContractDriftEvent } from './types.js';

/**
 * Thrown by a `strict`-tier operation's response validator on a mismatch —
 * never thrown out of the SDK call itself. `throwOnError` stays `false`, so
 * the generated client catches this inside its own request try/catch and
 * surfaces it as `{ data: undefined, error: ContractDriftError }` with
 * `response.status` left untouched. That is what makes fail-closed
 * *expressible* as a normal result rather than something every caller must
 * wrap in try/catch — proven in `./seam.test.ts`.
 *
 * Carries the same fields as the {@link ContractDriftEvent} that was fired
 * alongside it, so a caller inspecting `result.error` has everything
 * `onContractDrift` received.
 */
export class ContractDriftError extends Error {
  readonly operationKey: string;
  readonly tier: ContractDriftEvent['tier'];
  readonly reason: ContractDriftEvent['reason'];
  readonly issues: ContractDriftEvent['issues'];
  readonly value: unknown;

  constructor(event: ContractDriftEvent) {
    super(`Contract drift on ${event.operationKey}: ${event.reason}`);
    this.name = 'ContractDriftError';
    this.operationKey = event.operationKey;
    this.tier = event.tier;
    this.reason = event.reason;
    this.issues = event.issues;
    this.value = event.value;
  }
}
