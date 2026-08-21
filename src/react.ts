/**
 * `@sumvin/sdk/react` — TanStack Query integration.
 *
 * Query-options / infinite-query-options / mutation-options factories for every spec
 * operation. This is the ONLY entry point that pulls in `@tanstack/react-query` — the
 * `includeInEntry: false` setting on the hey-api TanStack plugin (see
 * `openapi-ts.config.ts`) keeps it out of `src/generated/index.ts`, and `src/index.ts`
 * never imports this file or `@tanstack/react-query`. `react` and `@tanstack/react-query`
 * are both optional peer dependencies — this subpath is a no-op import cost for a
 * consumer who never touches it.
 */
export * from './generated/@tanstack/react-query.gen.js';
