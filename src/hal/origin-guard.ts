import type { Client } from '../generated/client/index.js';
import { HalOriginRefusedError } from './errors.js';

/**
 * Resolve a HAL href to the `url` that should be handed to `client.request`,
 * enforcing the origin policy from D5 (ENG-3133):
 *
 * - A **relative** href is always allowed, unchanged — it can only ever
 *   resolve against the client's own `baseUrl`.
 * - An **absolute** href is allowed only when its origin equals the client's
 *   configured `baseUrl` origin. On a match, the href is reduced back down
 *   to `pathname + search + hash` — the same shape a relative href would
 *   take — so the request is issued through `client.request`'s own
 *   `baseUrl` handling either way. This is deliberate, not an oversight: it
 *   is what lets a `baseUrl` that carries a path prefix (a BFF mount like
 *   `/api/proxy`) keep applying to a followed link exactly as it does to
 *   every other call, same as `sumvin-app-v2`'s `resolveEndpoint` (see
 *   `src/lib/api/core/client.ts`) concatenates the proxy prefix rather than
 *   resolving the href against an ambient origin.
 * - An absolute href is refused outright when the client's `baseUrl` is
 *   itself relative (or absent) — there is then no origin to compare
 *   against, so nothing can be verified same-origin. This is the
 *   `sumvin-app-v2` browser case: `baseUrl: '/api/proxy'` carries no
 *   credential of its own, so a bare absolute href fetched directly would
 *   bypass the proxy and travel with no credential at all.
 *
 * This is a security boundary, not a style preference — see
 * {@link HalOriginRefusedError}.
 *
 * @throws {HalOriginRefusedError} if `href` is absolute and refused.
 */
export function resolveRequestUrl(client: Client, href: string): string {
  const hrefUrl = tryParseAbsoluteUrl(href);
  if (!hrefUrl) {
    // No scheme => relative. Handed straight to client.request, which
    // resolves it against the client's own configured baseUrl.
    return href;
  }

  const baseUrl = client.getConfig().baseUrl;
  const baseOrigin = baseUrl ? tryParseAbsoluteUrl(baseUrl)?.origin : undefined;

  if (baseOrigin === undefined) {
    throw new HalOriginRefusedError(
      href,
      `the client's baseUrl (${baseUrl ? `"${baseUrl}"` : 'unset'}) has no origin to compare ` +
        'against, so every absolute href is refused',
    );
  }

  if (hrefUrl.origin !== baseOrigin) {
    throw new HalOriginRefusedError(
      href,
      `origin "${hrefUrl.origin}" does not match the client's baseUrl origin "${baseOrigin}"`,
    );
  }

  return `${hrefUrl.pathname}${hrefUrl.search}${hrefUrl.hash}`;
}

/** `undefined` for anything without a scheme — i.e. every relative href. */
function tryParseAbsoluteUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
