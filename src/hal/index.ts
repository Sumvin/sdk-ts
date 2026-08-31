/**
 * `src/hal` — HAL `_links` navigation over the generated client.
 *
 * `halOf(data)` views any response's `_links` map; `follow()` on the result
 * issues the request through the configured `Client` (never a bare `fetch`),
 * enforcing the origin guard from D5 (ENG-3133) and expanding a `templated`
 * href per RFC 6570 level-1 simple string expansion. `paginate()` walks
 * `_links.next` the same guarded way. See `link.ts`, `paginate.ts`, and
 * `errors.ts` for the full contract of each.
 */
export {
  HalError,
  HalOriginRefusedError,
  HalPaginationGuardError,
  HalRelNotFoundError,
  HalTemplateError,
} from './errors.js';
export { type Hal, halOf, type LinksBearing } from './link.js';
export { type Paginatable, type PaginateOptions, paginate } from './paginate.js';
export { expandTemplate, type TemplateVars } from './template.js';
