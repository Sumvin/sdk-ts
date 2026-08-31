/**
 * `@sumvin/sdk` validation — response-body contract checking, installed as a
 * response interceptor on the generated {@link Client} (see `./install.js`
 * for the seam and why it is shaped the way it is).
 *
 * Two independent maps decide behaviour: `VALIDATED_OPERATIONS` decides
 * *whether* a response is checked at all; `STRICT_OPERATIONS` decides, for
 * the subset that is, *how hard* a mismatch fails. Both are exported so a
 * consumer can override either wholesale or spread-and-override a subset —
 * see `./types.js`.
 */
export { ContractDriftError } from './contract-drift-error.js';
export { installResponseValidation } from './install.js';
export { STRICT_OPERATIONS } from './strict-operations.js';
export { truncateForDrift } from './truncate-for-drift.js';
export type {
  ContractDriftEvent,
  ContractDriftReason,
  ValidationOptions,
  ValidationTier,
} from './types.js';
export { VALIDATED_OPERATIONS } from './validated-operations.js';
