/**
 * `@sumvin/sdk/signing` — EIP-712 typed-data construction and the signing
 * ceremonies built on it: minting a PINT purchase intent and deciding an
 * errand's purchase approval.
 *
 * This subpath builds the typed data a wallet signs (`eth_signTypedData_v4`)
 * and orchestrates the request sequence around it; it does not sign
 * anything itself. Signing is always delegated to an injected
 * `signTypedData`-shaped function (a viem `WalletClient`, an EOA signer, a
 * Safe SDK — whatever the consumer already holds), typed as
 * {@link SignTypedDataFn}. `viem` is declared as an **optional peer
 * dependency** in `package.json` and is used **only in this module's own
 * tests** (to compute the parity typehashes in `typehash.test.ts`) — it is
 * never imported by any file in this bundled entry, so a consumer who never
 * signs anything never installs it.
 *
 * The one constraint this subpath must never violate: `scopes`, `resources`,
 * and `conditions` are the sole cryptographic truth and travel byte-for-byte
 * into the signed message — no sort, no dedupe, no case-fold, no trim, no
 * empty-string filter. This holds for both the client-constructed typed
 * data ({@link buildEip712TypedData}) and the server-prepared typed data
 * ({@link coerceTypedDataIntegers}).
 *
 * Three ceremonies:
 * - {@link mintPint} — client-signed: fetch a nonce, build typed data, sign,
 *   `POST /v0/pint/exchange`. `wallet` is a Safe; the signing key must be a
 *   registered owner of it.
 * - {@link mintPintAsAgent} — **not** a signing ceremony: the server signs.
 *   A plain `POST /v0/pint/exchange` with `agent: true` and no signature.
 * - {@link decideErrand} — read a server-prepared `approval_payload`, coerce
 *   its integers to BigInt, sign, `PUT` the decision.
 */
export { coerceTypedDataIntegers } from './coerce.js';
export {
  type DecideErrandParams,
  type DecideErrandResult,
  decideErrand,
} from './decide-errand.js';
export {
  type BuildEip712Params,
  buildEip712TypedData,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  EIP712_TYPES,
  ZERO_ADDRESS,
} from './eip712.js';
export { TypedDataPrecisionError } from './errors.js';
export {
  type MintPintAsAgentParams,
  type MintPintParams,
  type MintPintResult,
  mintPint,
  mintPintAsAgent,
} from './mint-pint.js';
export type { Eip712TypeField, SignableTypedData, SignTypedDataFn } from './types.js';
