/**
 * `FakeReply.redirected`/`.url` fidelity (ENG-3467's third AC).
 *
 * Both are ordinary read-only getters on a real `Response`, so a
 * hand-constructed `new Response(...)` — exactly what `fakeFetch` builds
 * every scripted reply from — always reports `redirected: false` and
 * `url: ''`, independent of anything a test scripts. Without an explicit
 * override, ANY redirect-backstop test written against this fake passes
 * vacuously: the assertion under test never sees a `true`, so it can never
 * observe the fake failing to produce one. That is the exact defect the
 * CLI's own hand-rolled fake has today.
 */
import { describe, expect, it } from 'vitest';
import { fakeFetch } from './fake-fetch.js';

describe('FakeReply redirected/url fidelity', () => {
  it('when: no reply overrides redirected/url, both keep their ordinary hand-constructed-Response defaults (false / "")', async () => {
    const f = fakeFetch([{ status: 200, body: { ok: true } }]);
    const response = await f.fetch('https://api.test/whatever');

    expect(response.redirected).toBe(false);
    expect(response.url).toBe('');
  });

  it('when: a reply scripts redirected: true and a url, the constructed Response reports both — proving a redirect-backstop test written against this fake can actually observe a true redirected flag', async () => {
    const f = fakeFetch([
      { status: 200, body: { ok: true }, redirected: true, url: 'https://elsewhere.test/landed' },
    ]);
    const response = await f.fetch('https://api.test/whatever');

    expect(response.redirected).toBe(true);
    expect(response.url).toBe('https://elsewhere.test/landed');
  });

  it('when: a consumer clones the response only to read its body and returns the ORIGINAL unchanged — the exact pattern `detectUnparsableJson` uses at src/validation/install.ts:79, returning the original response at :225 — the original still reports redirected/url intact', async () => {
    const f = fakeFetch([
      { status: 200, body: { ok: true }, redirected: true, url: 'https://elsewhere.test/landed' },
    ]);
    const original = await f.fetch('https://api.test/whatever');

    // Mirrors src/validation/install.ts's detectUnparsableJson: clone to
    // read the body, discard the clone, hand the ORIGINAL on to whatever
    // reads response.redirected next (the auth interceptor's redirect
    // backstop, src/auth/interceptor.ts's redirectRefusalReason).
    const clone = original.clone();
    await clone.text();

    expect(original.redirected).toBe(true);
    expect(original.url).toBe('https://elsewhere.test/landed');

    // Named hazard (own-property override does not survive .clone()): if a
    // future refactor started handing the CLONE onward instead of the
    // original, this same fidelity would silently be lost. Pinned here so
    // that refactor fails this test instead of fading into a vacuous pass.
    expect(clone.redirected).toBe(false);
    expect(clone.url).toBe('');
  });
});
