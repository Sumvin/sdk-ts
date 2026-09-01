/**
 * Starts a real 302-redirecting HTTP server once per test run and hands its
 * URL to every test file via Vitest's `provide`/`inject` protocol — the ONLY
 * mechanism that reaches a test regardless of which pool runs it.
 *
 * Vitest's `globalSetup` always executes in the Node.js main process,
 * whatever `test.environment` or `test.pool` a project configures
 * (https://vitest.dev/config/#globalsetup) — so this file may freely import
 * `node:http`, even though the tests it feeds run under Node, Bun, a real
 * workerd isolate (`@cloudflare/vitest-pool-workers`), and a real headless
 * Chromium tab (`@vitest/browser`), none of which can import `node:http`
 * themselves. `src/runtime-verification/redirect-refusal.test.ts` is the
 * one test file exercised across all four of those configs; this is its
 * fixture.
 *
 * `provide()`/`inject()` (not `process.env`) is deliberate: `process.env`
 * mutated here is a main-process side effect that worker pools happen to
 * inherit at spawn time, but a browser tab and a workerd isolate have no
 * `process` at all, so it would not reach two of this file's four
 * consumers. `provide`/`inject` is Vitest's own cross-pool RPC channel and
 * is documented to work with the browser and workers pools precisely
 * because nothing about it depends on a shared OS process.
 *
 * Four routes on one server:
 *  - `/` (and anything else unmatched) — 302s to itself (`Location: '/'`),
 *    exactly as before. This is load-bearing, not incidental: the existing
 *    `toTransportError` test in `redirect-refusal.test.ts` fetches the bare
 *    base URL and depends on this exact behaviour, and that test is an
 *    explicit acceptance criterion to leave byte-identical. Every new route
 *    below is additive.
 *  - `/redirect` — 302 to `/target`. What the new hit-counter test fetches.
 *  - `/target` — increments an in-memory counter, then 200s. Reached ONLY if
 *    something actually followed the redirect; a genuine refusal never gets
 *    here.
 *  - `/hits` — returns the counter as plain text. This is the proof a
 *    classifier result alone cannot be: not "the classifier says refused"
 *    but "the target was, in fact, never contacted".
 *
 * CORS is permissive on every response, including the redirects themselves,
 * and `OPTIONS` is answered with `Access-Control-Allow-Headers` — both
 * confirmed necessary by direct observation while writing this plan (§2,
 * O5/O6): a page served by Vitest's browser mode is a different origin than
 * `127.0.0.1:<port>`, the new test's `x-sumvin-pat` header forces a CORS
 * preflight, and WITHOUT these headers a cross-origin 302 fails as an opaque
 * `TypeError: Failed to fetch` under every redirect mode — indistinguishable
 * from a genuine refusal, and exactly why the browser leg could not assert
 * anything before this change. WITH them, `redirect: 'manual'` yields a
 * clean `type: 'opaqueredirect'` and the target is never contacted. CORS on
 * a purely local test fixture carries no real exposure.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Base URL of a server that 302-redirects every request to itself. */
    redirectServerUrl: string;
  }
}

export default async function setup({ provide }: TestProject): Promise<() => Promise<void>> {
  let targetHits = 0;

  const server = createServer((req, res) => {
    // Permissive CORS on every response — see this file's header for why
    // the browser leg needs it on both the preflight and the 302 itself.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      // Preflight for the custom `x-sumvin-pat` header the hit-counter test
      // sends — observed necessary directly (plan §2, O6).
      res.writeHead(204);
      res.end();
      return;
    }

    switch (req.url) {
      case '/redirect':
        res.writeHead(302, { location: '/target' });
        res.end();
        return;
      case '/target':
        targetHits += 1;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('target reached');
        return;
      case '/hits':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(String(targetHits));
        return;
      default:
        // Original behaviour, unchanged: everything else — including the
        // bare base URL '/' the existing toTransportError test fetches —
        // redirects to itself. The exact shape doesn't matter beyond that
        // (this fixture exists to trigger redirect refusal, not to model a
        // specific attacker origin — src/client.test.ts already covers the
        // cross-origin credential-theft scenario end to end).
        res.writeHead(302, { location: '/' });
        res.end();
        return;
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  provide('redirectServerUrl', `http://127.0.0.1:${port}/`);

  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
}
