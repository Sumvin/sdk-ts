import { describe, expect, it, vi } from 'vitest';
import { installErrorInterceptor, isApiError } from '../errors/index.js';
import { createClient, createConfig } from '../generated/client/index.js';
import type { OnboardingData, OnboardingStepsResponse } from '../generated/index.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import {
  deriveOnboardingProgress,
  ONBOARDING_STUCK_BACKOFF_MS,
  pollOnboardingUntilResolved,
} from './onboarding.js';

function clientWith(f: ReturnType<typeof fakeFetch>) {
  const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
  installErrorInterceptor(client);
  return client;
}

function onboarding(overrides: Partial<OnboardingData> = {}): OnboardingData {
  return {
    current_step: 'phone_verification',
    steps: [
      { step: 'created', status: 'completed' },
      { step: 'phone_verification', status: 'current' },
      { step: 'kyc_verification', status: 'pending' },
    ],
    is_complete: false,
    safe_creation_status: null,
    primary_smart_wallet_address: null,
    did_mint_status: null,
    did_token_id: null,
    ...overrides,
  };
}

function response(overrides: Partial<OnboardingData> = {}): OnboardingStepsResponse {
  return {
    _links: { self: { href: '/v0/user/me/onboarding/steps' } },
    onboarding: onboarding(overrides),
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

describe('deriveOnboardingProgress', () => {
  it('resolves a step mid-flow: current step found in `steps`, nothing complete yet', () => {
    const progress = deriveOnboardingProgress(response());

    expect(progress.currentStep).toBe('phone_verification');
    expect(progress.recognizedStep).toBe(true);
    expect(progress.resolved).toBe(true);
    expect(progress.isComplete).toBe(false);
    expect(progress.currentStepData).toEqual({ step: 'phone_verification', status: 'current' });
  });

  it('resolves the terminal state: `is_complete` true, capability facts populated', () => {
    const progress = deriveOnboardingProgress(
      response({
        current_step: 'complete',
        is_complete: true,
        safe_creation_status: 'completed',
        primary_smart_wallet_address: '0xabc',
        did_mint_status: 'completed',
        did_token_id: '42',
      }),
    );

    expect(progress.isComplete).toBe(true);
    expect(progress.resolved).toBe(true);
    expect(progress.safeCreationStatus).toBe('completed');
    expect(progress.primarySmartWalletAddress).toBe('0xabc');
    expect(progress.didMintStatus).toBe('completed');
    expect(progress.didTokenId).toBe('42');
  });

  it('resolves an in-flight capability fact: wallet provisioning still pending mid-step', () => {
    const progress = deriveOnboardingProgress(
      response({
        current_step: 'open_banking',
        steps: [
          { step: 'created', status: 'completed' },
          { step: 'phone_verification', status: 'completed' },
          { step: 'kyc_verification', status: 'completed' },
          { step: 'open_banking', status: 'current' },
        ],
        safe_creation_status: 'processing',
        primary_smart_wallet_address: null,
      }),
    );

    expect(progress.currentStep).toBe('open_banking');
    expect(progress.safeCreationStatus).toBe('processing');
    expect(progress.primarySmartWalletAddress).toBeNull();
    expect(progress.resolved).toBe(true);
  });

  it('degrades legibly — not throws — when `current_step` is not a step this build recognizes', () => {
    const drifted = response({
      // A future server could add a step this generated client predates.
      current_step: 'passport_verification' as OnboardingData['current_step'],
      steps: [{ step: 'created', status: 'completed' }],
    });

    const progress = deriveOnboardingProgress(drifted);

    expect(progress.recognizedStep).toBe(false);
    expect(progress.resolved).toBe(false);
    expect(progress.currentStepData).toBeUndefined();
  });

  it('is unresolved when `current_step` is a known step but racing ahead of the `steps` array', () => {
    // The backend advanced `current_step` but the per-step array hasn't
    // caught up yet — the exact race sumvin-app-v2's OnboardingRouter
    // stuck-state recovery exists for.
    const progress = deriveOnboardingProgress(
      response({
        current_step: 'kyc_verification',
        steps: [
          { step: 'created', status: 'completed' },
          { step: 'phone_verification', status: 'completed' },
        ],
      }),
    );

    expect(progress.recognizedStep).toBe(true);
    expect(progress.resolved).toBe(false);
  });
});

describe('pollOnboardingUntilResolved', () => {
  it('resolves on the first read without sleeping when the state is already legible', async () => {
    const f = fakeFetch([{ status: 200, body: response() }]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollOnboardingUntilResolved({ client, ...clock });

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') throw new Error('unreachable');
    expect(outcome.progress.currentStep).toBe('phone_verification');
    expect(f.calls).toHaveLength(1);
    expect(clock.waits).toEqual([0]); // the app's own first delay is `0`
  });

  it('backs off 0/1/2/4/8s (ONBOARDING_STUCK_BACKOFF_MS) while the state stays unresolved, then resolves', async () => {
    const stuck = response({
      current_step: 'kyc_verification',
      steps: [{ step: 'created', status: 'completed' }],
    });
    const settled = response({
      current_step: 'kyc_verification',
      steps: [
        { step: 'created', status: 'completed' },
        { step: 'kyc_verification', status: 'current' },
      ],
    });
    const f = fakeFetch([
      { status: 200, body: stuck },
      { status: 200, body: stuck },
      { status: 200, body: settled },
    ]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollOnboardingUntilResolved({ client, ...clock });

    expect(outcome.kind).toBe('resolved');
    expect(f.calls).toHaveLength(3);
    // Each of the 3 reads made is preceded by its own backoff delay: 0, 1_000, 2_000.
    expect(clock.waits).toEqual(ONBOARDING_STUCK_BACKOFF_MS.slice(0, 3));
  });

  it('returns `unresolved` — never throws — once every backoff attempt is exhausted', async () => {
    const stuck = response({
      current_step: 'kyc_verification',
      steps: [{ step: 'created', status: 'completed' }],
    });
    const f = fakeFetch([{ status: 200, body: stuck }]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollOnboardingUntilResolved({ client, ...clock });

    expect(outcome.kind).toBe('unresolved');
    if (outcome.kind !== 'unresolved') throw new Error('unreachable');
    expect(outcome.progress.resolved).toBe(false);
    expect(f.calls).toHaveLength(ONBOARDING_STUCK_BACKOFF_MS.length);
    expect(clock.waits).toEqual([...ONBOARDING_STUCK_BACKOFF_MS]);
  });

  it('surfaces a non-retryable server failure as a value immediately, never a throw', async () => {
    const f = fakeFetch([{ status: 401, body: { title: 'Unauthorized' } }]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollOnboardingUntilResolved({ client, ...clock });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(isApiError(outcome.error)).toBe(true);
    expect(f.calls).toHaveLength(1); // no retry loop on a hard, undocumented-as-transient error
  });

  it('spends the backoff retrying the documented-retryable 502, then reports `error` once exhausted', async () => {
    // The operation's own spec description names 502 as retryable ("the
    // flow that applies to this user cannot be resolved because a
    // dependency is unavailable"). It is treated as another "still stuck"
    // attempt rather than an immediate hard failure.
    const f = fakeFetch([{ status: 502, body: { title: 'Bad Gateway' } }]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollOnboardingUntilResolved({ client, ...clock });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(isApiError(outcome.error)).toBe(true);
    expect(f.calls).toHaveLength(ONBOARDING_STUCK_BACKOFF_MS.length);
    expect(clock.waits).toEqual([...ONBOARDING_STUCK_BACKOFF_MS]);
  });

  it('stops issuing requests and returns `aborted` once the signal fires mid-backoff', async () => {
    const stuck = response({
      current_step: 'kyc_verification',
      steps: [{ step: 'created', status: 'completed' }],
    });
    const f = fakeFetch([{ status: 200, body: stuck }]);
    const client = clientWith(f);
    const controller = new AbortController();
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      if (f.calls.length === 1) controller.abort();
      void signal;
    });

    const outcome = await pollOnboardingUntilResolved({
      client,
      signal: controller.signal,
      sleep,
      now: () => 0,
    });

    expect(outcome).toEqual({ kind: 'aborted' });
    expect(f.calls).toHaveLength(1);
  });
});
