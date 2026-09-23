import type { Client } from '../generated/client/index.js';
import type { PaginationLinks } from '../generated/index.js';
import { HalPaginationGuardError } from './errors.js';
import { followLink } from './follow.js';
import { halOf } from './link.js';

/** Anything with `PaginationLinks` — the shape a paginated list response carries. */
export type Paginatable = { _links: PaginationLinks };

/** Options for {@link paginate}. */
export interface PaginateOptions {
  /** Aborts the walk — both the wait between hops and any in-flight request. */
  signal?: AbortSignal;
  /**
   * Hard stop on total hops, independent of cycle detection — a backstop
   * against a server that always advertises a `next` link and never
   * actually terminates, even without ever repeating a page.
   * @default 10_000
   */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 10_000;

/**
 * Walk a paginated list response by following `_links.next` until it is
 * absent, yielding each page — including the first, which is yielded
 * directly with no network call.
 *
 * Each hop goes through the same guarded `follow` every other HAL link does:
 * a `next` href is subject to the same origin guard as any other link —
 * refused if absolute and cross-origin, if relative and it would walk
 * outside `baseUrl`'s own path prefix, or if protocol-relative — and a
 * `templated` one would be rejected (list `next` links are never templated
 * in the vendored spec, so this only matters if that ever changes).
 *
 * Guards against a server whose pagination never legitimately terminates:
 * a `next` href that resolves back to a page already visited in this walk
 * throws {@link HalPaginationGuardError} immediately, as does exceeding
 * `maxPages` — both instead of looping forever.
 *
 * The type parameter is deliberately trusted, not verified: `follow()`
 * itself can only ever return `unknown` (an arbitrary href can't be typed —
 * see `halOf`'s TSDoc), so `paginate` assumes — as HAL pagination
 * conventions do — that `next` returns another page of the same shape as
 * `firstResult`, and asserts the cast rather than re-validating it. It also
 * declines to run a followed page's own contract-validation tier (that's a
 * property of typed operation calls made through `VALIDATED_OPERATIONS`,
 * not of a raw `client.request`); the caller who wants that on paginated
 * data should call the named list operation directly instead of consuming a
 * cached/opaque `next` link for anything money-shaped.
 *
 * @example
 * const first = await listAssets({ client });
 * for await (const page of paginate(client, first.data!)) {
 *   console.log(page.assets.length);
 * }
 *
 * @throws {HalPaginationGuardError} on a detected cycle or the `maxPages` cap.
 */
export async function* paginate<T extends Paginatable>(
  client: Client,
  firstResult: T,
  options: PaginateOptions = {},
): AsyncIterableIterator<T> {
  const { signal, maxPages = DEFAULT_MAX_PAGES } = options;
  const visitedSelfHrefs = new Set<string>();
  let current: T = firstResult;
  let hops = 0;

  while (true) {
    visitedSelfHrefs.add(current._links.self.href);
    yield current;

    // Checked here — right after the consumer asks for the next page,
    // before any work happens — rather than at the top of the loop, so an
    // abort during the pause between yields is caught before the hop it
    // would otherwise trigger.
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException('paginate() aborted', 'AbortError');
    }

    const next = halOf(current).get('next');
    if (!next) {
      return;
    }

    hops += 1;
    if (hops > maxPages) {
      throw new HalPaginationGuardError(
        next.href,
        `exceeded the ${maxPages}-page safety cap without _links.next becoming absent`,
      );
    }
    if (visitedSelfHrefs.has(next.href)) {
      throw new HalPaginationGuardError(
        next.href,
        'next link points back to a page already visited in this walk',
      );
    }

    current = (await followLink(client, next, undefined, { signal })) as T;
  }
}
