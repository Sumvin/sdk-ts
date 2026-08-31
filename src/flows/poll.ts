/**
 * Internal polling primitives shared by every `src/flows` reader.
 *
 * D8 — "progression readers, not state machines" — governs how these
 * primitives fail, not only how the domain readers on top of them read: a
 * poller built from this module never throws for a server-observed state, a
 * deadline, or a value it doesn't recognize. Every terminal condition comes
 * back as a typed {@link PollResult}, for the caller to switch on.
 *
 * `sleep` resolves — it never rejects — when `signal` fires mid-wait. This
 * mirrors how an aborted in-flight request already surfaces elsewhere in
 * this SDK: `ApiError` gets a `kind: 'abort'` member (see
 * `src/errors/transport.ts`) rather than the failure being thrown past the
 * caller. An abort here means "stop waiting now"; the loop notices on its
 * next check and reports `{ kind: 'aborted' }` as a value, not an exception.
 *
 * Not exported from a package entry point — internal to `src/flows`.
 */

/** Injectable wait, so tests never actually wait. See {@link abortableSleep} for the default. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Injectable clock, so tests control elapsed time exactly. Defaults to `Date.now`. */
export type Now = () => number;

/** The pieces of a poll loop a caller may override — always optional, always defaulted. */
export interface Clock {
  readonly now?: Now;
  readonly sleep?: Sleep;
}

/**
 * Waits `ms` milliseconds, or until `signal` aborts — whichever comes
 * first. Never rejects: an abort resolves the wait immediately rather than
 * throwing, so a poll loop can check `signal.aborted` itself in one place
 * after every wait instead of wrapping each one in `try`/`catch`.
 *
 * @example
 * await abortableSleep(8_000, controller.signal); // returns early if aborted
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/**
 * One step of a {@link pollUntil} loop. `value` is always the latest known
 * state — not only on success — so a `timeout` outcome can still report
 * what was last observed rather than nothing at all.
 */
export interface PollStep<T> {
  readonly done: boolean;
  readonly value: T;
}

/** The outcome of a bounded poll: exactly one of terminal, deadline, or cancelled. */
export type PollResult<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'timeout'; readonly value: T }
  | { readonly kind: 'aborted' };

export interface PollUntilOptions extends Clock {
  /** Wait between steps, milliseconds. */
  readonly intervalMs: number;
  /** Hard wall-clock budget for the whole poll, milliseconds, measured from the first call. */
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Calls `step` repeatedly until it reports `done`, the wall-clock budget
 * (`deadlineMs`) runs out, or `signal` aborts — whichever happens first.
 * Never loops longer than the deadline and never throws for any of those
 * three outcomes; see {@link PollResult}.
 *
 * Every interval-based `src/flows` poller (KYC verification, Safe
 * creation) is this loop wearing a domain-specific `step` and a
 * domain-specific mapping from `PollResult` onto its own richer outcome
 * type.
 *
 * @example
 * const result = await pollUntil(
 *   async () => {
 *     const { data, error } = await getKycStatus({ client, signal });
 *     if (error) return { done: true, value: { kind: 'error' as const, error } };
 *     const progress = deriveKycProgress(data);
 *     const inFlight = progress.status === 'in_progress' || progress.status === 'retry';
 *     return { done: !inFlight, value: { kind: 'progress' as const, progress } };
 *   },
 *   { intervalMs: 8_000, deadlineMs: 120_000, signal },
 * );
 */
export async function pollUntil<T>(
  step: () => Promise<PollStep<T>>,
  options: PollUntilOptions,
): Promise<PollResult<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const { signal, intervalMs, deadlineMs } = options;
  const deadline = now() + deadlineMs;

  while (true) {
    if (signal?.aborted) {
      return { kind: 'aborted' };
    }

    const result = await step();

    if (signal?.aborted) {
      return { kind: 'aborted' };
    }
    if (result.done) {
      return { kind: 'done', value: result.value };
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      return { kind: 'timeout', value: result.value };
    }

    await sleep(Math.min(intervalMs, remaining), signal);
  }
}

/**
 * Runs `attempt` after each delay in `delaysMs`, in order, stopping the
 * moment it reports `done` — or once every delay has been used, whichever
 * comes first.
 *
 * Ported from sumvin-app-v2's onboarding stuck-state recovery
 * (`OnboardingRouter`'s bounded backoff, `src/components/onboarding/onboarding-router.tsx`):
 * a `0` first delay makes the first retry fire immediately once the caller
 * decides one is warranted, and the remaining delays back off — the app's
 * own sequence is `[0, 1_000, 2_000, 4_000, 8_000]`, a ~15s ceiling for a
 * slow Sumsub webhook or Safe-finalisation reconciler to land.
 *
 * @throws {Error} if `delaysMs` is empty — a caller misconfiguration, never
 *   a server-observed condition, so this is the one thing here that throws.
 */
export async function runBoundedBackoff<T>(
  attempt: () => Promise<PollStep<T>>,
  delaysMs: readonly number[],
  clock: Clock & { readonly signal?: AbortSignal } = {},
): Promise<PollResult<T>> {
  if (delaysMs.length === 0) {
    throw new Error('runBoundedBackoff requires at least one delay in `delaysMs`');
  }

  const sleep = clock.sleep ?? abortableSleep;
  const { signal } = clock;
  let last: T | undefined;

  for (const delay of delaysMs) {
    if (signal?.aborted) {
      return { kind: 'aborted' };
    }

    await sleep(delay, signal);

    if (signal?.aborted) {
      return { kind: 'aborted' };
    }

    const result = await attempt();
    last = result.value;
    if (result.done) {
      return { kind: 'done', value: result.value };
    }
  }

  return { kind: 'timeout', value: last as T };
}
