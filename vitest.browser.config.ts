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
 * `include` is the same explicit list as `vitest.edge.config.ts`, minus one
 * of that file's exclusions that does not apply here — see that file's
 * header for the full accounting of the two that do:
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
 *
 * `src/auth/interceptor.test.ts` and `src/errors/funnel.test.ts` are
 * INCLUDED. `src/auth/interceptor.test.ts` was previously excluded here on
 * the theory that every test in it drives `installAuthInterceptor`, which
 * — under the pre-ENG-3486 `redirect: 'error'` setting — would "hang or
 * fail on the network step" because a real browser surfaces no
 * distinguishing signal for a refused redirect and `127.0.0.1` is
 * cross-origin from the page Vitest's browser mode serves. That reasoning
 * was never actually true for this file: every test in it drives
 * `fakeFetch` (`src/auth/interceptor.test.ts:11` imports `createClient,
 * createConfig` from the generated client directly — it never calls
 * `createSumvinClient` and never touches the network), so nothing in it
 * could have hung on a network step regardless of which `redirect` value
 * the interceptor set. A premise gate ran both files, unmodified, in a
 * real headless Chromium before ENG-3486 landed and got `Test Files 2
 * passed (2) / Tests 13 passed (13)` — this was a wrong stated reason for
 * an exclusion, not a real defect this fix removes. `installAuthInterceptor`
 * now sets `redirect: 'manual'` regardless (see `src/auth/interceptor.ts`'s
 * TSDoc), so the point is moot either way.
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
      'src/auth/interceptor.test.ts',
      'src/errors/interceptor.test.ts',
      'src/errors/sumvin-error.test.ts',
      'src/errors/funnel.test.ts',
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
    browser: {
      enabled: true,
      headless: true,
      provider: 'playwright',
      instances: [{ browser: 'chromium' }],
    },
  },
});
