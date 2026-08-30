/**
 * Tests for {@link deviceLogin}, driven through a real generated client and a
 * scripted `fetch` — same harness shape as `src/errors/interceptor.test.ts`.
 * `deviceLogin` expects `installErrorInterceptor` already applied to the
 * client it's given (typically via `createSumvinClient`, Phase C), so every
 * test here installs it, matching the composed shape a real consumer gets.
 */
import { describe, expect, it, vi } from 'vitest';
import { installErrorInterceptor } from '../errors/interceptor.js';
import { createClient, createConfig } from '../generated/client/index.js';
import { fakeFetch } from '../testing/fake-fetch.js';
import {
  DeviceLoginConflictError,
  DeviceLoginExpiredError,
  DeviceLoginNotFoundError,
  DeviceLoginTimeoutError,
  type DeviceLoginUserCode,
  deviceLogin,
} from './device.js';

function clientWith(f: ReturnType<typeof fakeFetch>) {
  const client = createClient(createConfig({ baseUrl: 'https://api.test', fetch: f.fetch }));
  installErrorInterceptor(client);
  return client;
}

const created = {
  status: 201,
  body: {
    _links: {},
    device_code: 'devc-secret-abc',
    user_code: 'ABCD-1234',
    verification_uri: 'https://sumvin.test/device',
    verification_uri_complete: 'https://sumvin.test/device?user_code=ABCD-1234',
    expires_in: 600,
    interval: 5,
  },
};

const pending = { status: 200, body: { _links: {}, status: 'pending' } };
const approved = { status: 200, body: { _links: {}, status: 'approved' } };
const exchanged = {
  status: 201,
  body: {
    _links: {},
    token: 'pat-live-secret-xyz',
    token_type: 'bearer',
    expires_at: 1_900_000_000_000,
  },
};

function problem(status: number, error_code: string, detail = 'irrelevant') {
  return {
    status,
    body: {
      type: 'about:blank',
      title: 'error',
      status,
      detail,
      instance: '/v0/cli/x',
      error_code,
    },
  };
}

/** A no-op sleep that resolves immediately — tests never wait in real time. */
function instantSleep() {
  return vi.fn(() => Promise.resolve());
}

describe('deviceLogin — happy path', () => {
  it('when: the device code is approved on the first poll, this exchanges it and returns the minted credential', async () => {
    const f = fakeFetch([created, approved, exchanged]);
    const client = clientWith(f);
    const onUserCode = vi.fn();

    const credential = await deviceLogin({ client, onUserCode, sleep: instantSleep() });

    expect(credential).toEqual(exchanged.body);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]?.url).toContain('/v0/cli/device-codes');
    expect(f.calls[0]?.method).toBe('POST');
    expect(f.calls[1]?.url).toContain('/v0/cli/device-codes/devc-secret-abc');
    expect(f.calls[1]?.method).toBe('GET');
    expect(f.calls[2]?.url).toContain('/v0/cli/personal-access-tokens');
    expect(f.calls[2]?.method).toBe('POST');
  });

  it('when: the request is still pending on the first poll, this keeps polling until approved', async () => {
    const f = fakeFetch([created, pending, pending, approved, exchanged]);
    const client = clientWith(f);

    const credential = await deviceLogin({ client, onUserCode: vi.fn(), sleep: instantSleep() });

    expect(credential.token).toBe('pat-live-secret-xyz');
    // create + 3 polls (pending, pending, approved) + exchange
    expect(f.calls).toHaveLength(5);
  });

  it('when: a clientName is given, this passes it through as the device-code request body', async () => {
    const f = fakeFetch([created, approved, exchanged]);
    const client = clientWith(f);

    await deviceLogin({
      client,
      onUserCode: vi.fn(),
      sleep: instantSleep(),
      clientName: 'sumvin-cli@host',
    });

    const body = await f.calls[0]?.clone().json();
    expect(body).toEqual({ client_name: 'sumvin-cli@host' });
  });
});

describe('deviceLogin — onUserCode', () => {
  it('when: the device code is created, this fires onUserCode exactly once, before the wait and the first poll, with the presentation fields (never the device_code secret)', async () => {
    const f = fakeFetch([created, approved, exchanged]);
    const client = clientWith(f);
    // A single shared order log spanning both onUserCode and sleep: proves
    // onUserCode fires before the wait between create and the first poll
    // even starts — not merely before the poll's HTTP call lands, which a
    // weaker test could satisfy by moving onUserCode to just after the
    // sleep and still ahead of the fetch.
    const order: string[] = [];
    const onUserCode = vi.fn((_info: DeviceLoginUserCode) => {
      order.push(`onUserCode@calls=${f.calls.length}`);
    });
    const sleep = vi.fn(async (_ms: number) => {
      order.push(`sleep@calls=${f.calls.length}`);
    });

    await deviceLogin({ client, onUserCode, sleep });

    expect(onUserCode).toHaveBeenCalledTimes(1);
    expect(onUserCode).toHaveBeenCalledWith({
      userCode: 'ABCD-1234',
      verificationUri: 'https://sumvin.test/device',
      verificationUriComplete: 'https://sumvin.test/device?user_code=ABCD-1234',
      expiresIn: 600,
    });
    // When: this test goes red if onUserCode ever fires after the wait
    // between create and the first poll, or after the poll's HTTP call has
    // already gone out — headless/SSH correctness depends on the user
    // seeing the code before the CLI starts silently waiting on it.
    expect(order).toEqual(['onUserCode@calls=1', 'sleep@calls=1']);
    const info = onUserCode.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(info).not.toHaveProperty('device_code');
    expect(info).not.toHaveProperty('deviceCode');
  });

  it('when: onUserCode returns a Promise, this awaits it before polling', async () => {
    const f = fakeFetch([created, approved, exchanged]);
    const client = clientWith(f);
    let resolved = false;
    const onUserCode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve();
          }, 0);
        }),
    );

    await deviceLogin({ client, onUserCode, sleep: instantSleep() });

    expect(resolved).toBe(true);
  });
});

describe('deviceLogin — 429 backoff', () => {
  it('when: a poll 429s with a retry-after header, this waits exactly that many seconds before the next poll', async () => {
    const f = fakeFetch([
      created,
      { ...problem(429, 'CLI-503-001'), headers: { 'retry-after': '3' } },
      approved,
      exchanged,
    ]);
    const client = clientWith(f);
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    await deviceLogin({ client, onUserCode: vi.fn(), sleep });

    // First sleep is the initial `interval` (5s from `created`), second is
    // the `retry-after`-directed 3s — never the CLI's blind +5s default.
    const waitsMs = sleep.mock.calls.map((call) => call[0]);
    expect(waitsMs).toEqual([5_000, 3_000]);
  });

  it('when: a poll 429s with no retry-after header, this widens the wait by the fixed backoff step rather than failing', async () => {
    const f = fakeFetch([created, problem(429, 'CLI-503-001'), approved, exchanged]);
    const client = clientWith(f);
    const sleep = vi.fn((_ms: number) => Promise.resolve());

    await deviceLogin({ client, onUserCode: vi.fn(), sleep });

    const waitsMs = sleep.mock.calls.map((call) => call[0]);
    // interval(5s), then +5s widened since no retry-after was given.
    expect(waitsMs).toEqual([5_000, 10_000]);
  });
});

describe('deviceLogin — deadline expiry', () => {
  it('when: the local clock passes the expires_in deadline before approval, this throws DeviceLoginTimeoutError instead of polling forever', async () => {
    const f = fakeFetch([created, pending]);
    const client = clientWith(f);
    let clock = 1_000_000;
    const now = () => clock;
    // Jumps the clock straight past the 600s deadline on every sleep, so the
    // loop's own deadline check — not a poll response — is what fires,
    // proving the timeout is computed client-side and never waits 600s for
    // real.
    const sleep = async (ms: number) => {
      clock += 600 * 1000 + ms;
    };

    const promise = deviceLogin({ client, onUserCode: vi.fn(), now, sleep });

    await expect(promise).rejects.toBeInstanceOf(DeviceLoginTimeoutError);
    // create + exactly one poll (the pending reply already in flight when
    // the clock jumped) — the loop must not poll a second time once its own
    // deadline check trips.
    expect(f.calls).toHaveLength(2);
  });
});

describe('deviceLogin — terminal error codes', () => {
  it('when: a poll returns CLI-410-001 (410 Gone), this throws DeviceLoginExpiredError', async () => {
    const f = fakeFetch([created, problem(410, 'CLI-410-001')]);
    const client = clientWith(f);

    await expect(
      deviceLogin({ client, onUserCode: vi.fn(), sleep: instantSleep() }),
    ).rejects.toBeInstanceOf(DeviceLoginExpiredError);
  });

  it('when: a poll returns CLI-404-001 (404 Not Found), this throws DeviceLoginNotFoundError', async () => {
    const f = fakeFetch([created, problem(404, 'CLI-404-001')]);
    const client = clientWith(f);

    await expect(
      deviceLogin({ client, onUserCode: vi.fn(), sleep: instantSleep() }),
    ).rejects.toBeInstanceOf(DeviceLoginNotFoundError);
  });

  it('when: exchange returns 409 (already exchanged), this throws DeviceLoginConflictError', async () => {
    const f = fakeFetch([created, approved, problem(409, 'CLI-409-001')]);
    const client = clientWith(f);

    await expect(
      deviceLogin({ client, onUserCode: vi.fn(), sleep: instantSleep() }),
    ).rejects.toBeInstanceOf(DeviceLoginConflictError);
  });

  it('when: exchange returns 410 (expired before exchange completed), this throws DeviceLoginExpiredError', async () => {
    const f = fakeFetch([created, approved, problem(410, 'CLI-410-001')]);
    const client = clientWith(f);

    await expect(
      deviceLogin({ client, onUserCode: vi.fn(), sleep: instantSleep() }),
    ).rejects.toBeInstanceOf(DeviceLoginExpiredError);
  });
});

describe('deviceLogin — abort', () => {
  it('when: the signal aborts during the wait between polls, this rejects rather than making the next poll', async () => {
    const f = fakeFetch([created, pending, approved, exchanged]);
    const client = clientWith(f);
    const controller = new AbortController();
    const sleep = vi.fn((_ms: number) => {
      controller.abort();
      return Promise.resolve();
    });

    await expect(
      deviceLogin({ client, onUserCode: vi.fn(), signal: controller.signal, sleep }),
    ).rejects.toThrow();

    // create + zero polls: the abort was observed before the poll fired.
    expect(f.calls).toHaveLength(1);
  });

  it('when: the signal is already aborted before deviceLogin is called, this rejects immediately without any network call', async () => {
    const f = fakeFetch([created]);
    const client = clientWith(f);
    const controller = new AbortController();
    controller.abort();

    await expect(
      deviceLogin({
        client,
        onUserCode: vi.fn(),
        signal: controller.signal,
        sleep: instantSleep(),
      }),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});

describe('deviceLogin — never leaks the token', () => {
  it('when: any terminal error is thrown, this never puts the device_code or the minted token in the error message', async () => {
    const f = fakeFetch([created, problem(410, 'CLI-410-001')]);
    const client = clientWith(f);

    try {
      await deviceLogin({ client, onUserCode: vi.fn(), sleep: instantSleep() });
      throw new Error('expected deviceLogin to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).not.toContain('devc-secret-abc');
      expect(message).not.toContain('pat-live-secret-xyz');
    }
  });
});
