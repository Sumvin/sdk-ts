import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Scoped to the two directories that actually hold tests today
    // (verified via `find . -name '*.test.ts'`: src/** and scripts/lib/**).
    // With no `include`, vitest collects `*.test.ts` from anywhere under
    // the repo root, including gitignored scratch directories a
    // verification pass may leave behind — which produced a spuriously
    // red local run once already.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Starts the 302 server `src/runtime-verification/redirect-refusal.test.ts`
    // needs, once per run, in this (Node) main process — see that file's
    // header for why this is the one thing shared with vitest.edge.config.ts
    // and vitest.browser.config.ts instead of each defining its own.
    globalSetup: ['src/runtime-verification/redirect-server.global-setup.ts'],
  },
});
