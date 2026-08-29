/**
 * The validation module's public shapes: the severity a validated operation
 * runs at, what a contract-drift event carries, and what
 * {@link installResponseValidation} accepts to override the module's
 * defaults.
 */
import type { ZodIssue, ZodType } from 'zod';

/**
 * `strict` fails the call closed on a mismatch — the caller receives
 * `{ data: undefined, error: ContractDriftError }` with `response.status`
 * untouched. `observe` fires {@link ValidationOptions.onContractDrift} and
 * lets the response through unchanged.
 *
 * Membership in `STRICT_OPERATIONS` (./strict-operations.js) selects
 * `strict`; every other operation present in `VALIDATED_OPERATIONS`
 * (./validated-operations.js) is `observe`. An operation absent from
 * `VALIDATED_OPERATIONS` entirely has no tier — it is not validated at all.
 */
export type ValidationTier = 'strict' | 'observe';

/**
 * Why a {@link ContractDriftEvent} fired.
 *
 * - `schema-mismatch` — the response body failed the Zod schema resolved for
 *   this operation.
 * - `strict-operation-unvalidated` — the operation is a `STRICT_OPERATIONS`
 *   key with no entry in `VALIDATED_OPERATIONS`, so there was no schema to
 *   check the response against at all. Reported (and, being `strict`,
 *   thrown) so a strict money operation can never silently pass unvalidated
 *   by falling out of the schema map — the drift hook fires exactly where a
 *   quieter failure mode would otherwise hide the gap.
 */
export type ContractDriftReason = 'schema-mismatch' | 'strict-operation-unvalidated';

/**
 * Fired by the installed validator on every mismatch, at either tier — the
 * hook ENG-3132 found was drafted in sumvin-app-v2 but never actually wired
 * to a response interceptor. This module wires it for real.
 */
export interface ContractDriftEvent {
  /** `METHOD /path/template`, e.g. `'GET /v0/budgets/'`. Never the substituted URL. */
  readonly operationKey: string;
  readonly tier: ValidationTier;
  readonly reason: ContractDriftReason;
  /** Present only for `reason: 'schema-mismatch'`. */
  readonly issues?: readonly ZodIssue[];
  /**
   * A safely-truncated view of the response body that triggered the event
   * (see `./truncate-for-drift.js`) — bounded because these bodies can carry
   * money amounts or PII and a raw dump is the wrong default for a
   * telemetry sink.
   */
  readonly value: unknown;
}

/**
 * Overrides for {@link installResponseValidation}. `operations` and
 * `strictOperations` each default to this module's own
 * `VALIDATED_OPERATIONS` / `STRICT_OPERATIONS` exports when omitted.
 *
 * Each map is replaced *wholesale* by whatever is passed here — there is no
 * automatic merge, because a merge cannot tell "I forgot this key" from "I
 * meant to remove it." To override a handful of keys while keeping every
 * other default, spread the exported default:
 * `{ operations: { ...VALIDATED_OPERATIONS, 'GET /v0/x': mySchema } }`.
 */
export interface ValidationOptions {
  /** Which operations are checked at all, and against which schema. */
  operations?: Readonly<Record<string, ZodType>>;
  /** Which of `operations`' keys fail closed; membership selects severity only. */
  strictOperations?: Readonly<Record<string, string>>;
  /** Fires on every validation mismatch, at either tier. */
  onContractDrift?: (event: ContractDriftEvent) => void;
}
