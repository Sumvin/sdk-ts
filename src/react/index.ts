/**
 * `@sumvin/sdk/react` — TanStack Query integration.
 *
 * Query-options / infinite-query-options / mutation-options factories for every spec
 * operation, plus family-level cache-invalidation groups built on top of them. This is
 * the ONLY entry point that pulls in `@tanstack/react-query` — the `includeInEntry:
 * false` setting on the hey-api TanStack plugin (see `openapi-ts.config.ts`) keeps it
 * out of `src/generated/index.ts`, and `src/index.ts` never imports this directory or
 * `@tanstack/react-query`. `react` and `@tanstack/react-query` are both optional peer
 * dependencies — this subpath is a no-op import cost for a consumer who never touches
 * it.
 *
 * Also re-exports the error-funnel guards ({@link isSumvinError},
 * {@link isContractDriftError}) — a hook author importing from this subpath
 * otherwise has no way to narrow a query/mutation's `error` without also
 * importing from the root `@sumvin/sdk` entry point.
 */

export { isSumvinError, SumvinError } from '../errors/sumvin-error.js';
export * from '../generated/@tanstack/react-query.gen.js';
export { isContractDriftError } from '../validation/contract-drift-error.js';
export * from './invalidation-groups.js';
