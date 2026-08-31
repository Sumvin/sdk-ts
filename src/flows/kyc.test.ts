import { describe, expect, it, vi } from 'vitest';
import { installErrorInterceptor, isApiError } from '../errors/index.js';
import { createClient, createConfig } from '../generated/client/index.js';
import type { KycRequiredDocsResponse, KycStatusResponse } from '../generated/index.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import {
  deriveKycProgress,
  deriveOutstandingDocs,
  KYC_POLL_INTERVAL_MS,
  pollKycVerification,
} from './kyc.js';

function clientWith(f: ReturnType<typeof fakeFetch>) {
  const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
  installErrorInterceptor(client);
  return client;
}

function kycStatus(overrides: Partial<KycStatusResponse> = {}): KycStatusResponse {
  return {
    _links: { self: { href: '/v0/kyc/status' } },
    status: 'pending',
    applicant_id: null,
    verified_at: null,
    rejected_at: null,
    reject_reason: null,
    ...overrides,
  };
}

function requiredDocs(overrides: Partial<KycRequiredDocsResponse> = {}): KycRequiredDocsResponse {
  return {
    _links: { self: { href: '/v0/kyc/documents/required' } },
    steps: [
      { step_type: 'IDENTITY', has_documents: true },
      { step_type: 'SELFIE', has_documents: false },
    ],
    all_uploaded: false,
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

describe('deriveKycProgress', () => {
  it('reads a not-started applicant: `pending`, nothing in flight', () => {
    const progress = deriveKycProgress(kycStatus());

    expect(progress.status).toBe('pending');
    expect(progress.recognizedStatus).toBe(true);
    expect(progress.inFlight).toBe(false);
  });

  it('reads an in-flight applicant: `in_progress` while a Sumsub webhook is pending', () => {
    const progress = deriveKycProgress(kycStatus({ status: 'in_progress', applicant_id: 'app_1' }));

    expect(progress.inFlight).toBe(true);
    expect(progress.applicantId).toBe('app_1');
  });

  it('reads a terminal approval, with `verified_at` populated', () => {
    const progress = deriveKycProgress(
      kycStatus({ status: 'approved', verified_at: 1_700_000_000_000 }),
    );

    expect(progress.status).toBe('approved');
    expect(progress.inFlight).toBe(false);
    expect(progress.verifiedAt).toBe(1_700_000_000_000);
  });

  it('degrades legibly — not throws — on a status value this build does not recognize', () => {
    const progress = deriveKycProgress(
      kycStatus({ status: 'expired' as KycStatusResponse['status'] }),
    );

    expect(progress.status).toBe('expired');
    expect(progress.recognizedStatus).toBe(false);
    expect(progress.inFlight).toBe(false);
  });
});

describe('deriveOutstandingDocs', () => {
  it('names the outstanding steps: those without documents uploaded', () => {
    const outstanding = deriveOutstandingDocs(requiredDocs());

    expect(outstanding.allUploaded).toBe(false);
    expect(outstanding.outstanding).toEqual([{ step_type: 'SELFIE', has_documents: false }]);
  });

  it('reports nothing outstanding once every step has documents', () => {
    const outstanding = deriveOutstandingDocs(
      requiredDocs({
        steps: [{ step_type: 'IDENTITY', has_documents: true }],
        all_uploaded: true,
      }),
    );

    expect(outstanding.allUploaded).toBe(true);
    expect(outstanding.outstanding).toEqual([]);
  });
});

describe('pollKycVerification', () => {
  it('returns `not-started` immediately for `pending` — nothing to wait on', async () => {
    const f = fakeFetch([{ status: 200, body: kycStatus({ status: 'pending' }) }]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollKycVerification({ client, ...clock });

    expect(outcome.kind).toBe('not-started');
    expect(f.calls).toHaveLength(1);
    expect(clock.waits).toEqual([]);
  });

  it('polls at KYC_POLL_INTERVAL_MS while `in_progress`, then returns `approved`', async () => {
    const f = fakeFetch([
      { status: 200, body: kycStatus({ status: 'in_progress' }) },
      { status: 200, body: kycStatus({ status: 'in_progress' }) },
      { status: 200, body: kycStatus({ status: 'approved', verified_at: 1 }) },
    ]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollKycVerification({ client, ...clock });

    expect(outcome.kind).toBe('approved');
    if (outcome.kind !== 'approved') throw new Error('unreachable');
    expect(outcome.progress.verifiedAt).toBe(1);
    expect(f.calls).toHaveLength(3);
    expect(clock.waits).toEqual([KYC_POLL_INTERVAL_MS, KYC_POLL_INTERVAL_MS]);
  });

  it(
    'returns `rejected` the moment the server reports it — the drift case: the server ' +
      'settles before the client ever observed `in_progress`',
    async () => {
      // The poller starts fresh — it never assumed the applicant had to pass
      // through `in_progress` on this client's watch. A rejection observed on
      // the very first read is just as terminal as one observed on the tenth.
      const f = fakeFetch([
        {
          status: 200,
          body: kycStatus({ status: 'rejected', rejected_at: 5, reject_reason: 'doc mismatch' }),
        },
      ]);
      const client = clientWith(f);
      const clock = fakeClock();

      const outcome = await pollKycVerification({ client, ...clock });

      expect(outcome.kind).toBe('rejected');
      if (outcome.kind !== 'rejected') throw new Error('unreachable');
      expect(outcome.progress.rejectReason).toBe('doc mismatch');
      expect(f.calls).toHaveLength(1);
      expect(clock.waits).toEqual([]);
    },
  );

  it('stops and reports `unrecognized` on a status this build does not know, rather than looping on it', async () => {
    const f = fakeFetch([
      { status: 200, body: kycStatus({ status: 'expired' as KycStatusResponse['status'] }) },
    ]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollKycVerification({ client, ...clock });

    expect(outcome.kind).toBe('unrecognized');
    expect(f.calls).toHaveLength(1);
  });

  it('returns `timeout` with the last observed progress once `deadlineMs` is exhausted', async () => {
    const f = fakeFetch([{ status: 200, body: kycStatus({ status: 'in_progress' }) }]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollKycVerification({
      client,
      intervalMs: 8_000,
      deadlineMs: 20_000,
      ...clock,
    });

    expect(outcome.kind).toBe('timeout');
    if (outcome.kind !== 'timeout') throw new Error('unreachable');
    expect(outcome.progress.status).toBe('in_progress');
    expect(f.calls.length).toBeGreaterThan(1);
  });

  it('surfaces a request failure as a value, never a throw', async () => {
    const f = fakeFetch([{ status: 500, body: { title: 'Internal Server Error' } }]);
    const client = clientWith(f);
    const clock = fakeClock();

    const outcome = await pollKycVerification({ client, ...clock });

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(isApiError(outcome.error)).toBe(true);
  });

  it('stops issuing requests and returns `aborted` once the signal fires mid-poll', async () => {
    const f = fakeFetch([{ status: 200, body: kycStatus({ status: 'in_progress' }) }]);
    const client = clientWith(f);
    const controller = new AbortController();
    const sleep = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      if (f.calls.length === 1) controller.abort();
      void signal;
    });

    const outcome = await pollKycVerification({
      client,
      signal: controller.signal,
      sleep,
      now: () => 0,
    });

    expect(outcome).toEqual({ kind: 'aborted' });
    expect(f.calls).toHaveLength(1);
  });
});
