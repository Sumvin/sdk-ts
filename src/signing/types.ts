/**
 * A single EIP-712 struct field declaration, `{ name, type }` — e.g.
 * `{ name: 'wallet', type: 'address' }`. Deliberately narrower than the
 * generated `Eip712Payload['types']` blob (`{[key: string]: Array<{[key:
 * string]: string}>}`, a permissive dict because the schema can't know a
 * struct's field names ahead of time) so the recursive coercion in
 * `coerce.ts` can index `field.name`/`field.type` without re-checking their
 * presence at every recursion level.
 */
export interface Eip712TypeField {
  readonly name: string;
  readonly type: string;
}

/**
 * The typed-data shape both signing ceremonies in this module hand to an
 * injected {@link SignTypedDataFn}.
 *
 * Deliberately loose — not the generated `Eip712Payload`, whose `message` is
 * pinned to the one wire shape a server-prepared payload has — because the
 * two ceremonies populate `message` differently: {@link mintPint} passes
 * `buildEip712TypedData`'s JSON-safe output straight through (nonce and
 * expiresAt as `number`, maxAmount as a decimal `string`), while
 * `decideErrand` passes `coerceTypedDataIntegers`'s BigInt-coerced output.
 * Both are structurally assignable to this type, which is all an injected
 * signer needs.
 */
export interface SignableTypedData {
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, ReadonlyArray<Eip712TypeField>>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
}

/**
 * The injected signing seam every ceremony in `src/signing` delegates to —
 * a viem `WalletClient.signTypedData`, or whatever wallet the consumer
 * already holds. This SDK never holds a key and never
 * calls a signer on its own; this function type is the only crossing point.
 *
 * @example
 * import { createWalletClient, custom } from 'viem';
 *
 * const wallet = createWalletClient({ transport: custom(window.ethereum) });
 * const signTypedData: SignTypedDataFn = (typedData) =>
 *   wallet.signTypedData({ account: myAddress, ...typedData } as never);
 */
export type SignTypedDataFn = (typedData: SignableTypedData) => string | Promise<string>;
