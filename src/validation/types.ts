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
 * - `empty-or-non-json-response` — a `response.ok` reply is one the generated
 *   client would never hand to a `responseValidator` at all, for a reason
 *   the SERVER caused: a `204`, an explicit `Content-Length: 0`, or (with
 *   `parseAs` left at its `'auto'` default) a `Content-Type` that resolves
 *   to anything other than `json` (`text/plain`, `application/octet-stream`,
 *   no `Content-Type` at all, …). Without this reason, a `schema-mismatch`
 *   check can never fire here — the schema is never even asked — so a
 *   `strict` operation would silently pass an empty `{}` or raw bytes
 *   through as if it had validated cleanly. Fires at **either** tier the
 *   same way `unparsable-json-response` does — a wrong-Content-Type or
 *   empty body is a contract violation regardless of severity — for
 *   `strict` operations and for any `observe`-tier operation that HAS a
 *   schema (i.e. is a `VALIDATED_OPERATIONS` entry); only `strict`
 *   additionally fails the call closed. `observe` is deliberately NOT
 *   extended to every possible operation, validated or not — same
 *   overhead-with-no-signal reasoning as `unparsable-json-response`.
 * - `parse-as-opts-out-of-json` — the SAME "never reaches `responseValidator`"
 *   situation as `empty-or-non-json-response`, but the CALLER caused it: an
 *   operation invoked with an explicit `parseAs: 'text' | 'blob' |
 *   'arrayBuffer' | 'formData' | 'stream'` against a perfectly good `200
 *   application/json` reply. A `strict` operation still fails closed (the
 *   SDK cannot validate what it did not parse as JSON); reporting it under
 *   `empty-or-non-json-response` would tell a consumer "the server sent
 *   something wrong" when the truth is "this call opted out of JSON
 *   parsing" — a different remediation entirely. Fires at either tier under
 *   the same schema-presence rule as `empty-or-non-json-response` above.
 * - `unparsable-json-response` — a `response.ok` reply the generated client
 *   WILL attempt to `JSON.parse` (per `parseAs`/`Content-Type`, and not
 *   empty) whose body is not valid JSON at all. Found as the fifth vector of
 *   the original strict-tier finding: unguarded, `JSON.parse` throws inside
 *   the generated client's own parse step, before `opts.responseValidator`
 *   is ever called — so `onContractDrift` never fires and a `strict`
 *   operation's `SyntaxError` surfaces to the caller as a generic HTTP
 *   failure with the *response's* 2xx status misreported as the failure and
 *   the parse error discarded. Fires at **either** tier (an unparseable body
 *   is a contract violation regardless of severity); only `strict`
 *   additionally fails the call closed. The triggering `SyntaxError` is
 *   threaded through as {@link ContractDriftEvent.cause}.
 */
export type ContractDriftReason =
  | 'schema-mismatch'
  | 'strict-operation-unvalidated'
  | 'empty-or-non-json-response'
  | 'parse-as-opts-out-of-json'
  | 'unparsable-json-response';

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
   * The underlying error that triggered this event, when one exists.
   * Present only for `reason: 'unparsable-json-response'`, where it is
   * always the `SyntaxError` `JSON.parse` threw over the response body.
   * Threaded through to {@link ContractDriftError} as `Error.cause`.
   */
  readonly cause?: unknown;
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
