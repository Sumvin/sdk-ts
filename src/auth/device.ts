/**
 * `deviceLogin` — the CLI/device-authorization sign-in flow: start, poll,
 * exchange. Typed on the generated operations (`createDeviceCode`,
 * `pollDeviceCode`, `exchangeDeviceCode`); nothing here hand-rolls `fetch`.
 *
 * Precondition: `client` is expected to already carry
 * `installErrorInterceptor` (typically via `createSumvinClient`),
 * so `result.error` on every generated call is an {@link ApiError} — this
 * module reads `.status` / `.errorCode`, never a message string, to decide
 * which terminal outcome fired.
 */
import { isApiError } from '../errors/api-error.js';
import { SumvinError } from '../errors/sumvin-error.js';
import { unwrap } from '../errors/unwrap.js';
import type { Client } from '../generated/client/index.js';
import { createDeviceCode, exchangeDeviceCode, pollDeviceCode } from '../generated/sdk.gen.js';
import type { PersonalAccessTokenExchangeResponse } from '../generated/types.gen.js';

/**
 * Base class for every error {@link deviceLogin} throws. `instanceof
 * DeviceLoginError` catches all of them; so does `isSumvinError`/`instanceof
 * SumvinError` alongside every other SDK error family — this base is a
 * marker for that one funnel, not a normalization into `ApiError`'s shape.
 */
export abstract class DeviceLoginError extends SumvinError {
  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/**
 * The sign-in is gone: expired, denied by the user, or already exchanged.
 *
 * These three are collapsed into one error deliberately, not by omission —
 * see the "on the `exchanged` status" note on {@link deviceLogin} for why no
 * spec-exposed discriminator exists to split them further at the poll seam.
 */
export class DeviceLoginExpiredError extends DeviceLoginError {
  constructor(cause?: unknown) {
    super(
      'This sign-in expired, was denied, or was already used. Start a new sign-in.',
      cause !== undefined ? { cause } : undefined,
    );
  }
}

/** The device code the caller polled with is unknown to the server (`CLI-404-001`) — never issued, or malformed. */
export class DeviceLoginNotFoundError extends DeviceLoginError {
  constructor(cause?: unknown) {
    super('Sign-in request not found.', cause !== undefined ? { cause } : undefined);
  }
}

/** The approved device code was already exchanged for a token by a concurrent caller (exchange's own `409`). */
export class DeviceLoginConflictError extends DeviceLoginError {
  constructor(cause?: unknown) {
    super(
      'This sign-in has already been exchanged for a token.',
      cause !== undefined ? { cause } : undefined,
    );
  }
}

/** The local `expires_in` deadline elapsed before the sign-in was approved — never made a terminal server call. */
export class DeviceLoginTimeoutError extends DeviceLoginError {
  constructor() {
    super('Sign-in timed out before it was approved.');
  }
}

/**
 * What {@link deviceLogin} hands `onUserCode` — the presentation fields only.
 * Deliberately excludes `device_code`: that value is the flow's bearer
 * secret for polling and exchange, and has no reason to ever reach a
 * presentation callback (a print statement, a UI toast) where it could end
 * up logged.
 */
export interface DeviceLoginUserCode {
  /** Short code the user confirms in the browser. */
  readonly userCode: string;
  /** Browser URL where the user approves the sign-in. */
  readonly verificationUri: string;
  /** `verificationUri`, pre-filled with `userCode` for convenience. */
  readonly verificationUriComplete: string;
  /** Seconds until the whole sign-in request expires. */
  readonly expiresIn: number;
}

/** Options for {@link deviceLogin}. */
export interface DeviceLoginOptions {
  /** An unauthenticated client — every device-code operation requires no PAT/JWT. */
  readonly client: Client;
  /**
   * Called exactly once, as soon as the device code is created and before
   * the first poll. Not optional decoration: this is the only place the
   * user ever sees the verification URL and short code, and headless/SSH
   * correctness depends on it firing before anything else — see
   * sumvin-cli's `presentVerification()`, which this mirrors. If the
   * returned value is a `Promise`, it is awaited before polling starts.
   */
  readonly onUserCode: (info: DeviceLoginUserCode) => void | Promise<void>;
  /** Aborts the flow — both the wait between polls and any in-flight request. */
  readonly signal?: AbortSignal;
  /** Optional human-readable label for the device requesting sign-in (`DeviceCodeCreateRequest.client_name`). */
  readonly clientName?: string;
  /** Epoch-millisecond clock. Injected so tests don't depend on real time. @default Date.now */
  readonly now?: () => number;
  /** Sleep for `ms` milliseconds. Injected so tests don't wait in real time. @default a real setTimeout-backed sleep */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Seconds added to the poll wait on a `429` that carries no `retry-after` header — matches sumvin-cli's shipped step. */
const BACKOFF_STEP_SECONDS = 5;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The device login was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

/** Races `sleep(ms)` against `signal` aborting, so a pending wait is cancellable — not just checked between waits. */
function abortableSleep(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    return sleep(ms);
  }
  return new Promise<void>((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(abortError(signal));
      return;
    }
    const onAbort = () => rejectPromise(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms).then(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise();
    }, rejectPromise);
  });
}

/**
 * The next poll wait, in seconds: the server's `retry-after` when a `429`
 * carries one (an explicit instruction, honoured literally — this is the
 * improvement over sumvin-cli's `pollUntilApproved`, which never reads that
 * header at all), otherwise `currentWaitSeconds` widened by
 * {@link BACKOFF_STEP_SECONDS} — the CLI's own shipped fallback, kept
 * because nothing here argues it should change absent the header.
 */
function nextWaitSeconds(currentWaitSeconds: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader !== null) {
    const parsed = Number(retryAfterHeader);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return currentWaitSeconds + BACKOFF_STEP_SECONDS;
}

/**
 * Drive a device-authorization sign-in: `createDeviceCode` → poll
 * `pollDeviceCode` (with `429` backoff) until approved → `exchangeDeviceCode`.
 * Returns the minted credential; **does not persist it** — storage is the
 * caller's job, same contract Part 1's auth providers hold to.
 *
 * ### On the `exchanged` status
 *
 * `CliDeviceAuthorizationStatus` (the spec enum backing
 * `DeviceCodeStatusResponse.status`) has five members, including
 * `'exchanged'`. `pollDeviceCode`'s own OpenAPI description settles what a
 * poll can actually observe: *"Returns the current status while the request
 * is pending or approved; a terminal request (exchanged, denied, or
 * expired) returns 410."* A `200` response's `status` is therefore only ever
 * `'pending'` or `'approved'` in practice — `'exchanged'` (and `'denied'`
 * and `'expired'`) are never returned inline; they all collapse into a
 * single `410 Gone` with error code `CLI-410-001`, indistinguishable from
 * each other at this seam. sumvin-cli's own `pollUntilApproved` corroborates
 * this: it throws the identical `expiredError()` both for
 * `status === 'denied' || status === 'expired'` *and* for a caught
 * `CLI-410-001` — even the shipped client never actually separates them.
 * This function therefore does not branch on `'exchanged'` (or `'denied'` /
 * `'expired'`) in the `200` path at all; the `default` arm below exists only
 * as a defensive fallback against a future spec change, not because any of
 * those three is reachable today. **This is a genuine spec-observed
 * limitation, not an invented one**: there is no discriminator available to
 * tell a user-denied sign-in apart from a merely-expired one once the poll
 * returns `410`. If product wants a distinct "denied" message, that needs a
 * new discriminator added to the `410` response upstream — it cannot be
 * synthesized here.
 *
 * @throws {DeviceLoginExpiredError} on a `410`/`CLI-410-001` from poll or
 *   exchange — expired, denied, or already exchanged (see above).
 * @throws {DeviceLoginNotFoundError} on a `404`/`CLI-404-001` from poll —
 *   the device code is unknown to the server.
 * @throws {DeviceLoginConflictError} on a `409` from exchange — a concurrent
 *   caller already exchanged this device code.
 * @throws {DeviceLoginTimeoutError} when the local `expires_in` deadline
 *   elapses before approval.
 *
 * @example
 * const credential = await deviceLogin({
 *   client,
 *   onUserCode: (info) => {
 *     console.log(`Visit ${info.verificationUri} and enter ${info.userCode}`);
 *   },
 * });
 * await storeCredentials(credential); // this SDK never persists it for you
 */
export async function deviceLogin(
  options: DeviceLoginOptions,
): Promise<PersonalAccessTokenExchangeResponse> {
  const { client, onUserCode, signal, clientName, now = Date.now, sleep = defaultSleep } = options;

  throwIfAborted(signal);

  const device = unwrap(
    await createDeviceCode({
      client,
      body: clientName !== undefined ? { client_name: clientName } : undefined,
      signal,
    }),
  );

  await onUserCode({
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    verificationUriComplete: device.verification_uri_complete,
    expiresIn: device.expires_in,
  });

  const deadline = now() + device.expires_in * 1000;
  let waitSeconds = device.interval;

  while (true) {
    throwIfAborted(signal);
    if (now() >= deadline) {
      throw new DeviceLoginTimeoutError();
    }

    await abortableSleep(waitSeconds * 1000, sleep, signal);
    throwIfAborted(signal);

    const polled = await pollDeviceCode({
      client,
      path: { device_code: device.device_code },
      signal,
    });

    if (polled.error !== undefined) {
      if (!isApiError(polled.error)) {
        throw polled.error;
      }
      if (polled.error.status === 429) {
        waitSeconds = nextWaitSeconds(
          waitSeconds,
          polled.error.response?.headers.get('retry-after') ?? null,
        );
        continue;
      }
      if (polled.error.errorCode === 'CLI-410-001') {
        throw new DeviceLoginExpiredError(polled.error);
      }
      if (polled.error.errorCode === 'CLI-404-001') {
        throw new DeviceLoginNotFoundError(polled.error);
      }
      throw polled.error;
    }

    const status = polled.data?.status;
    if (status === 'pending') {
      continue;
    }
    if (status === 'approved') {
      break;
    }
    // See "On the `exchanged` status" above: unreachable per the spec's own
    // documented contract for this 200 response today, kept only so a
    // future terminal status returned inline fails closed instead of
    // spinning forever.
    throw new DeviceLoginExpiredError();
  }

  throwIfAborted(signal);

  const exchanged = await exchangeDeviceCode({
    client,
    body: { device_code: device.device_code },
    signal,
  });

  if (exchanged.error !== undefined) {
    if (!isApiError(exchanged.error)) {
      throw exchanged.error;
    }
    if (exchanged.error.status === 409) {
      throw new DeviceLoginConflictError(exchanged.error);
    }
    if (exchanged.error.errorCode === 'CLI-410-001') {
      throw new DeviceLoginExpiredError(exchanged.error);
    }
    throw exchanged.error;
  }

  return unwrap(exchanged);
}
