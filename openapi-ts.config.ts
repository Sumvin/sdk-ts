import { defineConfig } from '@hey-api/openapi-ts';

/**
 * Every operation callable with types + zod, from an UNPATCHED spec,
 * reproducibly, never hand-edited.
 *
 * Two transforms that earlier in-house clients needed are deliberately absent:
 *
 * - No patch step. The patch manifest against the vendored spec is empty —
 *   independently re-derived across all 25 discriminated branch schemas, and
 *   re-checked at generation time by `scripts/assert-generated.ts`.
 * - No de-mangler (`buildMethodNames`). Every one of the spec's 174
 *   operationIds is already clean, so that transform would be the identity
 *   function. The concept is deleted, not carried as a no-op.
 */
export default defineConfig({
  input: './spec/openapi.json',
  output: {
    path: 'src/generated',
    // `output.format`/`output.lint` are deprecated as of 0.85 in favour of
    // `postProcess`. We don't post-process the generated tree at all —
    // `biome.json` already excludes `src/generated/**/*`, and hey-api's
    // output is deterministic and not held to the repo's lint rules.
    postProcess: [],
    // `indexFile` is deprecated in favour of `entryFile`.
    entryFile: true,
  },
  plugins: [
    '@hey-api/client-fetch',
    '@hey-api/typescript',
    {
      name: '@hey-api/sdk',
      operations: {
        strategy: 'flat',
        methodName: {
          casing: 'camelCase',
          // No `name` transform: a de-mangler would be dead code here (see
          // module docblock). Names pass through as the spec's own explicit
          // operationIds.
        },
      },
    },
    {
      name: 'zod',
      compatibilityVersion: 4,
      metadata: true,
    },
    {
      name: '@tanstack/react-query',
      // Keeps the core barrel (`src/index.ts`) framework-free at the SOURCE
      // level, not merely at the bundler level: React/TanStack symbols are
      // never emitted into the entry file hey-api assembles, so nothing in
      // `src/generated/index.ts` can accidentally import them.
      includeInEntry: false,
    },
  ],
});
