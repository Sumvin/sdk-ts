/**
 * `src/flows` — progression readers over onboarding, KYC, and Safe-wallet
 * state, not state machines.
 *
 * Each reader derives what to show or do next from capability facts the
 * server reports, and never assumes it is the only writer of that state.
 * Two sources make this load-bearing (see each module's own TSDoc for the
 * full reasoning):
 *
 * - Socrates Canon LBD 2026-JUL-14 — "capability facts authoritative over
 *   UX cursors: completion state reads `safe_creation_status`,
 *   `primary_smart_wallet_address`, `did_mint_status`, `did_token_id`,
 *   never the reverse."
 * - sumvin-app-v2 retro 2026-MAY-20 — onboarding has multiple concurrent
 *   writers (the client, SumSub webhooks, phone-verify auto-advance, Safe
 *   finalisation); a client that assumes sole ownership produces stuck
 *   CTAs, double submits, and trapped users.
 *
 * Every poller here (`pollOnboardingUntilResolved`, `pollKycVerification`,
 * `pollSafeCreation`, `pollUserOperationStatus`) takes an injected clock so
 * tests never actually wait, honors an `AbortSignal` at every await, has a
 * hard deadline, and reports a terminal condition — success, failure,
 * timeout, or a state this build doesn't recognize — as a typed value.
 * None of them throw for anything the server reports; see `./poll.js` for
 * the shared engine underneath all four.
 */
export {
  DEFAULT_KYC_POLL_DEADLINE_MS,
  deriveKycProgress,
  deriveOutstandingDocs,
  KYC_POLL_INTERVAL_MS,
  type KycOutstandingDocs,
  type KycPollOutcome,
  type KycProgress,
  type PollKycOptions,
  pollKycVerification,
} from './kyc.js';
export {
  deriveOnboardingProgress,
  ONBOARDING_STUCK_BACKOFF_MS,
  type OnboardingPollOutcome,
  type OnboardingProgress,
  type PollOnboardingOptions,
  pollOnboardingUntilResolved,
} from './onboarding.js';
export {
  DEFAULT_SAFE_CREATION_POLL_DEADLINE_MS,
  DEFAULT_USER_OPERATION_POLL_DEADLINE_MS,
  deriveSafeCreationProgress,
  deriveSafeOnboardingState,
  deriveUserOperationProgress,
  type PollSafeCreationOptions,
  type PollUserOperationStatusOptions,
  pollSafeCreation,
  pollUserOperationStatus,
  SAFE_CREATION_POLL_INTERVAL_MS,
  type SafeCreationPollOutcome,
  type SafeCreationProgress,
  type SafeOnboardingState,
  USER_OPERATION_POLL_INTERVAL_MS,
  type UserOperationPollOutcome,
  type UserOperationProgress,
} from './safe.js';
