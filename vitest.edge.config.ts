import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

/**
 * Runs the runtime-sensitive subset of the suite inside a genuine workerd
 * isolate (Miniflare, `@cloudflare/vitest-pool-workers`) — not a hand-rolled
 * globals swap in the same Node realm. That distinction matters: a swapped
 * environment still has `typeof process === 'object'`, `Buffer`, and a
 * `node:http` that resolves and binds a real port, so a redirect-backstop
 * or Node-detection test written against it would pass for a reason that
 * has nothing to do with edge behaviour. workerd genuinely lacks all three.
 *
 * `@cloudflare/vitest-pool-workers` is pinned to `0.12.21` (`0.9.0`–`0.12.x`
 * peer-declares `vitest: '2.0.x - 3.2.x'`; `0.13.0`+ requires
 * `vitest: '^4.1.0'`, which this repo does not run) — see `package.json`.
 *
 * `include` is an explicit file list, not a directory glob, and it is
 * deliberately short of "every test under client/auth/errors/hal/validation".
 * Three files import `node:http`/`node:fs` at module scope for reasons
 * specific to how THEY test (spinning up a real server inline, or reading
 * source files for a static-analysis assertion) — none of which workerd can
 * do without `nodejs_compat`, which this config does not set (setting it
 * would defeat the entire point of this job: proving behaviour under a
 * runtime that genuinely lacks Node builtins, not a polyfilled one).
 * Excluded, and why:
 *   - `src/client.test.ts` — imports `node:http`/`node:net` to start real
 *     servers inline (the cross-origin-redirect FIX-1 tests).
 *   - `src/validation/seam.test.ts`,
 *     `src/validation/naming-rule-coverage.test.ts` — import `node:fs` to
 *     read source files for a static-analysis assertion; nothing here is
 *     runtime-sensitive SDK behaviour, so losing edge coverage of these
 *     specific files costs nothing this job exists to catch.
 *   - `src/errors/api-error.test.ts` — two of its nine tests dynamically
 *     `import('node:util')` to exercise `Symbol.for('nodejs.util.inspect.custom')`,
 *     a Node/Bun-console-specific hook this file's own TSDoc scopes to
 *     "Node.js and Bun" by name. Excluded whole-file rather than partially:
 *     this agent does not own `src/errors/**` and cannot split the two
 *     util.inspect tests out of the file to keep the other seven running
 *     here.
 *   - `src/auth/interceptor.test.ts` and `src/errors/funnel.test.ts` — the
 *     most important exclusions on this list, and the reason this job's
 *     green must NOT be read as "the SDK works on Workers". Both build a
 *     client through `createSumvinClient`, which installs the auth
 *     interceptor, which sets `redirect: 'error'` on every request — a
 *     value workerd rejects outright (`TypeError: Invalid redirect value`).
 *     So every request this SDK makes throws on Workers today, and these
 *     two files are excluded because they are the ones that would say so.
 *     Tracked as ENG-3486; when it is fixed, delete this bullet and put
 *     both files back. Everything this job DOES cover is the 144 tests
 *     that never construct a request.
 * `src/runtime-verification/redirect-refusal.test.ts` is included: it is
 * environment-aware by construction (see its own header) and is the one
 * file this config shares with `vitest.config.ts` and
 * `vitest.browser.config.ts`.
 */
export default defineWorkersConfig({
  test: {
    globals: true,
    include: [
      'src/auth/device.test.ts',
      'src/auth/provider.test.ts',
      'src/errors/interceptor.test.ts',
      'src/errors/sumvin-error.test.ts',
      'src/validation/contract-drift-error.test.ts',
      'src/errors/result.test.ts',
      'src/hal/link.test.ts',
      'src/hal/origin-guard.test.ts',
      'src/hal/paginate.test.ts',
      'src/hal/template.test.ts',
      'src/validation/install.test.ts',
      'src/validation/truncate-for-drift.test.ts',
      'src/validation/validated-operations.test.ts',
      'src/runtime-verification/redirect-refusal.test.ts',
    ],
    globalSetup: ['src/runtime-verification/redirect-server.global-setup.ts'],
    poolOptions: {
      workers: {
        miniflare: {
          compatibilityDate: '2026-01-01',
          // Deliberately NOT 'nodejs_compat' — see the file header.
        },
      },
    },
  },
});
