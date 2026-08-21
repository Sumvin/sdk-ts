/**
 * `@sumvin/sdk` — core barrel.
 *
 * Framework-free by design: no React, no TanStack Query import anywhere in this file
 * or anything it pulls in. That is enforced at source, not just by omission here — the
 * `@tanstack/react-query` hey-api plugin is configured with `includeInEntry: false` in
 * `openapi-ts.config.ts`, so the generated TanStack artifact is never part of
 * `src/generated/index.ts` in the first place. The TanStack integration lives at
 * `@sumvin/sdk/react`.
 *
 * The fetch client: the pre-configured singleton, the factory functions to build your own
 * client, and the supporting types below — including `ClientMeta`, an empty interface
 * consumers augment (via declaration merging against
 * `@sumvin/sdk/generated/core/types.gen`, see the `./generated/*` package export) to attach
 * their own per-request metadata. That augmentation only reaches call sites typed
 * through `@sumvin/sdk/generated/*` — this barrel's declarations are dts-rolled-up into a
 * single file, which duplicates `ClientMeta` rather than referencing it, so declaration
 * merging cannot cross that boundary. `client` (the singleton) and `createClient`/
 * `createConfig` (the factory) come from two distinct generated modules — `client.gen.ts`
 * and `client/index.ts` respectively — both re-exported below under their own names,
 * deliberately not merged via a single `export *`: `client.gen.ts` declares its own internal
 * `CreateClientConfig` alias that would collide with the canonical one re-exported from
 * `client/index.ts`.
 */

export type {
  Auth,
  Client,
  ClientMeta,
  ClientOptions,
  Config,
  CreateClientConfig,
  Options,
  QuerySerializerOptions,
  RequestOptions,
  RequestResult,
  ResolvedRequestOptions,
  ResponseStyle,
  ServerSentEventsResult,
  TDataShape,
} from './generated/client/index.js';
export {
  buildClientParams,
  createClient,
  createConfig,
  formDataBodySerializer,
  jsonBodySerializer,
  mergeHeaders,
  serializeQueryKeyValue,
  urlSearchParamsBodySerializer,
} from './generated/client/index.js';
export { client } from './generated/client.gen.js';

// Every operation's request/response/error types, and a typed SDK function for each of the
// 174 spec operations (`src/generated/index.ts` re-exports `sdk.gen` + `types.gen`).
export * from './generated/index.js';

// Zod v4 runtime-validation schema for every type above (390 schemas). hey-api emits
// `zod.gen.ts` as a sibling to `sdk.gen.ts`/`types.gen.ts`, not folded into its own barrel,
// so it is re-exported explicitly here.
export * from './generated/zod.gen.js';
