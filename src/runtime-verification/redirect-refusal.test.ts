/**
 * The one test file that runs, unmodified, under all four runtimes this SDK
 * claims to support: Node (via `vitest.config.ts`, both locally and in the
 * `node-matrix` CI job's Node 20 + 24 legs), Bun (`vitest.config.ts` again,
 * run with `bun run test`), a genuine workerd isolate
 * (`vitest.edge.config.ts`, `@cloudflare/vitest-pool-workers`), and a real
 * headless Chromium tab (`vitest.browser.config.ts`, `@vitest/browser` +
 * Playwright).
 *
 * `src/client.test.ts` already proves the cross-origin-redirect refusal
 * end to end on Node/Bun, using a `node:http` server started *inside* the
 * test file. That approach cannot travel here: a real workerd isolate
 * refuses to import `node:http` at all, and Vite externalizes it for the
 * browser build (`const t = {}, e = t.createServer(...)` — a green build,
 * a dead test). `redirect-server.global-setup.ts` starts the server once,
 * in the Node main process every pool shares, and hands its URL to every
 * environment through Vitest's `provide`/`inject` protocol instead.
 */
import { describe, expect, inject, it } from 'vitest';
import { toTransportError } from '../errors/transport.js';

/**
 * Node and Bun each expose a distinguishing signal on the `fetch` rejection
 * for a refused redirect (`error.code === 'UnexpectedRedirect'` on Bun,
 * `error.cause.message === 'unexpected redirect'` on Node/undici) — see
 * `src/errors/transport.ts`'s own TSDoc for both, reproduced against a real
 * server there too. A browser has no such signal: `127.0.0.1` is
 * cross-origin from the page Vitest's browser mode serves, so a CORS
 * failure and a genuine redirect refusal both surface as the same opaque
 * `TypeError` — asserting `kind: 'redirect-refused'` there would pass
 * without the runtime ever having told us anything. workerd's fetch
 * implementation is not undici and not Bun's; its rejection shape for this
 * case is observed fresh in whatever CI/local run actually exercises it
 * (see the runtime detection below), not assumed from either of its
 * siblings.
 */
function currentRuntime(): 'node' | 'bun' | 'other' {
  // Cloudflare's workerd (via `@cloudflare/vitest-pool-workers`) is checked
  // FIRST and unconditionally wins: `@cloudflare/vitest-pool-workers` itself
  // force-enables `enable_nodejs_*` compatibility flags so its own runner
  // can boot (observed directly — `vitest.edge.config.ts` sets no Node
  // compat flag itself, yet the pool logs "Adding `enable_nodejs_fs_module`
  // … as this feature is needed to support the Vitest runner"), which
  // leaves `globalThis.process.versions.node` truthy (a fixed `'18.0.0'`)
  // even in a genuine workerd isolate. Checking `process.versions` first, as
  // an earlier version of this function did, misclassified workerd as
  // Node and asserted a signal workerd cannot produce. `navigator.userAgent
  // === 'Cloudflare-Workers'` is workerd's own documented, stable identity
  // string and is unaffected by which Node-compat flags happen to be on.
  const navigatorUserAgent = (globalThis as { navigator?: { userAgent?: string } }).navigator
    ?.userAgent;
  if (navigatorUserAgent === 'Cloudflare-Workers') return 'other';

  const versions = (globalThis as { process?: { versions?: Record<string, string> } }).process
    ?.versions;
  if (versions?.bun) return 'bun';
  if (versions?.node) return 'node';
  return 'other';
}

describe('toTransportError — redirect refusal, exercised against a real server on every runtime', () => {
  it('when: a real fetch(..., { redirect: "error" }) rejects against a server that always 302s, this returns an ApiError on every runtime — and on Node/Bun specifically, kind is "redirect-refused", the signal a caller branches on to know no credential reached the redirect target', async () => {
    const url = inject('redirectServerUrl');
    const runtime = currentRuntime();

    let caught: unknown;
    try {
      await fetch(url, { redirect: 'error' });
      throw new Error('expected fetch to reject');
    } catch (error) {
      caught = error;
    }

    const apiError = toTransportError(caught, undefined);

    // True on every runtime: the funnel normalizes whatever this runtime
    // actually threw into the SDK's one error type. This is the part of
    // the claim this test can make honestly everywhere.
    //
    // `isApiError(apiError)` is deliberately NOT asserted here, though it
    // reads like the obvious line: `toTransportError` is declared
    // `: ApiError` and returns one on all three of its branches, so the
    // compiler already proves it and no change to this SDK could turn such
    // an assertion red. On a browser or edge runtime — where the `kind`
    // branch below does not run — it would have been the ONLY assertion
    // left, leaving this test unable to fail on exactly the runtimes it
    // exists to cover. The two below can fail on every runtime.
    expect(apiError.cause).toBe(caught);
    expect(['redirect-refused', 'network']).toContain(apiError.kind);

    if (runtime === 'node' || runtime === 'bun') {
      expect(apiError.kind).toBe('redirect-refused');
    }
    // Neither `'network'` nor `'redirect-refused'` is asserted for any other
    // runtime here — see this file's header and `toTransportError`'s own
    // TSDoc. A browser's identical-looking CORS failure would make either
    // assertion pass for a reason that has nothing to do with redirects,
    // which is the coverage gap the plan and README both name explicitly
    // rather than paper over with a tautology.
  });
});
