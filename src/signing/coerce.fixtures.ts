import type { Eip712Payload } from '../generated/types.gen.js';

/**
 * A realistic `IpaData.approval_payload` as sumvin-api actually serialises
 * one — built by `build_eip712_payload` (`services/pint/eip712_types.py`)
 * for a PENDING errand awaiting a purchase decision.
 *
 * Committed as a fixture rather than constructed inline because this is the
 * one surface `coerceTypedDataIntegers` exists for and that has never been
 * vector-tested anywhere: the backend's own parity test
 * (`api/tests/contracts/test_eip712_client_parity.py`) is a regex
 * shape-check over a vendored copy of this SDK's source, not a fixture
 * exercising real coercion.
 *
 * `nonce`, `maxAmount`, and `expiresAt` arrive as JSON numbers (JSON has no
 * BigInt); `conditions` carries a duplicate and an out-of-lexicographic-order
 * entry on purpose, so a test asserting byte-preservation through the
 * coercion has something to actually preserve.
 */
export const SERVER_PREPARED_APPROVAL_PAYLOAD: Eip712Payload = {
  types: {
    EIP712Domain: [
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ],
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
  },
  primaryType: 'PurchaseIntent',
  domain: {
    name: 'Sumvin Purchase Intent',
    version: '3',
    chainId: 1329,
    verifyingContract: '0x1111111111111111111111111111111111111111',
  },
  message: {
    wallet: '0x1111111111111111111111111111111111111111',
    nonce: 7,
    statement: 'Approve purchase of flight SFO-JFK, up to $450.00',
    scopes: ['sr:us:pint:card:checkout'],
    resources: ['sr:us:person:safe:0x1111111111111111111111111111111111111111'],
    // A duplicate ('price < 45000') and an out-of-order entry on purpose —
    // the coercion must preserve both, never sort or dedupe.
    conditions: ['price < 45000', 'availability = confirmed', 'price < 45000'],
    maxAmount: 45000,
    maxAmountToken: '0x0000000000000000000000000000000000000000',
    expiresAt: 1_735_689_600_000,
  },
};
