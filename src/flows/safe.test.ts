import { describe, expect, it, vi } from 'vitest';
import { installErrorInterceptor, isApiError } from '../errors/index.js';
import { createClient, createConfig } from '../generated/client/index.js';
import type {
  OnboardingData,
  OnboardingSafeResponse,
  OnboardingStepsResponse,
  SafeRpcStatusResponse,
} from '../generated/index.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import {
  deriveSafeCreationProgress,
  deriveSafeOnboardingState,
  deriveUserOperationProgress,
  pollSafeCreation,
  pollUserOperationStatus,
  SAFE_CREATION_POLL_INTERVAL_MS,
} from './safe.js';

function clientWith(f: ReturnType<typeof fakeFetch>) {
  const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
  installErrorInterceptor(client);
  return client;
}

function onboarding(overrides: Partial<OnboardingData> = {}): OnboardingData {
  return {
    current_step: 'safe_deploy',
    steps: [],
    is_complete: false,
    safe_creation_status: null,
    primary_smart_wallet_address: null,
    did_mint_status: null,
    did_token_id: null,
    ...overrides,
  };
}

function onboardingResponse(overrides: Partial<OnboardingData> = {}): OnboardingStepsResponse {
  return {
    _links: { self: { href: '/v0/user/me/onboarding/steps' } },
    onboarding: onboarding(overrides),
  };
}

function safeResponse(overrides: Partial<OnboardingSafeResponse> = {}): OnboardingSafeResponse {
  return {
    _links: { self: { href: '/v0/user/me/onboarding/safe' } },
    mode: 'agent_create2',
    config: { mode: 'agent_create2', predicted_safe_address: null, signer_contract_address: null },
    wallet: null,
    chain_id: 1329,
    required: false,
    step_status: 'current',
    ...overrides,
  };
}

function userOpStatus(overrides: Partial<SafeRpcStatusResponse> = {}): SafeRpcStatusResponse {
  return {
    _links: { self: { href: '/v0/safe/rpc/0xhash/status' } },
    user_op_hash: '0xhash',
    status: 'submitted',
    txn_hash: null,
    block_number: null,
    ...overrides,
  };
}

function fakeClock(startMs = 0) {
  let current = startMs;
  const waits: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number, signal?: AbortSignal) => {
      waits.push(ms);
      if (signal?.aborted) return;
      current += ms;
    },
    waits,
  };
}

describe('deriveSafeOnboardingState', () => {
  it('reads the byo cohort — no manual action yet, wallet not persisted', () => {
    const state = deriveSafeOnboardingState(
      safeResponse({
        mode: 'byo',
        config: { mode: 'byo', byo_safe: null },
        step_status: 'current',
      }),
    );

    expect(state.mode).toBe('byo');
    expect(state.recognizedMode).toBe(true);
    expect(state.wallet).toBeNull();
    expect(state.stepStatus).toBe('current');
  });

  it('reads the user_signed_deploy cohort with a wallet already persisted (pending)', () => {
    const wallet = {
      id: 'w_1',
      address: '0xsafe',
      chain_id: 1329,
      is_primary: true,
      is_eoa: false,
      created_at: 1,
    };
    const state = deriveSafeOnboardingState(
      safeResponse({
        mode: 'user_signed_deploy',
        config: { mode: 'user_signed_deploy', user_op_hash: '0xhash' },
        wallet,
        step_status: 'submitted',
      }),
    );

    expect(state.mode).toBe('user_signed_deploy');
    expect(state.wallet).toEqual(wallet);
    expect(state.stepStatus).toBe('submitted');
  });

  it('degrades legibly — not throws — on a mode this build does not recognize', () => {
    const drifted = safeResponse({
      mode: 'passkey_deploy' as OnboardingSafeResponse['mode'],
    });

    const state = deriveSafeOnboardingState(drifted);

    expect(state.recognizedMode).toBe(false);
  });
});

describe('deriveSafeCreationProgress', () => {
  it('reads "not started": null status, nothing to wait on', () => {
    const progress = deriveSafeCreationProgress(onboarding());

    expect(progress.status).toBeNull();
    expect(progress.inFlight).toBe(false);
    expect(progress.walletAddress).toBeNull();
  });

  it('reads an in-flight creation: `processing`, no address yet', () => {
    const progress = deriveSafeCreationProgress(onboarding({ safe_creation_status: 'processing' }));

    expect(progress.inFlight).toBe(true);
    expect(progress.walletAddress).toBeNull();
  });

  it('reads a completed creation with the wallet address populated', () => {
    const progress = deriveSafeCreationProgress(
      onboarding({ safe_creation_status: 'completed', primary_smart_wallet_address: '0xsafe' }),
    );

    expect(progress.status).toBe('completed');
    expect(progress.inFlight).toBe(false);
    expect(progress.walletAddress).toBe('0xsafe');
  });

  it('degrades legibly — not throws — on a status this build does not recognize', () => {
    const progress = deriveSafeCreationProgress(onboarding({ safe_creation_status: 'archived' }));

    expect(progress.recognizedStatus).toBe(false);
  });
});

describe('pollSafeCreation', () => {
  it('returns `not-started` immediately when creation has not begun', async () => {
    const f = fakeFetch([{ status: 200, body: onboardingResponse() }]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollSafeCreation({ client, ...clock });

    expect(outcome.kind).toBe('not-started');
    expect(f.calls).toHaveLength(1);
    expect(clock.waits).toEqual([]);
  });

  it(`polls at SAFE_CREATION_POLL_INTERVAL_MS while in flight, then returns 'completed'`, async () => {
    const f = fakeFetch([
      { status: 200, body: onboardingResponse({ safe_creation_status: 'processing' }) },
      {
        status: 200,
        body: onboardingResponse({
          safe_creation_status: 'completed',
          primary_smart_wallet_address: '0xsafe',
        }),
      },
    ]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollSafeCreation({ client, ...clock });

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error('unreachable');
    expect(outcome.progress.walletAddress).toBe('0xsafe');
    expect(f.calls).toHaveLength(2);
    expect(clock.waits).toEqual([SAFE_CREATION_POLL_INTERVAL_MS]);
  });

  it(
    'returns `completed` on the very first read — the drift case: the server has already ' +
      'finished by the time this client first asks',
    async () => {
      const f = fakeFetch([
        {
          status: 200,
          body: onboardingResponse({
            safe_creation_status: 'completed',
            primary_smart_wallet_address: '0xsafe',
          }),
        },
      ]);
      const client = clientWith(f);
      const clock = fakeClock();

      const outcome = await pollSafeCreation({ client, ...clock });

      expect(outcome.kind).toBe('completed');
      expect(f.calls).toHaveLength(1);
      expect(clock.waits).toEqual([]);
    },
  );

  it('returns `failed` once the workflow exhausts its retries server-side', async () => {
    const f = fakeFetch([
      { status: 200, body: onboardingResponse({ safe_creation_status: 'failed' }) },
    ]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollSafeCreation({ client, ...clock });

    expect(outcome.kind).toBe('failed');
  });

  it('returns `timeout` with the last observed progress once `deadlineMs` is exhausted', async () => {
    const f = fakeFetch([
      { status: 200, body: onboardingResponse({ safe_creation_status: 'processing' }) },
    ]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollSafeCreation({
      client,
      intervalMs: 8_000,
      deadlineMs: 20_000,
      ...clock,
    });

    expect(outcome.kind).toBe('timeout');
    if (outcome.kind !== 'timeout') throw new Error('unreachable');
    expect(outcome.progress.status).toBe('processing');
  });

  it('surfaces a request failure as a value, never a throw', async () => {
    const f = fakeFetch([{ status: 401, body: { title: 'Unauthorized' } }]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollSafeCreation({ client, ...clock });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(isApiError(outcome.error)).toBe(true);
  });

  it('stops issuing requests and returns `aborted` once the signal fires mid-poll', async () => {
    const f = fakeFetch([
      { status: 200, body: onboardingResponse({ safe_creation_status: 'processing' }) },
    ]);
    const client = clientWith(f);
    const controller = new AbortController();
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      if (f.calls.length === 1) controller.abort();
      void signal;
    });

    const outcome = await pollSafeCreation({
      client,
      signal: controller.signal,
      sleep,
      now: () => 0,
    });

    expect(outcome).toEqual({ kind: 'aborted' });
    expect(f.calls).toHaveLength(1);
  });
});

describe('deriveUserOperationProgress', () => {
  it('reads a pre-chain state: `submitted`, no txn hash yet', () => {
    const progress = deriveUserOperationProgress(userOpStatus({ status: 'submitted' }));

    expect(progress.recognizedStatus).toBe(true);
    expect(progress.txnHash).toBeNull();
  });

  it('reads the on-chain terminal state, `included`, with a txn hash', () => {
    const progress = deriveUserOperationProgress(
      userOpStatus({ status: 'included', txn_hash: '0xtx', block_number: 100 }),
    );

    expect(progress.txnHash).toBe('0xtx');
    expect(progress.blockNumber).toBe(100);
  });

  it('degrades legibly — not throws — on a status this build does not recognize', () => {
    const progress = deriveUserOperationProgress(
      userOpStatus({ status: 'reverted' as SafeRpcStatusResponse['status'] }),
    );

    expect(progress.recognizedStatus).toBe(false);
  });
});

describe('pollUserOperationStatus', () => {
  it('polls until `included`, the on-chain success terminal', async () => {
    const f = fakeFetch([
      { status: 200, body: userOpStatus({ status: 'submitted' }) },
      { status: 200, body: userOpStatus({ status: 'included', txn_hash: '0xtx' }) },
    ]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollUserOperationStatus({ client, userOpHash: '0xhash', ...clock });

    expect(outcome.kind).toBe('included');
    if (outcome.kind !== 'included') throw new Error('unreachable');
    expect(outcome.progress.txnHash).toBe('0xtx');
    expect(f.calls).toHaveLength(2);
  });

  it('returns `rejected` as a pre-submission terminal failure', async () => {
    const f = fakeFetch([{ status: 200, body: userOpStatus({ status: 'rejected' }) }]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollUserOperationStatus({ client, userOpHash: '0xhash', ...clock });

    expect(outcome.kind).toBe('rejected');
    expect(f.calls).toHaveLength(1);
  });

  it('retries a documented-degraded 503 ("still recorded as included") rather than reporting a hard error', async () => {
    const f = fakeFetch([
      { status: 503, body: { title: 'degraded', detail: 'retry later' }, headers: {} },
      { status: 200, body: userOpStatus({ status: 'included', txn_hash: '0xtx' }) },
    ]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollUserOperationStatus({
      client,
      userOpHash: '0xhash',
      intervalMs: 1_000,
      ...clock,
    });

    expect(outcome.kind).toBe('included');
    expect(f.calls).toHaveLength(2);
  });

  it('surfaces a non-retryable failure (404) as a value immediately', async () => {
    const f = fakeFetch([{ status: 404, body: { title: 'Not Found' } }]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollUserOperationStatus({ client, userOpHash: '0xhash', ...clock });

    expect(outcome.kind).toBe('error');
    expect(f.calls).toHaveLength(1);
  });

  it('stops issuing requests and returns `aborted` once the signal fires mid-poll', async () => {
    const f = fakeFetch([{ status: 200, body: userOpStatus({ status: 'submitted' }) }]);
    const client = clientWith(f);
    const controller = new AbortController();
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      if (f.calls.length === 1) controller.abort();
      void signal;
    });

    const outcome = await pollUserOperationStatus({
      client,
      userOpHash: '0xhash',
      signal: controller.signal,
      sleep,
      now: () => 0,
    });

    expect(outcome).toEqual({ kind: 'aborted' });
    expect(f.calls).toHaveLength(1);
  });
});
