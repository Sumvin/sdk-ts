/**
 * `@sumvin/sdk/signing` — EIP-712 typed-data construction for PINT purchase
 * intents.
 *
 * This subpath builds the typed data a wallet signs (`eth_signTypedData_v4`);
 * it does not sign anything itself. Signing is delegated to the caller via an
 * injected `signTypedData`-shaped function (a viem `WalletClient`, an EOA
 * signer, a Safe SDK — whatever the consumer already holds). `viem` is
 * declared as an **optional peer dependency** in `package.json` and is
 * **deliberately unused** by this module — the peer slot is reserved for the
 * signing ceremony (constructing a `WalletClient`, calling `signTypedData`,
 * wiring server-supplied typed data), which lands separately. It is reserved
 * on purpose, not forgotten.
 *
 * The one constraint this subpath must never violate: `scopes`, `resources`,
 * and `conditions` are the sole cryptographic truth and travel byte-for-byte
 * into the signed message — no sort, no dedupe, no case-fold, no trim, no
 * empty-string filter.
 */
export {
  type BuildEip712Params,
  buildEip712TypedData,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  EIP712_TYPES,
  ZERO_ADDRESS,
} from './eip712.js';
