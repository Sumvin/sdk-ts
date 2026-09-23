import { describe, expect, it } from 'vitest';
import { toTransportError } from './transport.js';

/**
 * Unit-level coverage for `toTransportError` — the transport-failure half
 * of the redirect-refused control. The cross-runtime,
 * real-fetch version of this lives in
 * `src/runtime-verification/redirect-refusal.test.ts`; these tests instead
 * construct the exact error shapes each runtime is documented (in this
 * file's own TSDoc) to throw, so the classification logic is exercised
 * without a network dependency and can run on every config.
 */

/** Shapes the error Bun throws for a single refused redirect (`error.code`). */
function bunRefusedRedirectError(): Error {
  return Object.assign(new Error('fetch failed'), { code: 'UnexpectedRedirect' });
}

/** Shapes the error Bun throws for a redirect *loop* — a DIFFERENT code. */
function bunRedirectLoopError(): Error {
  return Object.assign(new Error('fetch failed'), { code: 'TooManyRedirects' });
}

/** Shapes the error Node/undici throws for a single refused redirect (`.cause.message`). */
function nodeRefusedRedirectError(): Error {
  return new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
}

/** Shapes the error Node/undici throws for a redirect *loop* — a DIFFERENT `.cause.message`. */
function nodeRedirectLoopError(): Error {
  return new TypeError('fetch failed', { cause: new Error('redirect count exceeded') });
}

describe('toTransportError — redirect-refusal classification (unit-level, no network)', () => {
  // When: this test goes red if a Bun-shaped single-refusal error
  // (`error.code === 'UnexpectedRedirect'`) stops producing
  // `kind: 'redirect-refused'` with `redirectOutcome: 'refused'` — the
  // contract this SDK's error surface promises a consumer-supplied
  // `fetch` that itself sets `redirect: 'error'`.
  it('classifies a Bun single-refusal error as redirect-refused with redirectOutcome "refused"', () => {
    const error = toTransportError(bunRefusedRedirectError(), undefined);

    expect(error.kind).toBe('redirect-refused');
    expect(error.redirectOutcome).toBe('refused');
  });

  // When: this test goes red if a Node/undici-shaped single-refusal error
  // (`.cause.message === 'unexpected redirect'`) stops producing
  // `kind: 'redirect-refused'` with `redirectOutcome: 'refused'` — same
  // contract, the other runtime's signal.
  it('classifies a Node/undici single-refusal error as redirect-refused with redirectOutcome "refused"', () => {
    const error = toTransportError(nodeRefusedRedirectError(), undefined);

    expect(error.kind).toBe('redirect-refused');
    expect(error.redirectOutcome).toBe('refused');
  });

  // When: this test goes red if a Bun redirect-*loop* error
  // (`error.code === 'TooManyRedirects'`, a credential genuinely sent on
  // every hop) is ever misclassified as `'redirect-refused'` — that kind's
  // whole meaning is "never followed," which would be false for a loop.
  // Guards the same runtime fact `client.test.ts`'s redirect-loop test guards at
  // the integration level, but here at the unit boundary that actually
  // owns the classification decision.
  it('does not classify a Bun redirect-loop error as redirect-refused', () => {
    const error = toTransportError(bunRedirectLoopError(), undefined);

    expect(error.kind).toBe('network');
    expect(error.redirectOutcome).toBeUndefined();
  });

  // When: this test goes red if a Node/undici redirect-*loop* error
  // (`.cause.message === 'redirect count exceeded'`, which contains the
  // substring "redirect" but not "unexpected redirect") is ever matched by
  // the same check that matches a genuine single refusal — proving the
  // substring anchor is specific enough not to collide with the loop
  // message, per this file's own TSDoc on `isRedirectRefusedError`.
  it('does not classify a Node/undici redirect-loop error as redirect-refused, despite sharing the word "redirect"', () => {
    const error = toTransportError(nodeRedirectLoopError(), undefined);

    expect(error.kind).toBe('network');
    expect(error.redirectOutcome).toBeUndefined();
  });

  // When: this test goes red if an ordinary network failure (no redirect
  // signal at all) ever picks up a `redirectOutcome` value — the field's
  // "present only when kind === 'redirect-refused'" contract, exercised at
  // the actual producer rather than by hand-constructing an ApiError.
  it('leaves redirectOutcome undefined on a genuine network failure', () => {
    const error = toTransportError(new TypeError('getaddrinfo ENOTFOUND api.test'), undefined);

    expect(error.kind).toBe('network');
    expect(error.redirectOutcome).toBeUndefined();
  });

  // When: this test goes red if an abort ever picks up a `redirectOutcome`
  // value — same contract, the other non-redirect kind this function
  // produces.
  it('leaves redirectOutcome undefined on an aborted request', () => {
    const error = toTransportError(new DOMException('aborted', 'AbortError'), undefined);

    expect(error.kind).toBe('abort');
    expect(error.redirectOutcome).toBeUndefined();
  });
});
