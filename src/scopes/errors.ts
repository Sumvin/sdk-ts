/**
 * Errors `src/scopes` throws.
 *
 * Local to this module by design — same rationale as `src/hal/errors.ts` and
 * `src/signing/errors.ts`: a scope string that cannot be read as a spend
 * ceiling is not an HTTP-shaped failure, so it gets its own typed error
 * instead of being forced through `ApiError`. `ScopeCeilingError` extends
 * `SumvinError` so `isSumvinError`/`instanceof SumvinError` still catches it
 * alongside every other SDK error family — a marker for one funnel, not a
 * normalization into `ApiError`'s shape.
 */
import { SumvinError } from '../errors/sumvin-error.js';

/**
 * Every reason {@link readScopeCeiling} can refuse a scope string. A closed
 * union rather than a free-form message, so a caller can branch on `reason`
 * without parsing prose:
 *
 * - `malformed-scope` — the scope name is not exactly five non-empty
 *   `:`-separated segments with `sr` in position 0 and `pint` in position 2,
 *   or the query string violates the API's grammar in a way
 *   `URLSearchParams` would silently accept: a repeated leading `?`, an
 *   empty `&`-separated segment (`&&`, a leading `&`, a trailing `&`), a
 *   segment with no `=`, or a duplicate/empty `max`, `currency`, or `asset`
 *   value. The reader is deliberately stricter than the API's last-wins
 *   handling of a duplicate key: rendering one value while the API enforces
 *   another is the defect class this reader exists to close.
 * - `invalid-amount` — the `max` value is not an unsigned, ASCII-digit
 *   decimal amount (`^[0-9]+(\.[0-9]+)?$`). This refuses exponents, a bare
 *   `.5` or `1.`, a leading `+` or `-`, embedded whitespace, a trailing
 *   newline, and non-ASCII digit characters (e.g. Arabic-Indic digits) that
 *   a `\d`-based check would accept.
 * - `ambiguous-denomination` — both `currency` and `asset` are present.
 * - `missing-denomination` — neither `currency` nor `asset` is present.
 * - `unknown-denomination` — `currency` is not a recognized ISO 4217 code,
 *   or `asset` is not a recognized symbol (including a `0x…` address) or
 *   carries a chain suffix that isn't `fiat` or a lowercase
 *   `[a-z0-9_-]+` token.
 * - `over-precise` — the amount's fractional part, after trimming trailing
 *   zeros, has more digits than the denomination's decimals allow. The
 *   amount is never truncated to fit; it is refused instead.
 *
 * @example
 * try {
 *   readScopeCeiling(scope);
 * } catch (e) {
 *   if (isScopeCeilingError(e)) {
 *     console.log(`scope "${e.scope}" refused: ${e.reason}`);
 *   }
 * }
 */
export type ScopeCeilingRefusal =
  | 'malformed-scope'
  | 'invalid-amount'
  | 'ambiguous-denomination'
  | 'missing-denomination'
  | 'unknown-denomination'
  | 'over-precise';

/**
 * Thrown by `readScopeCeiling` (see `./ceiling.js`) when a scope string
 * cannot be read as a display-unit spend ceiling. Carries the scope
 * verbatim, so a caller juggling several scopes from one Stamped Mandate can say which
 * one was refused without having threaded it through separately.
 *
 * @example
 * try {
 *   readScopeCeiling(scope);
 * } catch (e) {
 *   if (isScopeCeilingError(e)) {
 *     console.log(`could not read a ceiling for "${e.scope}" (${e.reason}): ${e.message}`);
 *   }
 * }
 */
export class ScopeCeilingError extends SumvinError {
  /** The scope string exactly as passed to `readScopeCeiling`, unmodified. */
  readonly scope: string;
  /** Which of {@link ScopeCeilingRefusal}'s cases this refusal is. */
  readonly reason: ScopeCeilingRefusal;

  constructor(scope: string, reason: ScopeCeilingRefusal, detail: string) {
    super(`refusing to read the spend ceiling of scope "${scope}": ${detail}`);
    this.name = 'ScopeCeilingError';
    this.scope = scope;
    this.reason = reason;
  }
}

/**
 * Narrows `x` to {@link ScopeCeilingError}. The normal way to tell a scope
 * refusal apart from any other {@link SumvinError} family — narrow with
 * {@link isSumvinError} first to catch every SDK error in one branch, then
 * use this to identify a scope-ceiling refusal specifically.
 *
 * @example
 * try {
 *   readScopeCeiling(scope);
 * } catch (e) {
 *   if (isScopeCeilingError(e)) {
 *     console.log(e.reason);
 *   }
 * }
 */
export function isScopeCeilingError(x: unknown): x is ScopeCeilingError {
  return x instanceof ScopeCeilingError;
}
