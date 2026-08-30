import type { Client } from '../generated/client/index.js';
import type {
  OnboardingStep,
  OnboardingStepData,
  OnboardingStepsResponse,
} from '../generated/index.js';
import { getOnboardingSteps } from '../generated/index.js';
import { zOnboardingStep } from '../generated/zod.gen.js';
import { type Clock, type PollStep, runBoundedBackoff } from './poll.js';

/**
 * The onboarding state machine's own bounded backoff for a "stuck" read —
 * `current_step` doesn't (yet) have a matching entry in `steps`, most often
 * because a background transition (a Sumsub webhook, the Safe-finalisation
 * reconciler) is still catching up to a step the user just submitted.
 *
 * Ported verbatim from sumvin-app-v2's `OnboardingRouter`
 * (`src/components/onboarding/onboarding-router.tsx`, `STUCK_MAX_ATTEMPTS` /
 * `STUCK_BASE_DELAY_MS`): a `0` first delay so the retry fires immediately
 * once a stuck read is detected, then `1s, 2s, 4s, 8s` — a ~15s ceiling that
 * gives a slow webhook enough wall-clock to land without the client waiting
 * forever.
 */
export const ONBOARDING_STUCK_BACKOFF_MS: readonly number[] = [0, 1_000, 2_000, 4_000, 8_000];

/**
 * A single onboarding read, reduced to what a consumer actually needs to
 * act: the current step (and whether that step is even one this build
 * recognizes), whether the step's own entry in `steps` has caught up yet,
 * and the Canon-authoritative capability facts for wallet and identity-token
 * provisioning.
 *
 * Per Socrates Canon LBD 2026-JUL-14 ("capability facts authoritative over
 * UX cursors: completion state reads `safe_creation_status`,
 * `primary_smart_wallet_address`, `did_mint_status`, `did_token_id`, never
 * the reverse") — `isComplete` is the user-facing cursor and is exactly
 * that, a cursor: it can be `true` while wallet provisioning is still in
 * flight. A consumer deciding "is the wallet ready to transact" reads
 * {@link safeCreationStatus} and {@link primarySmartWalletAddress}, never
 * {@link isComplete} alone.
 */
export interface OnboardingProgress {
  /** `onboarding.current_step`, verbatim — including a value this build may not recognize. */
  readonly currentStep: OnboardingStep;
  /**
   * Whether {@link currentStep} is one of the step values this generated
   * client's spec pin knows about (`zOnboardingStep`, generated — never a
   * hand-written list). `false` means the server's spec has moved ahead of
   * this SDK's generated types: a legible drift signal, not a crash.
   */
  readonly recognizedStep: boolean;
  /** `onboarding.is_complete` — the user-facing cursor. See this type's own doc for why it is not a completion proof. */
  readonly isComplete: boolean;
  /** `onboarding.steps`, verbatim. */
  readonly steps: readonly OnboardingStepData[];
  /** The entry in {@link steps} whose `step` equals {@link currentStep}, if the two currently agree. */
  readonly currentStepData: OnboardingStepData | undefined;
  /**
   * `true` once this read is legible enough to act on: either onboarding is
   * complete, or {@link currentStepData} was found. `false` is the "stuck"
   * condition {@link pollOnboardingUntilResolved} exists to wait out —
   * `current_step` raced ahead of (or fell outside) `steps`.
   */
  readonly resolved: boolean;
  /** `onboarding.safe_creation_status` — `null` when Safe creation has not started. Canon capability fact. */
  readonly safeCreationStatus: string | null;
  /** `onboarding.primary_smart_wallet_address` — populated once `safeCreationStatus === 'completed'`. Canon capability fact. */
  readonly primarySmartWalletAddress: string | null;
  /** `onboarding.did_mint_status` — `null` when identity-token minting has not started. Canon capability fact. */
  readonly didMintStatus: string | null;
  /** `onboarding.did_token_id` — populated once `didMintStatus === 'completed'`. Canon capability fact. */
  readonly didTokenId: string | null;
}

/**
 * Derives {@link OnboardingProgress} from one `GET /v0/user/me/onboarding/steps`
 * response. Pure — makes no request, follows no link — so a caller who
 * already has a response (from a mutation's own body, e.g.) doesn't need to
 * re-fetch just to compute this.
 *
 * @example
 * const { data } = await getOnboardingSteps({ client });
 * const progress = deriveOnboardingProgress(data!);
 * if (!progress.resolved) {
 *   // current_step raced ahead of `steps` — re-read, don't route yet.
 * } else if (progress.currentStepData?.status === 'current') {
 *   renderStep(progress.currentStep);
 * }
 */
export function deriveOnboardingProgress(response: OnboardingStepsResponse): OnboardingProgress {
  const { onboarding } = response;
  const currentStepData = onboarding.steps.find((step) => step.step === onboarding.current_step);

  return {
    currentStep: onboarding.current_step,
    recognizedStep: zOnboardingStep.safeParse(onboarding.current_step).success,
    isComplete: onboarding.is_complete,
    steps: onboarding.steps,
    currentStepData,
    resolved: onboarding.is_complete || currentStepData !== undefined,
    safeCreationStatus: onboarding.safe_creation_status ?? null,
    primarySmartWalletAddress: onboarding.primary_smart_wallet_address ?? null,
    didMintStatus: onboarding.did_mint_status ?? null,
    didTokenId: onboarding.did_token_id ?? null,
  };
}

/** The outcome of {@link pollOnboardingUntilResolved} — always a value, never a throw. */
export type OnboardingPollOutcome =
  | { readonly kind: 'resolved'; readonly progress: OnboardingProgress }
  | { readonly kind: 'unresolved'; readonly progress: OnboardingProgress }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'error'; readonly error: unknown };

/** Options for {@link pollOnboardingUntilResolved}. */
export interface PollOnboardingOptions extends Clock {
  readonly client: Client;
  readonly signal?: AbortSignal;
  /** @default {@link ONBOARDING_STUCK_BACKOFF_MS} */
  readonly delaysMs?: readonly number[];
}

type OnboardingAttempt =
  | { readonly kind: 'progress'; readonly progress: OnboardingProgress }
  | { readonly kind: 'error'; readonly error: unknown };

async function readOnboarding(
  client: Client,
  signal: AbortSignal | undefined,
): Promise<PollStep<OnboardingAttempt>> {
  const { data, error, response } = await getOnboardingSteps({ client, signal });
  if (!data) {
    // The operation's own spec description names 502 as retryable ("the
    // flow that applies to this user cannot be resolved because a
    // dependency is unavailable; the read is retryable") — treated as
    // another "still stuck" attempt, spending one of the bounded backoff's
    // delays rather than surfacing immediately. Every other error (401,
    // 404, 422, an aborted/network failure) is not documented as
    // transient, so it ends the poll right away as `{ kind: 'error' }`.
    return { done: response?.status !== 502, value: { kind: 'error', error } };
  }
  const progress = deriveOnboardingProgress(data);
  return { done: progress.resolved, value: { kind: 'progress', progress } };
}

/**
 * Re-reads `GET /v0/user/me/onboarding/steps` with
 * {@link ONBOARDING_STUCK_BACKOFF_MS}'s bounded backoff until
 * {@link OnboardingProgress.resolved} is `true`, ports sumvin-app-v2's
 * `OnboardingRouter` stuck-state recovery (see that type's TSDoc) as a
 * standalone read rather than a router side effect.
 *
 * This is D8 in practice: onboarding state has multiple concurrent writers
 * (the client's own submission, SumSub webhooks, phone-verify auto-advance,
 * Safe finalisation — sumvin-app-v2 retro 2026-MAY-20) and this function
 * never assumes it is the only one. It reacts to a transiently inconsistent
 * read by waiting and re-reading, and gives up legibly — `unresolved`, not
 * an exception — rather than fighting the server for an answer it hasn't
 * settled on yet.
 *
 * A request failure (any `result.error`, including the documented
 * retryable `502` — "the flow that applies to this user cannot be
 * resolved") is surfaced immediately as `{ kind: 'error' }` rather than
 * retried through the backoff: a hard failure and a mid-transition read are
 * different conditions with different remedies, and folding them together
 * would hide a genuine outage behind "still stuck."
 *
 * @example
 * const outcome = await pollOnboardingUntilResolved({ client, signal });
 * switch (outcome.kind) {
 *   case 'resolved':
 *     renderStep(outcome.progress.currentStep);
 *     break;
 *   case 'unresolved':
 *     showStuckRecoveryScreen();
 *     break;
 *   case 'aborted':
 *     break; // caller cancelled — nothing to report
 *   case 'error':
 *     reportOutage(outcome.error);
 *     break;
 * }
 */
export async function pollOnboardingUntilResolved(
  options: PollOnboardingOptions,
): Promise<OnboardingPollOutcome> {
  const { client, signal, delaysMs = ONBOARDING_STUCK_BACKOFF_MS, now, sleep } = options;

  const result = await runBoundedBackoff<OnboardingAttempt>(
    () => readOnboarding(client, signal),
    delaysMs,
    { now, sleep, signal },
  );

  if (result.kind === 'aborted') {
    return { kind: 'aborted' };
  }

  if (result.value.kind === 'error') {
    return { kind: 'error', error: result.value.error };
  }

  return result.kind === 'done'
    ? { kind: 'resolved', progress: result.value.progress }
    : { kind: 'unresolved', progress: result.value.progress };
}
