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

/** Total exchange attempts on a nonce race (409). One retry, matching sumvin-cli's `MAX_ATTEMPTS`. */
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
   * The user's Safe address. Also becomes the domain's `verifyingContract`
   * (see `buildEip712TypedData`). The signing key must be a registered owner
   * of this Safe — the backend *names* the signer rather than recovering it
   * from the signature, so an EOA that isn't a Safe owner produces a
   * signature the backend can never attribute to this wallet.
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
  maxAmount: string;
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
   * same wallet. Defaults to 2 (one retry). sumvin-cli carries this exact
   * retry today (`src/pint/create-core.ts:66,95-142`, `MAX_ATTEMPTS = 2`)
   * and ENG-3425 deletes that code once this ships, so omitting it here
   * would be a silent regression, not a simplification.
   */
  maxAttempts?: number;
}

/** Options for {@link mintPintAsAgent}. */
export interface MintPintAsAgentParams {
  /** The configured client — see `createSumvinClient`. */
  client: Client;
  /**
   * Must be the caller's own primary Safe. The server enforces this and
   * refuses the request (400) otherwise — this function does not (and
   * cannot) resolve "the caller's primary Safe" on your behalf.
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
 * Mint a PINT with a client-held signing key: fetch a nonce, build the
 * EIP-712 typed data, sign it via the injected {@link SignTypedDataFn}, and
 * exchange it for a token at `POST /v0/pint/exchange`.
 *
 * `wallet` must be a Safe, and the signing key must be a registered owner of
 * it — the backend recovers no address from the signature; it *names* the
 * signer and checks that name against the Safe's owner set. A signature
 * that recovers to anything else (including a perfectly valid signature
 * from a non-owner EOA) is refused.
 *
 * Retries the whole nonce-fetch-then-sign-then-exchange cycle once (by
 * default) on a 409 nonce race — see {@link MintPintParams.maxAttempts}.
 *
 * @example
 * const result = await mintPint({
 *   client,
 *   wallet: safeAddress,
 *   statement: 'Book a flight up to $450',
 *   scopes: ['sr:us:pint:card:checkout'],
 *   resources: [],
 *   maxAmount: '45000',
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
 * Mint a PINT with the server's own agent signer — `agent: true`, **no
 * signature**. Not a signing ceremony: the server signs on the caller's
 * behalf, `wallet` must be the caller's own primary Safe (enforced
 * server-side, 400 otherwise), and the resulting token is always addressed
 * to the caller — `audience` is not offered here because the server forces
 * it and would not honour a different one
 * (`router/pint/exchange_route.py:213-260`).
 *
 * There is deliberately no client-side agent-signing path to parallel this:
 * EIP-1271 exists upstream but is refused by design
 * (`RECOVERABLE_SIGNER_KIND = EOA`). `MintPintAsAgentParams` has no
 * `signTypedData`/`signature` field at all, so passing one is a compile
 * error — the same refusal the server enforces at runtime, caught earlier.
 *
 * @example
 * const result = await mintPintAsAgent({
 *   client,
 *   wallet: mySafeAddress,
 *   statement: 'Book a flight up to $450',
 *   scopes: ['sr:us:pint:card:checkout'],
 *   resources: [],
 *   maxAmount: '45000',
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
