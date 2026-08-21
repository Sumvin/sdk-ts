import { defineConfig } from 'tsdown';

// Never bundled — always resolved by the consumer's own install (peer) or shipped as a
// runtime dependency (zod). Keeping this list in one place also feeds the edge-safety
// check: nothing here is a Node builtin, so a clean `grep` over `dist/` for `fs`/`path`/
// `crypto`/etc. is a real signal, not a false negative from an accidentally-bundled dep.
// `@tanstack/query-core` is here despite never being imported by our source: it is a
// transitive dependency of `@tanstack/react-query`, and the generated TanStack artifact
// re-exports types that originate in it. Without it the dts pass resolves those types and
// emits them into `dist/generated/node_modules/@tanstack/query-core/**` — a `node_modules`
// directory INSIDE the published tarball, which shadows resolution for anything resolving
// out of `dist/generated/**` and pins the consumer's query-core *types* to our build.
// The emitted declaration also imported a `.mjs` that was never shipped. Found by
// adversarial verification of the packed tarball, not by the build, which was happy.
const external = ['zod', '@tanstack/react-query', '@tanstack/query-core', 'react', 'viem'];

export default defineConfig([
  // The three public subpath barrels — bundled, so each ships as a small number of
  // shared chunks rather than one file per generated module.
  {
    entry: {
      index: 'src/index.ts',
      react: 'src/react.ts',
      signing: 'src/signing/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    external,
  },
  // Unbundled pass-through of the full generated tree — one output file per input file,
  // directory structure preserved. This exists for exactly one reason: TypeScript module
  // augmentation needs the augmented module to resolve to a REAL, INDIVIDUALLY ADDRESSABLE
  // file, not a chunk folded into the `index` bundle above. TypeScript module
  // augmentation (`declare module '@sumvin/sdk/generated/core/types.gen'`) only works
  // against an individually addressable module, so consumers that augment `ClientMeta`
  // — an empty interface at `src/generated/core/types.gen.ts` — need it to survive the
  // package boundary as its own file. The same applies to the generated `client` module
  // (`src/generated/client/`) and the pre-built `client` singleton (`client.gen.ts`),
  // which are two distinct modules and must stay that way. DO NOT fold this into the
  // bundled entries above or delete it as apparently redundant with `src/index.ts` —
  // see the `./generated/*` entry in `package.json#exports`.
  {
    entry: ['src/generated/**/*.ts'],
    unbundle: true,
    outDir: 'dist/generated',
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: false,
    external,
  },
]);
