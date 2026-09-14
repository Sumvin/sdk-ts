/**
 * `src/scopes` — reading a PINT scope's display-unit spend ceiling (ENG-3594).
 *
 * `readScopeCeiling(scope)` parses a single scope string's `max` query
 * parameter and returns it in the same display-unit text the server's
 * signed statement shows, or `null` when the scope carries no ceiling. See
 * `ceiling.ts` and `errors.ts` for the full contract.
 */
export { readScopeCeiling, type ScopeCeiling } from './ceiling.js';
export { isScopeCeilingError, ScopeCeilingError, type ScopeCeilingRefusal } from './errors.js';
