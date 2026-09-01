/**
 * `@sumvin/sdk/testing` — a scripted `fetch` for testing code built on this SDK.
 *
 * {@link fakeFetch} hands back a `fetch` implementation that replies from a
 * script instead of the network, so every curated behaviour this SDK adds —
 * auth headers, validation tiers, error normalization, HAL following — can
 * be exercised end to end against the SDK's own real transport, rather than
 * a third approximation of it hand-rolled per consumer. This is a
 * deliberately separate, un-bundled entry point (see `tsdown.config.ts`):
 * `src/index.ts` never imports this module, so an ordinary production
 * import of `@sumvin/sdk` cannot pull a test helper into a shipped bundle.
 */
export { type FakeFetch, type FakeReply, fakeFetch } from './fake-fetch.js';
