import type { Client } from '../generated/client/index.js';
import type { HttpMethod } from '../generated/core/types.gen.js';
import type { Link } from '../generated/index.js';
import { resolveRequestUrl } from './origin-guard.js';
import { expandTemplate, type TemplateVars } from './template.js';

/**
 * Resolve `link` against `client` and issue the request through it.
 *
 * Internal to `src/hal` — both `Hal.follow` (see `link.ts`) and `paginate`
 * (see `paginate.ts`) funnel through here, so template expansion, the origin
 * guard, and "always through the configured client, never a bare `fetch`"
 * are enforced in exactly one place.
 *
 * `init.signal`, when given, aborts the underlying request — `paginate` uses
 * it to make its own `AbortSignal` support real rather than merely checked
 * between hops.
 */
export async function followLink(
  client: Client,
  link: Link,
  vars?: TemplateVars,
  init?: { signal?: AbortSignal },
): Promise<unknown> {
  const href = link.templated ? expandTemplate(link.href, vars ?? {}) : link.href;
  const url = resolveRequestUrl(client, href);
  const method = normalizeMethod(link.method);

  // `throwOnError: true` + `responseStyle: 'data'` is what makes this
  // function's own return type `Promise<unknown>` — the parsed body on
  // success, a thrown error (from `client.request`'s own error-interceptor
  // chain) on failure. No wrapper to unwrap for a caller who just wants
  // "the thing this link points at."
  return client.request<unknown, unknown, true, 'data'>({
    method,
    url,
    throwOnError: true,
    responseStyle: 'data',
    ...(init?.signal ? { signal: init.signal } : {}),
  });
}

function normalizeMethod(method: string | undefined): Uppercase<HttpMethod> {
  return (method ?? 'GET').toUpperCase() as Uppercase<HttpMethod>;
}
