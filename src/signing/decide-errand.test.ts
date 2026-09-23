import { describe, expect, it, vi } from 'vitest';
import { type Client, createClient, createConfig } from '../generated/client/index.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import { SERVER_PREPARED_APPROVAL_PAYLOAD } from './coerce.fixtures.js';
import { decideErrand } from './decide-errand.js';
import type { SignableTypedData } from './types.js';

const IPA_ID = 'ipa_123';

function clientWith(f: ReturnType<typeof fakeFetch>) {
  return createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
}

async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.clone().text();
  return text ? JSON.parse(text) : undefined;
}

function mockSigner(signature = '0xapprovalsig') {
  return vi.fn(async (_typedData: SignableTypedData) => signature);
}

function decisionReply() {
  return {
    status: 200,
    body: {
      _links: {},
      intent: {
        id: IPA_ID,
        intent_type: 'product',
        status: 'approved',
        autonomy_level: 'supervised',
        created_at: 1_700_000_000_000,
      },
    },
  };
}

describe('decideErrand — approved', () => {
  // When: this test goes red if `decideErrand` signs the raw server payload
  // instead of the BigInt-coerced one, or if it forgets to coerce at all —
  // an injected viem signer would then throw on the integer-typed fields, or
  // (worse, if the signer is loose) sign a digest that doesn't match what
  // the API expects.
  it('coerces approval_payload, signs the coerced typed data, and PUTs the decision', async () => {
    const f = fakeFetch([decisionReply()]);
    const client = clientWith(f);
    const signTypedData = mockSigner();

    const result = await decideErrand({
      client,
      ipaId: IPA_ID,
      decision: 'approved',
      approvalPayload: SERVER_PREPARED_APPROVAL_PAYLOAD,
      signTypedData,
    });

    expect(result.error).toBeUndefined();
    expect(result.data?.intent.status).toBe('approved');

    expect(signTypedData).toHaveBeenCalledTimes(1);
    const typedData = signTypedData.mock.calls[0]?.[0] as SignableTypedData;
    expect(typeof typedData.message.nonce).toBe('bigint');
    expect(typeof typedData.message.maxAmount).toBe('bigint');
    expect(typeof typedData.message.expiresAt).toBe('bigint');
    // Byte-preserved through the coercion into what gets signed.
    expect(typedData.message.conditions).toEqual(
      SERVER_PREPARED_APPROVAL_PAYLOAD.message.conditions,
    );

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.method).toBe('PUT');
    expect(new URL(f.calls[0]?.url ?? '').pathname).toBe(`/v0/user/ipa/${IPA_ID}/decision`);
    await expect(bodyOf(f.calls[0] as Request)).resolves.toEqual({
      decision: 'approved',
      signature: '0xapprovalsig',
    });
  });
});

describe('decideErrand — rejected / conditional', () => {
  it.each(['rejected', 'conditional'] as const)(
    'sends decision=%s with no signature field',
    async (decision) => {
      const f = fakeFetch([decisionReply()]);
      const client = clientWith(f);

      const result = await decideErrand({ client, ipaId: IPA_ID, decision });

      expect(result.error).toBeUndefined();
      expect(f.calls).toHaveLength(1);
      await expect(bodyOf(f.calls[0] as Request)).resolves.toEqual({ decision });
    },
  );
});

// ---------------------------------------------------------------------------
// Compile-time proof (never executed — `bun run typecheck` is the
// assertion): an unsigned `decision: 'approved'` is a type error. The
// `'approved'` member of `DecideErrandParams` requires `approvalPayload` and
// `signTypedData`; omitting both is a missing-required-properties error.
// ---------------------------------------------------------------------------
function _typeOnly_approvedRequiresApprovalPayloadAndSignature(client: Client): void {
  // @ts-expect-error — 'approved' requires approvalPayload and signTypedData
  void decideErrand({
    client,
    ipaId: IPA_ID,
    decision: 'approved',
  });
}
void _typeOnly_approvedRequiresApprovalPayloadAndSignature;
