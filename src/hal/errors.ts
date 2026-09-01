/**
 * Errors `src/hal` throws.
 *
 * Local to this module by design: `src/errors/` (the package-wide `ApiError`
 * normalization layer) normalizes *HTTP* failures. A HAL follow can fail for
 * reasons an HTTP-shaped error can't represent at all — the caller asked for
 * a relation that isn't there, or asked to follow a link this SDK refuses on
 * security grounds — so those get their own typed failures instead of being
 * forced through a shape built for problem-detail responses. `HalError`
 * extends `SumvinError` so `isSumvinError`/`instanceof SumvinError` still
 * catches these alongside `ApiError`/`ContractDriftError` — that base is a
 * marker for one funnel across every SDK error family, not a normalization
 * of HAL failures into `ApiError`'s shape.
 */
import { SumvinError } from '../errors/sumvin-error.js';

/** Base class for every error this module throws. `instanceof HalError` catches all of them. */
export abstract class HalError extends SumvinError {
  protected constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Thrown by `Hal.follow` (and by `paginate`, which follows `next`
 * internally) when the requested relation is not present in `_links`.
 *
 * @example
 * try {
 *   await hal.follow(client, 'approve');
 * } catch (e) {
 *   if (e instanceof HalRelNotFoundError) {
 *     console.log(`no "approve" action; try one of: ${e.available.join(', ')}`);
 *   }
 * }
 */
export class HalRelNotFoundError extends HalError {
  /** The relation name that was looked up. */
  readonly rel: string;
  /** Every relation actually present, for a useful error message. */
  readonly available: readonly string[];

  constructor(rel: string, available: readonly string[]) {
    super(
      available.length > 0
        ? `no "${rel}" relation in this resource's _links (available: ${available.join(', ')})`
        : `no "${rel}" relation in this resource's _links (no links present)`,
    );
    this.rel = rel;
    this.available = available;
  }
}

/**
 * Thrown when `Hal.follow` (or `paginate`) refuses to dispatch a request for
 * an href it judged unsafe — see `resolveRequestUrl`'s TSDoc
 * (`./origin-guard.ts`) for the full policy. In short: an absolute href is
 * allowed only same-origin with the client's `baseUrl` (every absolute href
 * is refused when `baseUrl` is itself relative, since there is then no
 * origin to compare against); a relative href is allowed only when it also
 * stays inside `baseUrl`'s own path prefix once `..` segments are collapsed
 * — one that would walk outside it is refused too, not just an absolute
 * cross-origin one; and a protocol-relative href (`//evil.example/x`) is
 * refused outright regardless of either check, since it never has a
 * "relative" reading that is actually same-origin.
 *
 * This is a security boundary, not a convenience check: never silently
 * downgrade this to a warning or an `undefined` return.
 *
 * @example
 * try {
 *   await hal.follow(client, 'external-report');
 * } catch (e) {
 *   if (e instanceof HalOriginRefusedError) {
 *     reportSecurityEvent(e.href, e.reasonDetail);
 *   }
 * }
 */
export class HalOriginRefusedError extends HalError {
  /** The href that was refused. */
  readonly href: string;
  /** Why it was refused. */
  readonly reasonDetail: string;

  constructor(href: string, reasonDetail: string) {
    super(`refusing to follow "${href}": ${reasonDetail}`);
    this.href = href;
    this.reasonDetail = reasonDetail;
  }
}

/**
 * Thrown when a `templated` href still has unresolved `{expression}` slots
 * after expansion — a missing required variable, or an RFC 6570 expression
 * form beyond the level-1 simple-string-expansion subset this module
 * implements (see `template.ts`). Never silently sent as a literal URL
 * containing a brace.
 *
 * @example
 * try {
 *   await hal.follow(client, 'transaction', {}); // missing `transaction_id`
 * } catch (e) {
 *   if (e instanceof HalTemplateError) {
 *     console.log(`missing template vars: ${e.unresolved.join(', ')}`);
 *   }
 * }
 */
export class HalTemplateError extends HalError {
  /** The href, unexpanded. */
  readonly href: string;
  /** Every `{expression}` that could not be resolved. */
  readonly unresolved: readonly string[];

  constructor(href: string, unresolved: readonly string[]) {
    super(`cannot expand templated href "${href}": unresolved {${unresolved.join('}, {')}}`);
    this.href = href;
    this.unresolved = unresolved;
  }
}

/**
 * Thrown by `paginate()` when its safety guard trips: a `next` link that
 * points back at a page already visited in this walk, or the hop count
 * exceeding `maxPages`. Both name the offending href so a caller can log
 * exactly where the server's pagination contract broke.
 */
export class HalPaginationGuardError extends HalError {
  /** The `next` href that tripped the guard. */
  readonly href: string;
  /** Why it tripped — cycle, or the hop cap. */
  readonly reasonDetail: string;

  constructor(href: string, reasonDetail: string) {
    super(`pagination stopped at "${href}": ${reasonDetail}`);
    this.href = href;
    this.reasonDetail = reasonDetail;
  }
}
