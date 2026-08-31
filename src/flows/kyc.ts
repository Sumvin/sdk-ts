import type { Client } from '../generated/client/index.js';
import type {
  KycRequiredDocsResponse,
  KycRequiredStep,
  KycStatusResponse,
} from '../generated/index.js';
import { getKycStatus } from '../generated/index.js';
import { type Clock, type PollStep, pollUntil } from './poll.js';

/**
 * How often to re-check `GET /v0/kyc/status` while verification is in
 * flight. Matches sumvin-app-v2's `KYC_POLL_INTERVAL_MS`
 * (`src/lib/api/hooks/queries/use-kyc.ts`): approval lands asynchronously
 * via a Sumsub webhook, typically 30-60s after submission, so an unpolled
 * read would strand a caller on a stale `in_progress`.
 */
export const KYC_POLL_INTERVAL_MS = 8_000;

/** Total wall-clock budget for {@link pollKycVerification} before it gives up. @default */
export const DEFAULT_KYC_POLL_DEADLINE_MS = 5 * 60 * 1_000;

/**
 * The `status` values this SDK's spec pin knows about. No generated Zod
 * enum exists for `KycStatusResponse.status` — the spec types it as a plain
 * `string` on purpose (`zKycStatusResponse` in `zod.gen.ts`) — so this is
 * the smallest artifact that can express recognition without retyping a
 * generated shape: a literal set, not a parallel enum.
 */
const KNOWN_KYC_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'retry',
  'approved',
  'rejected',
]);

/**
 * Statuses with an async Sumsub webhook actually in flight. Matches
 * sumvin-app-v2's `WEBHOOK_PENDING_KYC_STATUSES`: `pending` has nothing
 * running yet (verification hasn't started), so it is deliberately excluded
 * — polling it would wait forever for a webhook that was never fired.
 */
const KYC_IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(['in_progress', 'retry']);

/** A single `GET /v0/kyc/status` read, reduced to what a consumer needs to act on. */
export interface KycProgress {
  /** `status`, verbatim — including a value this build may not recognize. */
  readonly status: string;
  /** Whether {@link status} is one of the documented values (see {@link KNOWN_KYC_STATUSES}). */
  readonly recognizedStatus: boolean;
  /** Whether a Sumsub webhook is actively expected — `in_progress` or `retry`. */
  readonly inFlight: boolean;
  readonly applicantId: string | null;
  readonly verifiedAt: number | null;
  readonly rejectedAt: number | null;
  readonly rejectReason: string | null;
}

/**
 * Derives {@link KycProgress} from one `GET /v0/kyc/status` response. Pure —
 * makes no request.
 *
 * @example
 * const { data } = await getKycStatus({ client });
 * const progress = deriveKycProgress(data!);
 * if (progress.status === 'approved') unlockFeature();
 */
export function deriveKycProgress(status: KycStatusResponse): KycProgress {
  return {
    status: status.status,
    recognizedStatus: KNOWN_KYC_STATUSES.has(status.status),
    inFlight: KYC_IN_FLIGHT_STATUSES.has(status.status),
    applicantId: status.applicant_id,
    verifiedAt: status.verified_at,
    rejectedAt: status.rejected_at,
    rejectReason: status.reject_reason,
  };
}

/** What remains, derived from one `GET /v0/kyc/documents/required` response. */
export interface KycOutstandingDocs {
  readonly allUploaded: boolean;
  readonly outstanding: readonly KycRequiredStep[];
  readonly steps: readonly KycRequiredStep[];
}

/**
 * Derives {@link KycOutstandingDocs} from one `GET /v0/kyc/documents/required`
 * response. `allUploaded` falls back to computing from `steps` when the
 * server omits it (both are optional in the generated type) — a caller
 * should never have to special-case an absent flag whose value the steps
 * array already implies.
 *
 * @example
 * const { data } = await getKycRequiredDocs({ client });
 * const { outstanding } = deriveOutstandingDocs(data!);
 * outstanding.forEach((step) => promptUpload(step.step_type));
 */
export function deriveOutstandingDocs(docs: KycRequiredDocsResponse): KycOutstandingDocs {
  const steps = docs.steps ?? [];
  return {
    allUploaded: docs.all_uploaded ?? steps.every((step) => step.has_documents === true),
    outstanding: steps.filter((step) => !step.has_documents),
    steps,
  };
}

/** The outcome of {@link pollKycVerification} — always a value, never a throw. */
export type KycPollOutcome =
  | { readonly kind: 'approved'; readonly progress: KycProgress }
  | { readonly kind: 'rejected'; readonly progress: KycProgress }
  | { readonly kind: 'not-started'; readonly progress: KycProgress }
  | { readonly kind: 'unrecognized'; readonly progress: KycProgress }
  | { readonly kind: 'timeout'; readonly progress: KycProgress }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'error'; readonly error: unknown };

/** Options for {@link pollKycVerification}. */
export interface PollKycOptions extends Clock {
  readonly client: Client;
  readonly signal?: AbortSignal;
  /** @default {@link KYC_POLL_INTERVAL_MS} */
  readonly intervalMs?: number;
  /** @default {@link DEFAULT_KYC_POLL_DEADLINE_MS} */
  readonly deadlineMs?: number;
}

type KycAttempt =
  | { readonly kind: 'error'; readonly error: unknown }
  | {
      readonly kind: 'approved' | 'rejected' | 'not-started' | 'unrecognized' | 'in-progress';
      readonly progress: KycProgress;
    };

/**
 * Re-reads `GET /v0/kyc/status` at {@link KYC_POLL_INTERVAL_MS} until the
 * applicant reaches a terminal state (`approved`/`rejected`), until this
 * build doesn't recognize the reported status, until `deadlineMs` runs out,
 * or until `signal` aborts.
 *
 * Every read is judged independently, on its own merits — the poller never
 * assumes it previously observed `in_progress` before treating a read as
 * terminal. A `rejected` (or `approved`) seen on the very first call ends
 * the poll immediately, exactly as one seen on the tenth would: this is
 * D8's "react to drift, not fight it" applied to KYC, the same discipline
 * `pollOnboardingUntilResolved` applies to the onboarding cursor.
 *
 * `pending` returns `not-started` on the very first read without waiting —
 * there is nothing in flight to wait on (mirrors sumvin-app-v2's
 * `WEBHOOK_PENDING_KYC_STATUSES` exclusion of `pending`: nothing has been
 * submitted for that applicant yet, so polling would wait for a webhook
 * that was never triggered).
 *
 * @example
 * const outcome = await pollKycVerification({ client, signal });
 * switch (outcome.kind) {
 *   case 'approved':
 *     unlockFeature();
 *     break;
 *   case 'rejected':
 *     showRejection(outcome.progress.rejectReason);
 *     break;
 *   case 'not-started':
 *     promptToStartKyc();
 *     break;
 *   case 'timeout':
 *     showStillPendingScreen();
 *     break;
 *   case 'unrecognized':
 *   case 'aborted':
 *   case 'error':
 *     break;
 * }
 */
export async function pollKycVerification(options: PollKycOptions): Promise<KycPollOutcome> {
  const {
    client,
    signal,
    intervalMs = KYC_POLL_INTERVAL_MS,
    deadlineMs = DEFAULT_KYC_POLL_DEADLINE_MS,
    now,
    sleep,
  } = options;

  const step = async (): Promise<PollStep<KycAttempt>> => {
    const { data, error } = await getKycStatus({ client, signal });
    if (!data) {
      // Narrowing on `data` rather than `error`: `GetKycStatusErrors` types
      // its `404` branch as `unknown` (no schema for "no KYC in progress"),
      // which collapses the whole error union to `unknown` and defeats
      // TypeScript's discriminated-union narrowing on `error` — `data` has
      // no such hole, so it narrows cleanly.
      return { done: true, value: { kind: 'error', error } };
    }

    const progress = deriveKycProgress(data);
    if (!progress.recognizedStatus) {
      return { done: true, value: { kind: 'unrecognized', progress } };
    }
    if (progress.status === 'approved' || progress.status === 'rejected') {
      return { done: true, value: { kind: progress.status, progress } };
    }
    if (!progress.inFlight) {
      // `pending`: nothing running to wait on.
      return { done: true, value: { kind: 'not-started', progress } };
    }
    return { done: false, value: { kind: 'in-progress', progress } };
  };

  const result = await pollUntil(step, { intervalMs, deadlineMs, signal, now, sleep });

  if (result.kind === 'aborted') {
    return { kind: 'aborted' };
  }

  if (result.kind === 'timeout') {
    if (result.value.kind !== 'in-progress') {
      // Unreachable by construction: `step` only ever returns `done: false`
      // (which is what produces a `timeout`) for the `'in-progress'` case.
      throw new Error('unreachable: KYC poll timed out on a terminal attempt value');
    }
    return { kind: 'timeout', progress: result.value.progress };
  }

  const { value } = result;
  switch (value.kind) {
    case 'error':
      return { kind: 'error', error: value.error };
    case 'in-progress':
      // Unreachable: `step` never reports `done: true` for `'in-progress'`.
      throw new Error('unreachable: KYC poll resolved on an in-progress attempt value');
    default:
      return { kind: value.kind, progress: value.progress };
  }
}
