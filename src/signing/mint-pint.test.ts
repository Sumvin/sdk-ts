import { describe, expect, it, vi } from 'vitest';
import { type Client, createClient, createConfig } from '../generated/client/index.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { ZERO_ADDRESS } from './eip712.js';
import { mintPint, mintPintAsAgent } from './mint-pint.js';
import type { SignableTypedData } from './types.js';

const WALLET = '0x1111111111111111111111111111111111111111';

function clientWith(f: ReturnType<typeof fakeFetch>) {
  return createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
}

async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.clone().text();
  return text ? JSON.parse(text) : undefined;
}

function mockSigner(signature = '0xsig') {
  return vi.fn(async (_typedData: SignableTypedData) => signature);
}

function nonceReply(nonce: number) {
  return { status: 200, body: { _links: {}, nonce, wallet: WALLET } };
}

function exchangeSuccessReply(overrides: Record<string, unknown> = {}) {
  return {
    status: 201,
    body: {
      _links: {},
      sig: 'jwt-token',
      id: 'urn:pint:1',
      audience: WALLET,
      scopes: ['sr:us:pint:card:checkout'],
      expires_at: 1_700_003_600_000,
      ...overrides,
    },
  };
}

function nonceRaceReply() {
  return {
    status: 409,
    body: {
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: 'nonce already consumed',
      instance: '/v0/pint/exchange',
      error_code: 'PIN-409-001',
    },
  };
}

const baseParams = {
  wallet: WALLET,
  statement: 'Book a flight up to $450',
  scopes: ['sr:us:pint:card:checkout'],
  resources: [] as string[],
  maxAmount: '45000',
  maxAmountToken: ZERO_ADDRESS,
  expiresAt: 1_700_000_000_000,
  chainId: 1329,
};

describe('mintPint — happy path', () => {
  // When: this test goes red if the outgoing exchange body drifts from the
  // exact shape POST /v0/pint/exchange expects — a nonce
  // fetched from one field, signed under a different value, or an
  // `undefined` field serialized as `null` instead of omitted.
  it('sends exactly the expected body to POST /v0/pint/exchange', async () => {
    const f = fakeFetch([nonceReply(5), exchangeSuccessReply()]);
    const client = clientWith(f);
    const signTypedData = mockSigner('0xsignature');

    const result = await mintPint({ ...baseParams, client, signTypedData });

    expect(result.error).toBeUndefined();
    expect(result.data?.sig).toBe('jwt-token');

    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.method).toBe('GET');
    expect(new URL(f.calls[0]?.url ?? '').pathname).toBe('/v0/pint/nonce');
    expect(new URL(f.calls[0]?.url ?? '').searchParams.get('wallet')).toBe(WALLET);

    expect(f.calls[1]?.method).toBe('POST');
    expect(new URL(f.calls[1]?.url ?? '').pathname).toBe('/v0/pint/exchange');
    await expect(bodyOf(f.calls[1] as Request)).resolves.toEqual({
      pint: {
        wallet: WALLET,
        nonce: 5,
        statement: baseParams.statement,
        scopes: baseParams.scopes,
        resources: baseParams.resources,
        conditions: [],
        max_amount: baseParams.maxAmount,
        max_amount_token: baseParams.maxAmountToken,
        expires_at: baseParams.expiresAt,
      },
      signature: '0xsignature',
    });

    expect(signTypedData).toHaveBeenCalledTimes(1);
    const typedData = signTypedData.mock.calls[0]?.[0] as SignableTypedData;
    expect(typedData.message.nonce).toBe(5);
    expect(typedData.domain.verifyingContract).toBe(WALLET);
  });

  it('sends conditions, audience, and lineage fields through untouched when supplied', async () => {
    const f = fakeFetch([nonceReply(1), exchangeSuccessReply()]);
    const client = clientWith(f);
    const signTypedData = mockSigner();

    await mintPint({
      ...baseParams,
      client,
      signTypedData,
      conditions: ['price < 45000', 'price < 45000'],
      audience: 'example.com',
      sourceChatMessageId: 42,
      parentPintUri: 'urn:pint:parent',
    });

    const body = (await bodyOf(f.calls[1] as Request)) as {
      pint: { conditions: string[] };
      audience: string;
      source_chat_message_id: number;
      parent_pint_uri: string;
    };
    // Duplicate preserved verbatim — never deduped.
    expect(body.pint.conditions).toEqual(['price < 45000', 'price < 45000']);
    expect(body.audience).toBe('example.com');
    expect(body.source_chat_message_id).toBe(42);
    expect(body.parent_pint_uri).toBe('urn:pint:parent');
  });
});

describe('mintPint — 409 nonce-race retry', () => {
  // When: this test goes red if a nonce race is not retried, or if the
  // retry re-sends the SAME (now-stale) nonce instead of re-fetching and
  // re-signing over a fresh one — the exact regression sumvin-cli's
  // MAX_ATTEMPTS retry exists to prevent (create-core.ts:66,95-142).
  it('re-fetches the nonce and re-signs over the new nonce after a 409', async () => {
    const f = fakeFetch([nonceReply(1), nonceRaceReply(), nonceReply(2), exchangeSuccessReply()]);
    const client = clientWith(f);
    const signTypedData = mockSigner();

    const result = await mintPint({ ...baseParams, client, signTypedData });

    expect(result.error).toBeUndefined();
    expect(f.calls).toHaveLength(4);

    expect(signTypedData).toHaveBeenCalledTimes(2);
    const firstTypedData = signTypedData.mock.calls[0]?.[0] as SignableTypedData;
    const secondTypedData = signTypedData.mock.calls[1]?.[0] as SignableTypedData;
    expect(firstTypedData.message.nonce).toBe(1);
    expect(secondTypedData.message.nonce).toBe(2);
    expect(secondTypedData.message.nonce).not.toBe(firstTypedData.message.nonce);

    // The second exchange attempt carries the NEW nonce, not the stale one.
    const secondExchangeBody = (await bodyOf(f.calls[3] as Request)) as { pint: { nonce: number } };
    expect(secondExchangeBody.pint.nonce).toBe(2);
  });

  // When: this test goes red if the retry loop doesn't stop at maxAttempts —
  // either retrying forever on a persistently racing nonce, or (the
  // opposite bug) failing to surface the final 409 as the result.
  it('gives up after maxAttempts and surfaces the final 409', async () => {
    const f = fakeFetch([nonceReply(1), nonceRaceReply(), nonceReply(2), nonceRaceReply()]);
    const client = clientWith(f);
    const signTypedData = mockSigner();

    const result = await mintPint({ ...baseParams, client, signTypedData });

    expect(result.data).toBeUndefined();
    expect(result.response?.status).toBe(409);
    expect(f.calls).toHaveLength(4); // 2 attempts x (nonce + exchange), no third attempt
    expect(signTypedData).toHaveBeenCalledTimes(2);
  });

  it('honours a caller-supplied maxAttempts', async () => {
    const f = fakeFetch([
      nonceReply(1),
      nonceRaceReply(),
      nonceReply(2),
      nonceRaceReply(),
      nonceReply(3),
      exchangeSuccessReply(),
    ]);
    const client = clientWith(f);
    const signTypedData = mockSigner();

    const result = await mintPint({ ...baseParams, client, signTypedData, maxAttempts: 3 });

    expect(result.error).toBeUndefined();
    expect(f.calls).toHaveLength(6);
    expect(signTypedData).toHaveBeenCalledTimes(3);
  });
});

describe('mintPintAsAgent', () => {
  // When: this test goes red if this path ever sends a `signature` field —
  // the API rejects that with a 400, and this call must never construct a
  // client-side agent signature.
  it('sends agent=true and no signature field at all', async () => {
    const f = fakeFetch([nonceReply(9), exchangeSuccessReply()]);
    const client = clientWith(f);

    const result = await mintPintAsAgent({
      client,
      wallet: WALLET,
      statement: baseParams.statement,
      scopes: baseParams.scopes,
      resources: baseParams.resources,
      maxAmount: baseParams.maxAmount,
      maxAmountToken: baseParams.maxAmountToken,
      expiresAt: baseParams.expiresAt,
    });

    expect(result.error).toBeUndefined();
    expect(new URL(f.calls[1]?.url ?? '').searchParams.get('agent')).toBe('true');

    const body = (await bodyOf(f.calls[1] as Request)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('signature');
    expect(body).not.toHaveProperty('audience');
    expect(body.pint).toEqual({
      wallet: WALLET,
      nonce: 9,
      statement: baseParams.statement,
      scopes: baseParams.scopes,
      resources: baseParams.resources,
      conditions: [],
      max_amount: baseParams.maxAmount,
      max_amount_token: baseParams.maxAmountToken,
      expires_at: baseParams.expiresAt,
    });
  });

  it('retries a 409 nonce race the same way as the client-signed path', async () => {
    const f = fakeFetch([nonceReply(1), nonceRaceReply(), nonceReply(2), exchangeSuccessReply()]);
    const client = clientWith(f);

    const result = await mintPintAsAgent({
      client,
      wallet: WALLET,
      statement: baseParams.statement,
      scopes: baseParams.scopes,
      resources: baseParams.resources,
      maxAmount: baseParams.maxAmount,
      maxAmountToken: baseParams.maxAmountToken,
      expiresAt: baseParams.expiresAt,
    });

    expect(result.error).toBeUndefined();
    expect(f.calls).toHaveLength(4);
    const secondBody = (await bodyOf(f.calls[3] as Request)) as { pint: { nonce: number } };
    expect(secondBody.pint.nonce).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Compile-time proof (never executed — `bun run typecheck` is the assertion):
// passing a signature to mintPintAsAgent is a type error, mirroring the
// API's own 400 for the same thing.
// `MintPintAsAgentParams` simply has no `signTypedData`/`signature` field, so
// this is an excess-property error on the object literal below.
// ---------------------------------------------------------------------------
function _typeOnly_mintPintAsAgentRefusesASignature(client: Client): void {
  void mintPintAsAgent({
    client,
    wallet: WALLET,
    statement: 's',
    scopes: [],
    resources: [],
    maxAmount: '0',
    maxAmountToken: ZERO_ADDRESS,
    expiresAt: 0,
    // @ts-expect-error — MintPintAsAgentParams has no signTypedData/signature field
    signTypedData: async () => '0xsig',
  });
}
void _typeOnly_mintPintAsAgentRefusesASignature;
