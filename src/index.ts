/**
 * `@sumvin/sdk` — core barrel.
 *
 * Framework-free by design: no React, no TanStack Query import anywhere in this file
 * or anything it pulls in. That is enforced at source, not just by omission here — the
 * `@tanstack/react-query` hey-api plugin is configured with `includeInEntry: false` in
 * `openapi-ts.config.ts`, so the generated TanStack artifact is never part of
 * `src/generated/index.ts` in the first place. The TanStack integration lives at
 * `@sumvin/sdk/react`.
 *
 * The fetch client: the pre-configured singleton, the factory functions to build your own
 * client, and the supporting types below — including `ClientMeta`, an empty interface
 * consumers augment (via declaration merging against
 * `@sumvin/sdk/generated/core/types.gen`, see the `./generated/*` package export) to attach
 * their own per-request metadata. That augmentation only reaches call sites typed
 * through `@sumvin/sdk/generated/*` — this barrel's declarations are dts-rolled-up into a
 * single file, which duplicates `ClientMeta` rather than referencing it, so declaration
 * merging cannot cross that boundary. `client` (the singleton) and `createClient`/
 * `createConfig` (the factory) come from two distinct generated modules — `client.gen.ts`
 * and `client/index.ts` respectively — both re-exported below under their own names,
 * deliberately not merged via a single `export *`: `client.gen.ts` declares its own internal
 * `CreateClientConfig` alias that would collide with the canonical one re-exported from
 * `client/index.ts`.
 *
 * Everything below the generated re-exports is the curated layer (ENG-3424):
 * {@link createSumvinClient} composes it all onto the generated `Client` (D1). None of it
 * introduces a hand-written mirror of a generated response shape — every type these
 * modules expose either comes from `src/generated/` or describes something the generated
 * layer has no shape for at all (an options bag, a discriminated outcome, a typed error).
 * Checked for name collisions against every generated export before being wired in here
 * (none found — the curated names are deliberately unlike the spec's own vocabulary:
 * `ApiError` vs. `ProblemDetail`, `Hal` vs. `Link`/`PaginationLinks`, `AuthProvider` vs.
 * `Auth`).
 */

export { type CreateSumvinClientOptions, createSumvinClient } from './client.js';
export type {
  Auth,
  Client,
  ClientMeta,
  ClientOptions,
  Config,
  CreateClientConfig,
  Options,
  QuerySerializerOptions,
  RequestOptions,
  RequestResult,
  ResolvedRequestOptions,
  ResponseStyle,
  ServerSentEventsResult,
  TDataShape,
} from './generated/client/index.js';
export {
  buildClientParams,
  createClient,
  createConfig,
  formDataBodySerializer,
  jsonBodySerializer,
  mergeHeaders,
  serializeQueryKeyValue,
  urlSearchParamsBodySerializer,
} from './generated/client/index.js';
export { client } from './generated/client.gen.js';

// Every operation's request/response/error types, and a typed SDK function for each of the
// 174 spec operations (`src/generated/index.ts` re-exports `sdk.gen` + `types.gen`).
export * from './generated/index.js';

// Zod v4 runtime-validation schema for every type above (390 schemas). hey-api emits
// `zod.gen.ts` as a sibling to `sdk.gen.ts`/`types.gen.ts`, not folded into its own barrel,
// so it is re-exported explicitly here.
export * from './generated/zod.gen.js';

// ---------------------------------------------------------------------------
// The curated layer (ENG-3424). See each module's own barrel for the full
// TSDoc on what it does and why; this file only re-exports.
// ---------------------------------------------------------------------------

// Credential providers (D2) and the device-authorization sign-in flow (D7).
export {
  type AuthProvider,
  type Awaitable,
  DeviceLoginConflictError,
  DeviceLoginError,
  DeviceLoginExpiredError,
  DeviceLoginNotFoundError,
  type DeviceLoginOptions,
  DeviceLoginTimeoutError,
  type DeviceLoginUserCode,
  deviceLogin,
  installAuthInterceptor,
  junoJwt,
  pintToken,
  sumvinPat,
  type TokenOrGetter,
} from './auth/index.js';
// One funnel for every error family this SDK throws or returns:
// SumvinError/isSumvinError is the base every family extends;
// ApiError/isApiError narrows request failures; unwrap/replayOutcome round
// out the flow-control helpers.
export {
  ApiError,
  type ApiErrorInit,
  type ApiErrorKind,
  installErrorInterceptor,
  isApiError,
  isSumvinError,
  replayOutcome,
  SumvinError,
  unwrap,
} from './errors/index.js';
// Progression readers over onboarding, KYC, and Safe-wallet state (D8).
export {
  DEFAULT_KYC_POLL_DEADLINE_MS,
  DEFAULT_SAFE_CREATION_POLL_DEADLINE_MS,
  DEFAULT_USER_OPERATION_POLL_DEADLINE_MS,
  deriveKycProgress,
  deriveOnboardingProgress,
  deriveOutstandingDocs,
  deriveSafeCreationProgress,
  deriveSafeOnboardingState,
  deriveUserOperationProgress,
  KYC_POLL_INTERVAL_MS,
  type KycOutstandingDocs,
  type KycPollOutcome,
  type KycProgress,
  ONBOARDING_STUCK_BACKOFF_MS,
  type OnboardingPollOutcome,
  type OnboardingProgress,
  type PollKycOptions,
  type PollOnboardingOptions,
  type PollSafeCreationOptions,
  type PollUserOperationStatusOptions,
  pollKycVerification,
  pollOnboardingUntilResolved,
  pollSafeCreation,
  pollUserOperationStatus,
  SAFE_CREATION_POLL_INTERVAL_MS,
  type SafeCreationPollOutcome,
  type SafeCreationProgress,
  type SafeOnboardingState,
  USER_OPERATION_POLL_INTERVAL_MS,
  type UserOperationPollOutcome,
  type UserOperationProgress,
} from './flows/index.js';

// HAL `_links` navigation over the generated client (D5).
export {
  expandTemplate,
  type Hal,
  HalError,
  HalOriginRefusedError,
  HalPaginationGuardError,
  HalRelNotFoundError,
  HalTemplateError,
  halOf,
  type LinksBearing,
  type Paginatable,
  type PaginateOptions,
  paginate,
  type TemplateVars,
} from './hal/index.js';
// Reading a PINT scope's display-unit spend ceiling (ENG-3594).
export {
  isScopeCeilingError,
  readScopeCeiling,
  type ScopeCeiling,
  ScopeCeilingError,
  type ScopeCeilingRefusal,
} from './scopes/index.js';
// Response-body contract validation (D4) — on by default via createSumvinClient.
export {
  ContractDriftError,
  type ContractDriftEvent,
  type ContractDriftReason,
  installResponseValidation,
  isContractDriftError,
  STRICT_OPERATIONS,
  truncateForDrift,
  VALIDATED_OPERATIONS,
  type ValidationOptions,
  type ValidationTier,
} from './validation/index.js';
