import { defineConfig } from 'vitest/config';

/**
 * Runs the runtime-sensitive subset of the suite inside a real headless
 * Chromium tab (`@vitest/browser` + Playwright), not jsdom/happy-dom — those
 * are DOM simulations in the Node realm and would not have caught the FIX-1
 * cross-origin-redirect defect this repo's own history names
 * (`src/client.test.ts`'s header): only a real browser actually enforces
 * fetch's cross-origin credential-stripping and CORS semantics.
 *
 * `@vitest/browser@3.2.7` peer-declares `vitest: '3.2.7'` EXACTLY, not a
 * range — `package.json` pins both to that exact version so a routine `^`
 * patch bump can't silently break this job. See `package.json`'s comment
 * for the same note anchored to the dependency declarations.
 *
 * `include` is the same explicit list as `vitest.edge.config.ts`, and for
 * the same two reasons — see that file's header for the full accounting:
 *   - `src/client.test.ts`, `src/validation/seam.test.ts`,
 *     `src/validation/naming-rule-coverage.test.ts` import `node:http`/
 *     `node:fs` at module scope; Vite externalizes `node:http` for a
 *     browser build rather than failing it (`const t = {}, e =
 *     t.createServer(...)`), which is a green build wrapped around a dead
 *     test — worse than workerd's honest import failure, and exactly the
 *     defect class this whole phase exists to avoid reproducing.
 *   - `src/errors/api-error.test.ts` — two of its nine tests dynamically
 *     `import('node:util')` for a Node/Bun-console-specific hook; excluded
 *     whole-file for the same reason as the edge config (this agent does
 *     not own `src/errors/**` and cannot split the file).
 *   - `src/auth/interceptor.test.ts` is ALSO excluded here, but for a THIRD,
 *     more serious reason that is not a test-infra limitation: every test
 *     in that file drives `installAuthInterceptor`, which unconditionally
 *     reconstructs its outgoing `Request` with `redirect: 'error'`
 *     (`src/auth/interceptor.ts:168`). A real browser's `fetch` accepts
 *     `redirect: 'error'` as a request-constructor argument fine, but a
 *     browser (unlike workerd) does not surface a distinguishing signal for
 *     a refused redirect at all, and `127.0.0.1` here is cross-origin from
 *     the page Vitest's browser mode serves — so every one of those tests
 *     would hang or fail on the network step for reasons that have nothing
 *     to do with the auth-header logic under test. This is a coverage
 *     boundary of THIS job, reported rather than routed around: the auth
 *     interceptor's request-construction behaviour still runs correctly
 *     under Node/Bun/edge (edge finding: it does NOT — see
 *     `vitest.edge.config.ts`'s header) and is exercised there.
 *
 * `src/runtime-verification/redirect-refusal.test.ts` is included and is the
 * one file shared with `vitest.config.ts` and `vitest.edge.config.ts`.
 */
export default defineConfig({
  test: {
    globals: true,
    include: [
      'src/auth/device.test.ts',
      'src/auth/provider.test.ts',
      'src/errors/interceptor.test.ts',
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
    browser: {
      enabled: true,
      headless: true,
      provider: 'playwright',
      instances: [{ browser: 'chromium' }],
    },
  },
});
