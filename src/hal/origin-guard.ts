import type { Client } from '../generated/client/index.js';
import { HalOriginRefusedError } from './errors.js';

/**
 * Resolve a HAL href to the `url` that should be handed to `client.request`,
 * enforcing the origin policy from D5 (ENG-3133):
 *
 * - A **relative** href is allowed only when it also stays inside the
 *   client's configured `baseUrl` **path prefix** once `..` segments are
 *   collapsed — see the "traversal" paragraph below. It can only ever
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
 *   resolving the href against an ambient origin. `new URL(href)` already
 *   collapses any `..` in an absolute href during parsing (before this
 *   module ever sees it), so there is no separate traversal check for this
 *   branch — see the FIX 2 note below for why the relative branch needs one
 *   and this one doesn't.
 * - An absolute href is refused outright when the client's `baseUrl` is
 *   itself relative (or absent) — there is then no origin to compare
 *   against, so nothing can be verified same-origin. This is the
 *   `sumvin-app-v2` browser case: `baseUrl: '/api/proxy'` carries no
 *   credential of its own, so a bare absolute href fetched directly would
 *   bypass the proxy and travel with no credential at all.
 * - A **protocol-relative** href — one starting with `//`, e.g.
 *   `//evil.example/x` — is refused outright, unconditionally, before it
 *   ever reaches the relative/absolute branch below. Found by reproduction
 *   (FIX 3, adversarial verification pass): `new URL('//evil.example/x')`
 *   throws without a base (no scheme), so {@link tryParseAbsoluteUrl} reports
 *   it as "relative" and it would otherwise fall through to the first branch
 *   above unchanged. It stays safe today ONLY because the generated client's
 *   `getUrl` (`generated/core/utils.gen.ts`) builds the final URL by string
 *   concatenation (`baseUrl + pathUrl`, never `new URL(url, baseUrl)`) — an
 *   implementation detail of REGENERATED code this module has no control
 *   over and does not pin. RFC 3986 §4.2 calls `//`-prefixed a "network-path
 *   reference": by definition a reference to a **different host**, same
 *   scheme as whatever resolves it — the one shape of "relative" href that
 *   is never actually same-origin. No legitimate HAL link in this API's
 *   spec has any reason to be one, so this is refused as an absolute href
 *   would be, not silently treated as relative.
 *
 *   That `//` refusal was itself a **raw-string prefix test** — found
 *   insufficient by two independent re-verification passes (FIX 1): the
 *   WHATWG URL parser trims leading C0 controls/space, removes ASCII
 *   tab/CR/LF from ANYWHERE in the string, and treats `\` as `/` before it
 *   ever looks at path structure, so spellings like `" //evil.com/x"`,
 *   `"\t//evil.com/x"`, and `"/\\evil.com/x"` all resolve to a different
 *   host under `new URL(href, base)` while walking straight past a raw
 *   `startsWith('//')`. {@link normalizesToProtocolRelative} mirrors that
 *   normalization before checking, so the refusal is keyed on what the
 *   string would BECOME, not on its literal first two bytes. Contained
 *   today for the same reason as the unnormalized case — string
 *   concatenation, not `new URL` resolution, in the generated client — but
 *   the TSDoc no longer implies that dependency is the only thing standing
 *   between a normalized `//` spelling and a cross-host request.
 *
 * - A relative href whose `..` segments, once concatenated onto `baseUrl`
 *   exactly as the generated client's own `getUrl` does and then collapsed
 *   the way any URL parser collapses dot segments, would resolve **outside
 *   `baseUrl`'s own path prefix**, is refused (FIX 2, both re-verification
 *   passes). A relative href is handed to `client.request` UNCHANGED — this
 *   module never parses or normalizes it — so `../../evil` against
 *   `baseUrl: '/api/proxy'` survives all the way to the concatenated string
 *   `/api/proxy/../../evil`, and THAT is what `fetch`/`Request` collapses to
 *   `/evil`: a request off the proxy mount, with the app's cookies, at a
 *   path the proxy never routes. This is what makes the "keep applying to a
 *   followed link exactly as it does to every other call" claim above true
 *   rather than aspirational. When `baseUrl` carries no path prefix (root,
 *   or absent), there is nothing to escape from, so this rule never fires —
 *   see {@link describeBaseUrlPrefixEscape}.
 *
 *   That collapse-and-compare is itself keyed on what `new URL` collapses —
 *   which is a **literal** `..`, not a percent-encoded one. `new URL` DOES
 *   decode `%2e` for the purpose of dot-segment collapsing (confirmed by
 *   reproduction, not assumed: `%2e%2e/%2e%2e/evil` collapses exactly like
 *   `../../evil`), but it never decodes `%2f` or `%5c` — a `..` segment
 *   spelled with an encoded separator (`..%2fevil`, `..%5Cevil`, even a
 *   doubly-encoded `..%252fevil`) survives {@link describeBaseUrlPrefixEscape}'s
 *   collapse unchanged, still nested under the prefix as far as `new URL`
 *   is concerned — the canonical bypass for a raw prefix-containment check
 *   (FIX 2, third re-verification pass). Refused outright when it would
 *   matter (`baseUrl` carries a path prefix to escape) — see
 *   {@link containsEncodedSeparator} for why this is a refusal and not a
 *   decode-then-recompare.
 *
 * This is a security boundary, not a style preference — see
 * {@link HalOriginRefusedError}.
 *
 * @throws {HalOriginRefusedError} if `href` is protocol-relative, escapes
 *   the client's `baseUrl` path prefix, or is absolute and refused.
 */
export function resolveRequestUrl(client: Client, href: string): string {
  if (normalizesToProtocolRelative(href)) {
    throw new HalOriginRefusedError(
      href,
      'protocol-relative hrefs (starting with "//", including once WHATWG URL normalization — ' +
        'trimming leading C0/space, removing tab/CR/LF, treating "\\" as "/" — is applied) are ' +
        'refused outright — a network-path reference by definition names a different host than ' +
        'whatever resolves it',
    );
  }

  const baseUrl = client.getConfig().baseUrl;

  const hrefUrl = tryParseAbsoluteUrl(href);
  if (!hrefUrl) {
    // No scheme => relative. Handed straight to client.request, which
    // resolves it against the client's own configured baseUrl — unless
    // doing so would walk outside baseUrl's own path prefix (FIX 2).
    const escapeReason = describeBaseUrlPrefixEscape(href, baseUrl);
    if (escapeReason) {
      throw new HalOriginRefusedError(href, escapeReason);
    }
    return href;
  }

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

/**
 * True when `href`, after the same normalization the WHATWG URL parser
 * applies before it ever looks at path structure, begins with `//`.
 *
 * Mirrors exactly three parser steps — not a general URL normalizer, just
 * enough of one to make this check honest about what the *string* would
 * become, not what its first two bytes are:
 * 1. Trim leading C0 controls and space (`\x00`–`\x20`).
 * 2. Remove ASCII tab/CR/LF from **anywhere** in the string, not just the
 *    ends — this is what catches `"/\t/evil.com/x"`.
 * 3. Treat `\` as `/` — special-scheme (http/https/ws/wss/file) parsing
 *    does this throughout, which is what makes `"/\\evil.com/x"` and
 *    `"\\\\evil.com\\x"` both protocol-relative.
 *
 * FIX 1 (both re-verification passes, independently converged): a raw
 * `href.startsWith('//')` missed every one of these spellings.
 */
function normalizesToProtocolRelative(href: string): boolean {
  // The C0 range below is deliberate. The WHATWG URL parser strips leading
  // control bytes and spaces before it parses, so `"\x00//evil.com/x"` is a
  // protocol-relative reference as far as it is concerned. A guard that
  // refused to look at control characters would be blind to precisely the
  // spellings that defeat it — which is how the raw `startsWith('//')` this
  // replaced was bypassed.
  const normalized = href
    // biome-ignore lint/suspicious/noControlCharactersInRegex: see above
    .replace(/^[\x00-\x20]+/, '')
    .replace(/[\t\n\r]/g, '')
    .replace(/\\/g, '/');
  return normalized.startsWith('//');
}

/**
 * `undefined` when a relative `href` stays inside `baseUrl`'s own path
 * prefix; otherwise a human-readable reason naming both.
 *
 * "Stays inside" is checked the way the request would actually be built and
 * then resolved, not by inspecting `href` in isolation: concatenate `href`
 * onto `baseUrl` exactly as the generated client's own `getUrl`
 * (`generated/core/utils.gen.ts`) does — string concatenation, leading `/`
 * added if missing — then run the result through `new URL(…, dummyOrigin)`
 * to collapse `..`/`.` segments the same way `fetch`/`Request` will when
 * this string is actually dispatched. Comparing the collapsed pathname
 * against `baseUrl`'s own (identically parsed) pathname is what catches
 * `../../evil` walking out from under `/api/proxy` — see the FIX 2 note on
 * {@link resolveRequestUrl}.
 *
 * When `baseUrl` is `undefined`, or carries no path (its own pathname is
 * `/`), there is no prefix for a relative href to escape — every resolved
 * path already starts with `/` — so this never refuses in that case, and
 * (for the same reason) {@link containsEncodedSeparator} is never even
 * consulted then either.
 */
function describeBaseUrlPrefixEscape(
  href: string,
  baseUrl: string | undefined,
): string | undefined {
  if (baseUrl === undefined) {
    return undefined;
  }

  // Only used to give `new URL` something to resolve a relative baseUrl
  // (e.g. "/api/proxy") against — never part of the returned/compared
  // value, and never sent anywhere.
  const DUMMY_ORIGIN = 'http://sdk-internal.invalid';
  const pathUrl = href.startsWith('/') ? href : `/${href}`;
  const concatenated = `${baseUrl}${pathUrl}`;

  let resolvedPath: string;
  let basePath: string;
  try {
    resolvedPath = new URL(concatenated, DUMMY_ORIGIN).pathname;
    basePath = new URL(baseUrl, DUMMY_ORIGIN).pathname;
  } catch {
    // Neither baseUrl nor the concatenated string parses even against a
    // dummy origin — nothing this function can compare, so don't fail
    // closed on a shape it can't reason about (an actually-malformed
    // baseUrl is a configuration error elsewhere, not this guard's job).
    return undefined;
  }

  const basePrefix = basePath.endsWith('/') ? basePath : `${basePath}/`;

  // FIX 2 (third re-verification pass): only relevant when there is an
  // actual prefix to escape — see this function's own TSDoc for why a root
  // baseUrl never refuses at all. Checked BEFORE the collapse-and-compare
  // below: `new URL` never decodes `%2f`/`%5c` (see
  // {@link containsEncodedSeparator}), so an encoded `..` would otherwise
  // sail through that comparison looking contained.
  if (basePrefix !== '/' && containsEncodedSeparator(href)) {
    return (
      `relative href "${href}" contains a percent-encoded path separator ("%2f"/"%5c", at any ` +
      `encoding depth) — refused outright rather than followed off the client's baseUrl path ` +
      `prefix "${basePath}" by whatever downstream decoder eventually reads it`
    );
  }

  if (resolvedPath === basePath || resolvedPath.startsWith(basePrefix)) {
    return undefined;
  }

  return (
    `relative href "${href}" resolves to "${resolvedPath}", outside the client's baseUrl path ` +
    `prefix "${basePath}" — refused rather than followed off the configured mount`
  );
}

/**
 * True when `href`, or any percent-decoding of it up to a small bounded
 * depth, contains a percent-encoded forward slash (`%2f`) or backslash
 * (`%5c`) — case-insensitively, and regardless of how many layers of
 * percent-encoding wrap it (`%252f`, `%25252f`, …).
 *
 * Exists because {@link describeBaseUrlPrefixEscape}'s collapse-and-compare
 * is keyed on what `new URL` collapses, and `new URL` decodes `%2e` for
 * dot-segment purposes but never `%2f`/`%5c` (confirmed by reproduction —
 * see the FIX 2 note on {@link resolveRequestUrl}). A relative href whose
 * `..` is spelled with an encoded separator therefore reads as "contained"
 * to that comparison right up until some layer THIS module does not control
 * — a reverse proxy, a CDN, a language runtime's own router — decodes the
 * separator on its own pass and lands somewhere else entirely.
 *
 * **Refuses outright rather than decoding-then-recomparing** (the two
 * options this fix considered): decoding here would only ever mirror ONE
 * specific downstream decoder's behaviour (single-pass? recursive? at all?
 * unknowable from this module), and choosing wrong is silent — the exact
 * failure mode this function exists to close, one layer up. The accepted
 * cost is a false positive on a legitimate href that happens to carry a
 * percent-encoded slash in a path segment (e.g. a compound resource id) —
 * refused, not silently allowed, when `baseUrl` has a prefix to escape.
 *
 * Bounded to a handful of decode passes: no real href is encoded this many
 * times over, so this exists only to keep a pathological input from
 * spinning the guard, not to accommodate a legitimate one. Stops the moment
 * a pass throws (a malformed `%` escape — decoding never reveals more from
 * there) or stops changing the string (a fixed point — nothing left to
 * decode).
 */
function containsEncodedSeparator(href: string): boolean {
  const ENCODED_SEPARATOR = /%2f|%5c/i;
  const MAX_DECODE_PASSES = 5;

  let current = href;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    if (ENCODED_SEPARATOR.test(current)) {
      return true;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return false; // malformed escape — nothing further to decode
    }
    if (decoded === current) {
      return false; // fixed point — no more encoding layers left to peel
    }
    current = decoded;
  }
  return ENCODED_SEPARATOR.test(current);
}
