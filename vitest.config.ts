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
  },
});
