import { describe, expect, it, vi } from 'vitest';
import { abortableSleep, type PollStep, pollUntil, runBoundedBackoff } from './poll.js';

/** A deterministic, non-real-time clock: `sleep` resolves synchronously and records its call. */
function fakeClock(startMs = 0) {
  let current = startMs;
  const waits: number[] = [];
  return {
    waits,
    now: () => current,
    sleep: async (ms: number, signal?: AbortSignal) => {
      waits.push(ms);
      if (signal?.aborted) return;
      current += ms;
    },
  };
}

describe('abortableSleep', () => {
  it('resolves after the real clock advances past `ms`', async () => {
    vi.useFakeTimers();
    try {
      const spy = vi.fn();
      abortableSleep(50).then(spy);
      await vi.advanceTimersByTimeAsync(49);
      expect(spy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves immediately, never rejects, when `signal` is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(10_000, controller.signal)).resolves.toBeUndefined();
  });

  it('resolves immediately when `signal` aborts mid-wait, without waiting out `ms`', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const spy = vi.fn();
      abortableSleep(10_000, controller.signal).then(spy);
      await vi.advanceTimersByTimeAsync(5);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pollUntil', () => {
  it('returns `done` the first time `step` reports done, without sleeping first', async () => {
    const clock = fakeClock();
    const step = vi.fn<() => Promise<PollStep<string>>>().mockResolvedValue({
      done: true,
      value: 'terminal',
    });

    const result = await pollUntil(step, { intervalMs: 1_000, deadlineMs: 60_000, ...clock });

    expect(result).toEqual({ kind: 'done', value: 'terminal' });
    expect(step).toHaveBeenCalledTimes(1);
    expect(clock.waits).toEqual([]);
  });

  it('sleeps `intervalMs` between not-done steps, then returns `done` on the terminal one', async () => {
    const clock = fakeClock();
    const step = vi
      .fn<() => Promise<PollStep<number>>>()
      .mockResolvedValueOnce({ done: false, value: 1 })
      .mockResolvedValueOnce({ done: false, value: 2 })
      .mockResolvedValueOnce({ done: true, value: 3 });

    const result = await pollUntil(step, { intervalMs: 8_000, deadlineMs: 60_000, ...clock });

    expect(result).toEqual({ kind: 'done', value: 3 });
    expect(step).toHaveBeenCalledTimes(3);
    expect(clock.waits).toEqual([8_000, 8_000]);
  });

  it('returns `timeout` with the last observed value once the deadline is exhausted', async () => {
    const clock = fakeClock();
    const step = vi
      .fn<() => Promise<PollStep<number>>>()
      .mockResolvedValue({ done: false, value: 42 });

    const result = await pollUntil(step, { intervalMs: 8_000, deadlineMs: 20_000, ...clock });

    expect(result).toEqual({ kind: 'timeout', value: 42 });
    // Steps run at t=0, 8_000, 16_000, 20_000 (4 total: `step` always runs
    // before the deadline is checked). The wait computed at t=16_000 is
    // clamped to the remaining 4_000ms rather than a full 8_000ms.
    expect(clock.waits).toEqual([8_000, 8_000, 4_000]);
    expect(step).toHaveBeenCalledTimes(4);
  });

  it('returns `aborted` instead of calling `step` again once `signal` fires', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    let calls = 0;
    const step = async (): Promise<PollStep<number>> => {
      calls += 1;
      if (calls === 1) {
        controller.abort();
        return { done: false, value: 1 };
      }
      throw new Error('must not be called again after abort');
    };

    const result = await pollUntil(step, {
      intervalMs: 1_000,
      deadlineMs: 60_000,
      signal: controller.signal,
      ...clock,
    });

    expect(result).toEqual({ kind: 'aborted' });
    expect(calls).toBe(1);
  });

  it('returns `aborted` immediately when `signal` is aborted before the first `step` call', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    controller.abort();
    const step = vi.fn<() => Promise<PollStep<number>>>();

    const result = await pollUntil(step, {
      intervalMs: 1_000,
      deadlineMs: 60_000,
      signal: controller.signal,
      ...clock,
    });

    expect(result).toEqual({ kind: 'aborted' });
    expect(step).not.toHaveBeenCalled();
  });
});

describe('runBoundedBackoff', () => {
  it('waits each configured delay in order, stopping the moment `attempt` reports done', async () => {
    const clock = fakeClock();
    const attempt = vi
      .fn<() => Promise<PollStep<string>>>()
      .mockResolvedValueOnce({ done: false, value: 'still-stuck' })
      .mockResolvedValueOnce({ done: false, value: 'still-stuck' })
      .mockResolvedValueOnce({ done: true, value: 'resolved' });

    const result = await runBoundedBackoff(attempt, [0, 1_000, 2_000, 4_000, 8_000], clock);

    expect(result).toEqual({ kind: 'done', value: 'resolved' });
    expect(attempt).toHaveBeenCalledTimes(3);
    // Each attempt is preceded by its delay: 0, 1_000, 2_000 for the 3
    // attempts made — the 4_000/8_000 delays are never reached because the
    // third attempt already resolved.
    expect(clock.waits).toEqual([0, 1_000, 2_000]);
  });

  it('returns `timeout` with the last value once every delay is exhausted unresolved', async () => {
    const clock = fakeClock();
    const attempt = vi
      .fn<() => Promise<PollStep<string>>>()
      .mockResolvedValue({ done: false, value: 'still-stuck' });

    const result = await runBoundedBackoff(attempt, [0, 1_000, 2_000], clock);

    expect(result).toEqual({ kind: 'timeout', value: 'still-stuck' });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(clock.waits).toEqual([0, 1_000, 2_000]);
  });

  it('returns `aborted` and stops issuing attempts once `signal` fires between delays', async () => {
    const controller = new AbortController();
    let calls = 0;
    const attempt = async (): Promise<PollStep<string>> => {
      calls += 1;
      return { done: false, value: 'still-stuck' };
    };
    const sleep = async (_ms: number, signal?: AbortSignal) => {
      if (calls === 1) controller.abort();
      void signal;
    };

    const result = await runBoundedBackoff(attempt, [0, 1_000, 2_000], {
      sleep,
      signal: controller.signal,
    });

    expect(result).toEqual({ kind: 'aborted' });
    expect(calls).toBe(1);
  });

  it('throws a configuration error for an empty delay list — a programmer error, not a server state', async () => {
    const attempt = vi.fn<() => Promise<PollStep<string>>>();
    await expect(runBoundedBackoff(attempt, [], {})).rejects.toThrow(/at least one delay/);
    expect(attempt).not.toHaveBeenCalled();
  });
});
