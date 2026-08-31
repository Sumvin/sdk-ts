/** The EIP-712 domain's `name` field. Part of the signed domain separator. */
export const DOMAIN_NAME = 'Sumvin Purchase Intent';
/**
 * Bumped 2 -> 3 alongside `conditions` entering the PurchaseIntent type. The
 * version is part of the signed domain separator, so a payload built under the
 * old shape cannot have its signature accepted against the new one.
 */
export const DOMAIN_VERSION = '3';
/**
 * The native-asset sentinel for `maxAmountToken`. NOT a domain default — the
 * verifying contract is always the signing wallet, never this.
 */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Mirrors sumvin-api PURCHASE_INTENT_TYPE (eip712_types.py). Field ORDER is part
 * of the EIP-712 type hash — reordering changes the digest and breaks recovery.
 *
 * Deliberately omits an `EIP712Domain` key, unlike the backend's own
 * `EIP712_TYPES` dict (`eip712_types.py`, which pairs `EIP712Domain` with
 * `PurchaseIntent`). This is correct for the documented path — a viem
 * `WalletClient.signTypedData` (the injected `SignTypedDataFn` every
 * ceremony in this module delegates to) synthesizes the `EIP712Domain` type
 * entry itself from `domain`, so supplying one here would be redundant. It
 * is **not** correct for a consumer who takes {@link buildEip712TypedData}'s
 * output and calls the raw `eth_signTypedData_v4` JSON-RPC method directly,
 * bypassing viem: that method requires an explicit `types.EIP712Domain`
 * entry and MetaMask rejects a payload missing it. Add an
 * `EIP712Domain`-keyed entry (name/version/chainId/verifyingContract, the
 * standard domain separator fields) to `types` before calling
 * `eth_signTypedData_v4` outside viem.
 */
export const EIP712_TYPES = {
  PurchaseIntent: [
    { name: 'wallet', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'statement', type: 'string' },
    { name: 'scopes', type: 'string[]' },
    { name: 'resources', type: 'string[]' },
    { name: 'conditions', type: 'string[]' },
    { name: 'maxAmount', type: 'uint256' },
    { name: 'maxAmountToken', type: 'address' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const;

/** Options for {@link buildEip712TypedData}. */
export type BuildEip712Params = {
  /** The user's Safe address. Also becomes the domain's verifyingContract. */
  wallet: string;
  nonce: number;
  statement: string;
  scopes: string[];
  resources: string[];
  /** Passed through verbatim — the backend neither sorts nor dedupes these. */
  conditions: string[];
  maxAmount: string;
  maxAmountToken: string;
  /** Epoch MILLISECONDS. A seconds value reads as 1970 and is born expired. */
  expiresAt: number;
  /**
   * Required, with no default. A default chain silently signs against the wrong
   * domain separator whenever a caller forgets to pass one, yielding a signature
   * the backend cannot recover.
   */
  chainId: number;
};

/**
 * Builds the EIP-712 typed data for a client-signed PINT purchase intent —
 * the exact struct `eth_signTypedData_v4` (or a viem `WalletClient`) needs.
 * Every array field is passed through verbatim; see `src/signing/index.ts`
 * for why order/length/membership are never touched.
 */
export function buildEip712TypedData(params: BuildEip712Params) {
  return {
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: params.chainId,
      // The backend asserts `verifying_contract == payload.wallet`
      // (agent_signing.py, exchange.py). Anything else — including the zero
      // address — produces a digest it can never recover a signer from.
      verifyingContract: params.wallet,
    },
    types: EIP712_TYPES,
    primaryType: 'PurchaseIntent' as const,
    message: {
      wallet: params.wallet,
      nonce: params.nonce,
      statement: params.statement,
      scopes: params.scopes,
      resources: params.resources,
      conditions: params.conditions,
      maxAmount: params.maxAmount,
      maxAmountToken: params.maxAmountToken,
      expiresAt: params.expiresAt,
    },
  };
}
