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
  const server = createServer((_req, res) => {
    // Redirects to itself: the exact shape doesn't matter (this fixture
    // exists to trigger `redirect: 'error'` refusal, not to model a
    // specific attacker origin — src/client.test.ts already covers the
    // cross-origin credential-theft scenario end to end).
    res.writeHead(302, { location: '/' });
    res.end();
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
