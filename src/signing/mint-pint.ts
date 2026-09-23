import type { Client } from '../generated/client/index.js';
import { exchangePint, getNonce } from '../generated/sdk.gen.js';
import type {
  ExchangePintError,
  GetNonceError,
  PintExchangeResponse,
  PurchaseIntentPayload,
  UserPintExchangeRequest,
} from '../generated/types.gen.js';
import { buildEip712TypedData } from './eip712.js';
import type { SignTypedDataFn } from './types.js';

/** Total exchange attempts on a nonce race (409): one retry. */
const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Either branch a mint can end on: a successful exchange, or the error from
 * whichever step failed (the nonce fetch or the exchange itself — both are
 * plain `ProblemDetail`-shaped bodies until an error interceptor normalizes
 * them, see `src/errors`).
 */
export type MintPintResult =
  | { data: PintExchangeResponse; error: undefined; request?: Request; response?: Response }
  | {
      data: undefined;
      error: GetNonceError | ExchangePintError;
      request?: Request;
      response?: Response;
    };

/** Options for {@link mintPint}. */
export interface MintPintParams {
  /** The configured client — see `createSumvinClient`. */
  client: Client;
  /**
   * The user's primary wallet address (see `buildEip712TypedData`). The
   * signature must come from a key authorised to approve for this wallet;
   * the server refuses a Stamped Mandate signed by any other key.
   */
  wallet: string;
  statement: string;
  scopes: string[];
  resources: string[];
  /**
   * Passed through verbatim — see `buildEip712TypedData`. Defaults to `[]`
   * and is always sent explicitly (never omitted), so the signed struct and
   * the transmitted body describe the same thing.
   */
  conditions?: string[];
  /**
   * An on-chain token ceiling, as an all-digit integer string. Use `'0'` for
   * a fiat ceiling: that belongs in the scope's `max` parameter, written in
   * the currency's display unit (e.g. `max=450.00&currency=USD`).
   */
  maxAmount: string;
  /** The token `maxAmount` is measured in; the zero address (`ZERO_ADDRESS`) alongside a `'0'` `maxAmount`. */
  maxAmountToken: string;
  /** Epoch MILLISECONDS. A seconds value reads as 1970 and is born expired. */
  expiresAt: number;
  chainId: number;
  /** Who the minted token is addressed to. Omit it to address it to yourself. */
  audience?: string;
  sourceChatMessageId?: number;
  parentPintUri?: string;
  /** The injected signing seam — see `SignTypedDataFn`. */
  signTypedData: SignTypedDataFn;
  /**
   * Total exchange attempts on a nonce race (409) — the nonce was consumed
   * between fetch and exchange, most often by a concurrent mint from the
   * same wallet. Defaults to 2 (one retry).
   */
  maxAttempts?: number;
}

/** Options for {@link mintPintAsAgent}. */
export interface MintPintAsAgentParams {
  /** The configured client — see `createSumvinClient`. */
  client: Client;
  /**
   * Must be the caller's own primary wallet address. The server enforces
   * this and refuses the request (400) otherwise — this function does not
   * (and cannot) look up the caller's primary wallet on your behalf.
   */
  wallet: string;
  statement: string;
  scopes: string[];
  resources: string[];
  /** Passed through verbatim. Defaults to `[]`, sent explicitly. */
  conditions?: string[];
  maxAmount: string;
  maxAmountToken: string;
  /** Epoch MILLISECONDS. */
  expiresAt: number;
  sourceChatMessageId?: number;
  parentPintUri?: string;
  /** See {@link MintPintParams.maxAttempts}. */
  maxAttempts?: number;
}

/**
 * Fetch a nonce, build the exchange body via `buildRequest`, and exchange —
 * retrying the whole nonce-fetch-then-exchange cycle up to `maxAttempts`
 * times when the exchange fails with 409 (the nonce raced). Shared by
 * {@link mintPint} and {@link mintPintAsAgent}: the race is a property of
 * `pint.nonce`, not of which party signs, so both ceremonies get the same
 * protection.
 */
async function exchangeWithNonceRetry(
  client: Client,
  wallet: string,
  maxAttempts: number,
  query: { agent?: boolean } | undefined,
  buildBody: (nonce: number) => Promise<UserPintExchangeRequest>,
): Promise<MintPintResult> {
  const attempts = Math.max(1, maxAttempts);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const nonceResult = await getNonce({ client, query: { wallet } });
    if (nonceResult.error !== undefined) {
      return nonceResult;
    }

    const body = await buildBody(nonceResult.data.nonce);
    const exchangeResult = await exchangePint({ client, query, body });

    const isNonceRace =
      exchangeResult.error !== undefined && exchangeResult.response?.status === 409;
    if (isNonceRace && attempt < attempts) {
      continue;
    }
    return exchangeResult;
  }

  // Unreachable: every iteration above returns. `attempts` is at least 1
  // (enforced by `Math.max` above), so the loop runs at least once, and its
  // final iteration always satisfies `attempt < attempts === false`, which
  // falls through to the unconditional `return exchangeResult`. The compiler
  // can't prove a `for` loop always returns, so this satisfies it instead of
  // a non-null assertion on `last`.
  throw new Error('unreachable: exchangeWithNonceRetry fell through its retry loop');
}

/**
 * Mint a Stamped Mandate signed by the person's own wallet: fetch a nonce,
 * build the EIP-712 typed data, sign it via the injected
 * {@link SignTypedDataFn}, and exchange it for a token at
 * `POST /v0/pint/exchange`.
 *
 * `wallet` is the person's primary wallet address, and the signature must
 * come from a key authorised to approve for it; anything else is refused.
 *
 * Put a fiat spend ceiling in the scope's `max` parameter, as an amount in
 * the currency's display unit (`450.00` for $450; an amount finer than the
 * currency's precision is refused), and leave `maxAmount` at `'0'` with
 * `maxAmountToken` set to the zero address.
 *
 * Retries the whole nonce-fetch-then-sign-then-exchange cycle once (by
 * default) on a 409 nonce race — see {@link MintPintParams.maxAttempts}.
 *
 * @example
 * const result = await mintPint({
 *   client,
 *   wallet: walletAddress,
 *   statement: 'Book a flight up to $450',
 *   scopes: ['sr:us:pint:spend:visa_checkout?max=450.00&currency=USD'],
 *   resources: [],
 *   maxAmount: '0',
 *   maxAmountToken: '0x0000000000000000000000000000000000000000',
 *   expiresAt: Date.now() + 60 * 60 * 1000,
 *   chainId: 1329,
 *   signTypedData: (typedData) => wallet.signTypedData({ account, ...typedData }),
 * });
 * if (result.error === undefined) {
 *   console.log(result.data.sig);
 * }
 */
export async function mintPint(params: MintPintParams): Promise<MintPintResult> {
  const conditions = params.conditions ?? [];
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  return exchangeWithNonceRetry(
    params.client,
    params.wallet,
    maxAttempts,
    undefined,
    async (nonce) => {
      const typedData = buildEip712TypedData({
        wallet: params.wallet,
        nonce,
        statement: params.statement,
        scopes: params.scopes,
        resources: params.resources,
        conditions,
        maxAmount: params.maxAmount,
        maxAmountToken: params.maxAmountToken,
        expiresAt: params.expiresAt,
        chainId: params.chainId,
      });
      const signature = await params.signTypedData(typedData);

      const pint: PurchaseIntentPayload = {
        wallet: params.wallet,
        nonce,
        statement: params.statement,
        scopes: params.scopes,
        resources: params.resources,
        conditions,
        max_amount: params.maxAmount,
        max_amount_token: params.maxAmountToken,
        expires_at: params.expiresAt,
      };

      return {
        pint,
        signature,
        audience: params.audience,
        source_chat_message_id: params.sourceChatMessageId,
        parent_pint_uri: params.parentPintUri,
      };
    },
  );
}

/**
 * Mint a Stamped Mandate that the server signs on the caller's behalf —
 * `agent: true`, **no signature**. Not a signing ceremony: `wallet` must be
 * the caller's own primary wallet address (enforced server-side, 400
 * otherwise), and the resulting token is always addressed to the caller —
 * `audience` is not offered here because the server sets it and would not
 * honour a different one.
 *
 * `MintPintAsAgentParams` has no `signTypedData`/`signature` field at all,
 * so passing one is a compile error — the same refusal the server enforces
 * at runtime, caught earlier.
 *
 * @example
 * const result = await mintPintAsAgent({
 *   client,
 *   wallet: walletAddress,
 *   statement: 'Search for a flight to Lisbon over the next 30 days',
 *   scopes: ['sr:us:pint:errand:search?time=2592000'],
 *   resources: [],
 *   maxAmount: '0',
 *   maxAmountToken: '0x0000000000000000000000000000000000000000',
 *   expiresAt: Date.now() + 60 * 60 * 1000,
 * });
 */
export async function mintPintAsAgent(params: MintPintAsAgentParams): Promise<MintPintResult> {
  const conditions = params.conditions ?? [];
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  return exchangeWithNonceRetry(
    params.client,
    params.wallet,
    maxAttempts,
    { agent: true },
    async (nonce) => {
      const pint: PurchaseIntentPayload = {
        wallet: params.wallet,
        nonce,
        statement: params.statement,
        scopes: params.scopes,
        resources: params.resources,
        conditions,
        max_amount: params.maxAmount,
        max_amount_token: params.maxAmountToken,
        expires_at: params.expiresAt,
      };

      // No `signature`: supplying one under `agent: true` is a hard 400.
      // No `audience`: it is forced to the caller's own identity server-side.
      return {
        pint,
        source_chat_message_id: params.sourceChatMessageId,
        parent_pint_uri: params.parentPintUri,
      };
    },
  );
}
