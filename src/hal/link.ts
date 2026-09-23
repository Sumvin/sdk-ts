import type { ZodType } from 'zod';
import type { Client } from '../generated/client/index.js';
import type { Link } from '../generated/index.js';
import { ContractDriftError } from '../validation/contract-drift-error.js';
import { truncateForDrift } from '../validation/truncate-for-drift.js';
import { HalRelNotFoundError } from './errors.js';
import { followLink } from './follow.js';
import type { TemplateVars } from './template.js';

/**
 * Any generated response shape carrying a HAL `_links` map — every one of
 * the 110 response schemas in the vendored spec (P1), whether typed with a
 * fully generic `{ [key: string]: Link }` index signature or a named type
 * like `PaginationLinks` / `AssetLinks` (`self: Link` plus optional named
 * links plus `[key: string]: unknown`). Both shapes are structurally
 * assignable to this constraint.
 */
export type LinksBearing = { _links: Record<string, unknown> };

/** The view `halOf()` returns over a response's `_links` map. */
export interface Hal {
  /** Whether `rel` names a present, well-formed link. */
  has(rel: string): boolean;
  /**
   * The link at `rel`, typed as the generated {@link Link} — no
   * hand-written mirror of that shape. `undefined` if `rel` is absent, or
   * present but not link-shaped (a malformed or unexpected `_links` entry
   * reads as "not a link" rather than throwing).
   */
  get(rel: string): Link | undefined;
  /**
   * Follow the link at `rel` through `client` — never a bare `fetch`, so the
   * request inherits `client`'s `baseUrl`, auth, and validation exactly as
   * every generated operation call does. The href is checked
   * against the origin guard first (`resolveRequestUrl`, `./origin-guard.ts`):
   * an absolute href is refused unless it resolves to `client`'s own
   * `baseUrl` origin, a relative href is refused if it would walk outside
   * `baseUrl`'s own path prefix, and a protocol-relative href is refused
   * outright — see {@link HalOriginRefusedError}. A `templated` link is
   * expanded with `vars` first; see {@link HalTemplateError}.
   *
   * Returns the parsed response body, typed `unknown` — honestly: an
   * arbitrary href cannot be mapped back to a named, typed operation, so a
   * more specific return type here would be a lie. This is a
   * **deliberate decision**, not an oversight left
   * for a future pass to tighten. For a typed result, call the named
   * generated operation instead when one exists for what this link points
   * at, or use {@link Hal.followValidated} to narrow the body against a
   * schema you supply.
   *
   * @throws {HalRelNotFoundError} if `rel` is not present in `_links`.
   * @throws {HalOriginRefusedError} if `rel`'s href is refused by the origin
   *   guard — see {@link HalOriginRefusedError} for the full policy.
   * @throws {HalTemplateError} if `rel`'s href is `templated` and `vars`
   *   leaves any `{expression}` unresolved.
   */
  follow(client: Client, rel: string, vars?: TemplateVars): Promise<unknown>;
  /**
   * Like {@link Hal.follow}, but **parses** the response body against
   * `schema` — a real `schema.safeParse`, never a cast — and returns the
   * parsed, typed result. The type comes from the caller's own `schema`,
   * not from this module: `follow()` stays honestly `unknown` because an
   * arbitrary href can't be mapped to a named operation, but a caller who
   * *does* know (or is willing to assert) the shape at the far end of `rel`
   * gets that shape back for real, checked, rather than by an unchecked
   * cast at the call site.
   *
   * Relation lookup, template expansion, and the origin guard all run
   * exactly as they do for {@link Hal.follow} — and all run **before**
   * `schema` is asked anything, so a missing relation or a refused href
   * never reaches `safeParse`.
   *
   * On a schema mismatch, throws {@link ContractDriftError} — the same
   * funnel a `strict`-tier generated operation's response validator throws
   * into (`src/validation/install.ts`) — with `operationKey` set to
   * `` `FOLLOW ${rel}` ``, `tier: 'strict'`, `reason: 'schema-mismatch'`,
   * `issues` from the Zod error, and `value` a length-bounded view of the
   * raw body (see {@link ContractDriftError.value}). A caller checking
   * `isContractDriftError`/`isSumvinError` in one place catches a followed
   * link's drift the same way it catches a generated operation's.
   *
   * @throws {HalRelNotFoundError} if `rel` is not present in `_links`.
   * @throws {HalOriginRefusedError} if `rel`'s href is refused by the origin
   *   guard — see {@link HalOriginRefusedError} for the full policy.
   * @throws {HalTemplateError} if `rel`'s href is `templated` and `vars`
   *   leaves any `{expression}` unresolved.
   * @throws {ContractDriftError} if the response body does not match `schema`.
   *
   * @example
   * const price = await hal.followValidated(client, 'price', AssetPriceResponseSchema);
   */
  followValidated<T>(
    client: Client,
    rel: string,
    schema: ZodType<T>,
    vars?: TemplateVars,
  ): Promise<T>;
}

function isLinkLike(value: unknown): value is Link {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { href?: unknown }).href === 'string'
  );
}

/**
 * View a response's `_links` map as a {@link Hal}.
 *
 * @example
 * const budget = await getBudget({ client, path: { budget_id } });
 * const hal = halOf(budget.data!);
 * if (hal.has('archive')) {
 *   await hal.follow(client, 'archive');
 * }
 */
export function halOf<T extends LinksBearing>(data: T): Hal {
  const links = data._links;

  const get = (rel: string): Link | undefined => {
    const value = links[rel];
    return isLinkLike(value) ? value : undefined;
  };

  const has = (rel: string): boolean => get(rel) !== undefined;

  const availableRels = (): string[] => Object.keys(links).filter((rel) => isLinkLike(links[rel]));

  const follow = async (client: Client, rel: string, vars?: TemplateVars): Promise<unknown> => {
    const link = get(rel);
    if (!link) {
      throw new HalRelNotFoundError(rel, availableRels());
    }
    return followLink(client, link, vars);
  };

  const followValidated = async <T>(
    client: Client,
    rel: string,
    schema: ZodType<T>,
    vars?: TemplateVars,
  ): Promise<T> => {
    const link = get(rel);
    if (!link) {
      throw new HalRelNotFoundError(rel, availableRels());
    }
    const body = await followLink(client, link, vars);

    const result = schema.safeParse(body);
    if (result.success) {
      return result.data;
    }

    throw new ContractDriftError({
      operationKey: `FOLLOW ${rel}`,
      tier: 'strict',
      reason: 'schema-mismatch',
      issues: result.error.issues,
      value: truncateForDrift(body),
    });
  };

  return { has, get, follow, followValidated };
}
