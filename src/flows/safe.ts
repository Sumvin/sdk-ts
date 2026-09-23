import type { Client } from '../generated/client/index.js';
import type {
  OnboardingData,
  OnboardingSafeResponse,
  SafeRpcStatusResponse,
} from '../generated/index.js';
import { getOnboardingSteps, getUserOperationStatus } from '../generated/index.js';
import { zSafeOnboardingMode } from '../generated/zod.gen.js';
import { type Clock, type PollStep, pollUntil } from './poll.js';

/**
 * How often to re-check wallet-creation progress while it is in flight.
 * Matches the Sumvin web app's own interval: wallet creation completes
 * asynchronously on the server, so an unpolled read would strand a caller
 * on a stale `processing`.
 */
export const SAFE_CREATION_POLL_INTERVAL_MS = 8_000;

/** Total wall-clock budget for {@link pollSafeCreation} before it gives up. */
export const DEFAULT_SAFE_CREATION_POLL_DEADLINE_MS = 5 * 60 * 1_000;

/** Total wall-clock budget for {@link pollUserOperationStatus} before it gives up. */
export const DEFAULT_USER_OPERATION_POLL_DEADLINE_MS = 3 * 60 * 1_000;

/** How often to re-poll a submitted UserOperation's on-chain status. */
export const USER_OPERATION_POLL_INTERVAL_MS = 4_000;

// ---------------------------------------------------------------------------
// Cohort-specific reader: GET /v0/user/me/onboarding/safe
// ---------------------------------------------------------------------------

/**
 * The `GET /v0/user/me/onboarding/safe` response, reduced to what a
 * consumer needs to render the right cohort screen or decide whether one is
 * needed at all.
 *
 * `wallet` and `stepStatus` answer "is there anything left for the user to
 * do on THIS step" — they are not the wallet-creation completion signal.
 * {@link OnboardingSafeResponse}'s own doc names when `wallet` populates
 * for each `mode`, and none of those moments is guaranteed to coincide with
 * the authoritative status (`safe_creation_status === 'completed'`) that
 * actually gates "ready to transact" — see {@link deriveSafeCreationProgress}
 * for that.
 */
export interface SafeOnboardingState {
  /** `mode`, verbatim — including a value this build may not recognize. */
  readonly mode: OnboardingSafeResponse['mode'];
  /** Whether {@link mode} is one of the modes this build's spec pin knows about (`zSafeOnboardingMode`, generated). */
  readonly recognizedMode: boolean;
  /** `required` — `true` when the user still needs to act on this step. */
  readonly required: boolean;
  /** `step_status` — this step's own completed/current/pending/etc. status. */
  readonly stepStatus: OnboardingSafeResponse['step_status'];
  /** `wallet` — the user's wallet record, or `null` if none exists yet. */
  readonly wallet: OnboardingSafeResponse['wallet'] | null;
  /** `config`, verbatim — the cohort-specific data needed to render or complete this step. */
  readonly config: OnboardingSafeResponse['config'];
}

/**
 * Derives {@link SafeOnboardingState} from one `GET /v0/user/me/onboarding/safe`
 * response. Pure — makes no request.
 *
 * @example
 * const { data } = await getOnboardingSafe({ client });
 * const state = deriveSafeOnboardingState(data!);
 * if (state.mode === 'user_signed_deploy' && state.config.user_operation) {
 *   promptUserToSign(state.config.user_operation);
 * }
 */
export function deriveSafeOnboardingState(response: OnboardingSafeResponse): SafeOnboardingState {
  return {
    mode: response.mode,
    recognizedMode: zSafeOnboardingMode.safeParse(response.mode).success,
    required: response.required,
    stepStatus: response.step_status,
    wallet: response.wallet ?? null,
    config: response.config,
  };
}

// ---------------------------------------------------------------------------
// Authoritative wallet-status reader/poller: GET /v0/user/me/onboarding/steps
// ---------------------------------------------------------------------------

/**
 * The values `onboarding.safe_creation_status` is documented to take
 * (`OnboardingData.safe_creation_status`'s own TSDoc in `types.gen.ts`:
 * "pending / processing / completed / failed"). No generated Zod enum
 * exists for it — the field is typed as a plain `string` on purpose — so
 * this is the smallest artifact that can express recognition without
 * retyping a generated shape.
 */
const KNOWN_SAFE_CREATION_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'processing',
  'completed',
  'failed',
]);

const SAFE_CREATION_IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set(['pending', 'processing']);

/**
 * Wallet-creation progress, read from the authoritative onboarding fields
 * `onboarding.safe_creation_status` and
 * `onboarding.primary_smart_wallet_address` — the same fields
 * {@link OnboardingProgress} (`./onboarding.js`) surfaces as part of
 * general progression. This is a focused view over the identical source:
 * "is my wallet ready to transact," independent of where in the onboarding
 * flow the user currently stands.
 *
 * Deliberately NOT sourced from `GET /v0/user/me/onboarding/safe` or
 * `GET /v0/safe/config`: the former's `wallet` field has no completion
 * signal of its own (see {@link SafeOnboardingState}'s TSDoc), and the
 * latter (`/v0/safe/config`) is a stateless configuration lookup with no
 * notion of in-flight/completed/failed at all, so it cannot report progress
 * on anything.
 */
export interface SafeCreationProgress {
  /** `null` when creation has not started. Otherwise verbatim, including a value this build may not recognize. */
  readonly status: string | null;
  /** Whether {@link status} is `null` or one of {@link KNOWN_SAFE_CREATION_STATUSES}. */
  readonly recognizedStatus: boolean;
  /** Whether wallet creation is still running on the server — `pending` or `processing`. */
  readonly inFlight: boolean;
  /** `primary_smart_wallet_address` — populated once `status === 'completed'`. */
  readonly walletAddress: string | null;
}

/** Derives {@link SafeCreationProgress} from an `OnboardingData` (the body of `GET /v0/user/me/onboarding/steps`). */
export function deriveSafeCreationProgress(onboarding: OnboardingData): SafeCreationProgress {
  const status = onboarding.safe_creation_status ?? null;
  return {
    status,
    recognizedStatus: status === null || KNOWN_SAFE_CREATION_STATUSES.has(status),
    inFlight: status !== null && SAFE_CREATION_IN_FLIGHT_STATUSES.has(status),
    walletAddress: onboarding.primary_smart_wallet_address ?? null,
  };
}

/** The outcome of {@link pollSafeCreation} — always a value, never a throw. */
export type SafeCreationPollOutcome =
  | { readonly kind: 'completed'; readonly progress: SafeCreationProgress }
  | { readonly kind: 'failed'; readonly progress: SafeCreationProgress }
  | { readonly kind: 'not-started'; readonly progress: SafeCreationProgress }
  | { readonly kind: 'unrecognized'; readonly progress: SafeCreationProgress }
  | { readonly kind: 'timeout'; readonly progress: SafeCreationProgress }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'error'; readonly error: unknown };

/** Options for {@link pollSafeCreation}. */
export interface PollSafeCreationOptions extends Clock {
  readonly client: Client;
  readonly signal?: AbortSignal;
  /** @default {@link SAFE_CREATION_POLL_INTERVAL_MS} */
  readonly intervalMs?: number;
  /** @default {@link DEFAULT_SAFE_CREATION_POLL_DEADLINE_MS} */
  readonly deadlineMs?: number;
}

type SafeCreationAttempt =
  | { readonly kind: 'error'; readonly error: unknown }
  | {
      readonly kind: 'completed' | 'failed' | 'not-started' | 'unrecognized' | 'in-progress';
      readonly progress: SafeCreationProgress;
    };

/**
 * Re-reads `GET /v0/user/me/onboarding/steps` at
 * {@link SAFE_CREATION_POLL_INTERVAL_MS} until the wallet status
 * settles (`completed` or `failed`), until this build doesn't recognize the
 * reported status, until `deadlineMs` runs out, or until `signal` aborts.
 *
 * Every read is judged on its own — a `completed` observed on the very
 * first call ends the poll immediately, the same discipline
 * `pollKycVerification` and `pollOnboardingUntilResolved` both apply: this
 * poller never assumes it is the only writer of `safe_creation_status`, so
 * it never needs to have "seen" an in-flight status first.
 *
 * @example
 * const outcome = await pollSafeCreation({ client, signal });
 * switch (outcome.kind) {
 *   case 'completed':
 *     activateWallet(outcome.progress.walletAddress);
 *     break;
 *   case 'failed':
 *     showOperatorInterventionNotice();
 *     break;
 *   case 'not-started':
 *   case 'timeout':
 *   case 'unrecognized':
 *   case 'aborted':
 *   case 'error':
 *     break;
 * }
 */
export async function pollSafeCreation(
  options: PollSafeCreationOptions,
): Promise<SafeCreationPollOutcome> {
  const {
    client,
    signal,
    intervalMs = SAFE_CREATION_POLL_INTERVAL_MS,
    deadlineMs = DEFAULT_SAFE_CREATION_POLL_DEADLINE_MS,
    now,
    sleep,
  } = options;

  const step = async (): Promise<PollStep<SafeCreationAttempt>> => {
    const { data, error } = await getOnboardingSteps({ client, signal });
    if (!data) {
      return { done: true, value: { kind: 'error', error } };
    }

    const progress = deriveSafeCreationProgress(data.onboarding);
    if (!progress.recognizedStatus) {
      return { done: true, value: { kind: 'unrecognized', progress } };
    }
    if (progress.status === 'completed' || progress.status === 'failed') {
      return { done: true, value: { kind: progress.status, progress } };
    }
    if (!progress.inFlight) {
      // `null`: creation has not started.
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
      throw new Error('unreachable: account-setup poll timed out on a terminal attempt value');
    }
    return { kind: 'timeout', progress: result.value.progress };
  }

  const { value } = result;
  switch (value.kind) {
    case 'error':
      return { kind: 'error', error: value.error };
    case 'in-progress':
      throw new Error('unreachable: account-setup poll resolved on an in-progress attempt value');
    default:
      return { kind: value.kind, progress: value.progress };
  }
}

// ---------------------------------------------------------------------------
// On-chain finality poller for one submitted UserOperation:
// GET /v0/safe/rpc/{user_op_hash}/status
// ---------------------------------------------------------------------------

/**
 * The `status` values `SafeRpcStatusResponse.status` is documented to take
 * (its own TSDoc: "One of: `not_found`, `not_submitted`, `queued`,
 * `submitted`, `included`, `rejected`, `failed`"). No generated Zod enum
 * exists — the field is a plain `string` — so this is a literal set, not a
 * parallel enum.
 */
const KNOWN_USER_OPERATION_STATUSES: ReadonlySet<string> = new Set([
  'not_found',
  'not_submitted',
  'queued',
  'submitted',
  'included',
  'rejected',
  'failed',
]);

/** A single `GET /v0/safe/rpc/{user_op_hash}/status` read, reduced to what a consumer needs. */
export interface UserOperationProgress {
  readonly status: string;
  readonly recognizedStatus: boolean;
  readonly txnHash: string | null;
  readonly blockNumber: number | null;
}

/**
 * Derives {@link UserOperationProgress} from one
 * `GET /v0/safe/rpc/{user_op_hash}/status` response. Pure — makes no
 * request.
 */
export function deriveUserOperationProgress(status: SafeRpcStatusResponse): UserOperationProgress {
  return {
    status: status.status,
    recognizedStatus: KNOWN_USER_OPERATION_STATUSES.has(status.status),
    txnHash: status.txn_hash ?? null,
    blockNumber: status.block_number ?? null,
  };
}

/** The outcome of {@link pollUserOperationStatus} — always a value, never a throw. */
export type UserOperationPollOutcome =
  | { readonly kind: 'included'; readonly progress: UserOperationProgress }
  | { readonly kind: 'failed'; readonly progress: UserOperationProgress }
  | { readonly kind: 'rejected'; readonly progress: UserOperationProgress }
  | { readonly kind: 'unrecognized'; readonly progress: UserOperationProgress }
  | { readonly kind: 'timeout'; readonly progress: UserOperationProgress }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'error'; readonly error: unknown };

/** Options for {@link pollUserOperationStatus}. */
export interface PollUserOperationStatusOptions extends Clock {
  readonly client: Client;
  /** The hash returned by a submitted UserOperation — e.g. `SafeOnboardingState.config.user_op_hash` for `user_signed_deploy`. */
  readonly userOpHash: string;
  readonly signal?: AbortSignal;
  /** @default {@link USER_OPERATION_POLL_INTERVAL_MS} */
  readonly intervalMs?: number;
  /** @default {@link DEFAULT_USER_OPERATION_POLL_DEADLINE_MS} */
  readonly deadlineMs?: number;
}

type UserOperationAttempt =
  | { readonly kind: 'error'; readonly error: unknown }
  | {
      readonly kind: 'included' | 'failed' | 'rejected' | 'unrecognized' | 'in-progress';
      readonly progress: UserOperationProgress;
    };

const USER_OPERATION_TERMINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'rejected',
]);

/**
 * Re-polls `GET /v0/safe/rpc/{user_op_hash}/status` at
 * {@link USER_OPERATION_POLL_INTERVAL_MS} until the UserOperation reaches an
 * on-chain terminal state, until this build doesn't recognize the reported
 * status, until `deadlineMs` runs out, or until `signal` aborts.
 *
 * A `503` is treated as still in flight rather than a hard error: the
 * operation's own spec description documents it as transient — "Finalisation
 * is in a degraded state due to a transient downstream failure. The
 * UserOperation is still recorded as included; clients should retry the
 * status poll after the interval given by the `Retry-After` response
 * header" (`spec/openapi.json`, `GET /v0/safe/rpc/{user_op_hash}/status`
 * `503`). Every other error ends the poll immediately.
 *
 * Used after submitting a signed UserOperation for the `user_signed_deploy`
 * cohort (`SafeOnboardingState.config.user_op_hash`, once
 * `SubmitOnboardingSafe` returns `202`) — {@link pollSafeCreation} is the
 * cohort-agnostic "is my wallet ready" signal; this is the on-chain-finality
 * detail for that one specific submission.
 *
 * @example
 * const outcome = await pollUserOperationStatus({ client, userOpHash, signal });
 * if (outcome.kind === 'included') {
 *   recordTxnHash(outcome.progress.txnHash);
 * }
 */
export async function pollUserOperationStatus(
  options: PollUserOperationStatusOptions,
): Promise<UserOperationPollOutcome> {
  const {
    client,
    userOpHash,
    signal,
    intervalMs = USER_OPERATION_POLL_INTERVAL_MS,
    deadlineMs = DEFAULT_USER_OPERATION_POLL_DEADLINE_MS,
    now,
    sleep,
  } = options;

  const step = async (): Promise<PollStep<UserOperationAttempt>> => {
    const { data, error, response } = await getUserOperationStatus({
      client,
      path: { user_op_hash: userOpHash },
      signal,
    });
    if (!data) {
      return { done: response?.status !== 503, value: { kind: 'error', error } };
    }

    const progress = deriveUserOperationProgress(data);
    if (!progress.recognizedStatus) {
      return { done: true, value: { kind: 'unrecognized', progress } };
    }
    if (progress.status === 'included') {
      return { done: true, value: { kind: 'included', progress } };
    }
    if (USER_OPERATION_TERMINAL_FAILURE_STATUSES.has(progress.status)) {
      return { done: true, value: { kind: progress.status as 'failed' | 'rejected', progress } };
    }
    return { done: false, value: { kind: 'in-progress', progress } };
  };

  const result = await pollUntil(step, { intervalMs, deadlineMs, signal, now, sleep });

  if (result.kind === 'aborted') {
    return { kind: 'aborted' };
  }

  // Checked before the done/timeout split — mirroring
  // `pollOnboardingUntilResolved` (`onboarding.ts`) — because a persistent
  // 503 is non-terminal (`step` reports `done: false`) and so can still be
  // the last attempt value when the deadline runs out. Without this check
  // first, a timed-out 503 would fall into the `timeout` branch still
  // carrying `kind: 'error'` and trip the unreachable guard below, breaking
  // this function's own documented contract ("always a value, never a
  // throw") on exactly the degraded-503 path it has a special branch for.
  if (result.value.kind === 'error') {
    return { kind: 'error', error: result.value.error };
  }

  if (result.kind === 'timeout') {
    if (result.value.kind !== 'in-progress') {
      throw new Error('unreachable: operation-status poll timed out on a terminal attempt value');
    }
    return { kind: 'timeout', progress: result.value.progress };
  }

  const { value } = result;
  switch (value.kind) {
    case 'in-progress':
      throw new Error(
        'unreachable: operation-status poll resolved on an in-progress attempt value',
      );
    default:
      return { kind: value.kind, progress: value.progress };
  }
}
