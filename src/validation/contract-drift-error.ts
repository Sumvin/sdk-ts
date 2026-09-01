import { SumvinError } from '../errors/sumvin-error.js';
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
 * `onContractDrift` received — including `event.cause` (e.g. the
 * `SyntaxError` behind an `'unparsable-json-response'`), threaded through as
 * the standard `Error.cause` rather than a bespoke field.
 */
export class ContractDriftError extends SumvinError {
  readonly operationKey: string;
  readonly tier: ContractDriftEvent['tier'];
  readonly reason: ContractDriftEvent['reason'];
  /**
   * Every issue Zod's `safeParse` reported for the mismatch. Only
   * `invalid_type`'s `received` field is guaranteed to be a type name (e.g.
   * `"string"`) — for other issue codes, `received`/`expected`-shaped fields
   * may echo back actual data from the response. Treat this the same way as
   * {@link ContractDriftError.value}: fine for a developer console or a
   * server-side log with access controls, never for a rendered error
   * envelope or a client-side/third-party log sink without redaction first.
   */
  readonly issues: ContractDriftEvent['issues'];
  /**
   * A truncated — **not redacted** — view of the response body that failed
   * validation, capped at 2000 characters (`truncateForDrift`). Because the
   * cap is length-based, not field-aware, this can carry money amounts or
   * PII verbatim when the mismatched operation's response shape includes
   * them. This must never reach a rendered error envelope shown to an end
   * user, nor a log sink without redaction — see
   * `installErrorInterceptor`'s TSDoc for the credential-issuing-operation
   * case this same caution applies to.
   */
  readonly value: unknown;

  constructor(event: ContractDriftEvent) {
    super(
      `Contract drift on ${event.operationKey}: ${event.reason}`,
      event.cause !== undefined ? { cause: event.cause } : undefined,
    );
    this.name = 'ContractDriftError';
    this.operationKey = event.operationKey;
    this.tier = event.tier;
    this.reason = event.reason;
    this.issues = event.issues;
    this.value = event.value;
  }
}

/**
 * Narrows `x` to {@link ContractDriftError}. The normal way to check whether
 * a non-throwing result's `error` branch is a strict-tier contract-drift
 * failure rather than an {@link ApiError} — `isApiError` returns `false` for
 * a `ContractDriftError` and vice versa; the two are deliberately disjoint
 * (see `installErrorInterceptor`'s bypass). Narrow with {@link isSumvinError}
 * first to catch either family in one branch, then use this (or `isApiError`)
 * to tell them apart.
 *
 * @example
 * const result = await listBudgets({ client });
 * if (isContractDriftError(result.error)) {
 *   console.error(result.error.operationKey, result.error.reason);
 * }
 */
export function isContractDriftError(x: unknown): x is ContractDriftError {
  return x instanceof ContractDriftError;
}
