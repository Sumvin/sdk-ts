import { HalTemplateError } from './errors.js';

/**
 * Values to substitute into a `templated` {@link Link}'s href. Coerced to a
 * string with `String(value)` before percent-encoding, so a number or boolean
 * is accepted without the caller stringifying it first.
 */
export type TemplateVars = Record<string, string | number | boolean>;

// Matches a single brace-delimited expression, capturing its contents so the
// simple-variable check can run against exactly what's inside the braces.
const EXPRESSION_RE = /\{([^{}]*)\}/g;
// RFC 6570 "varname" for level-1 simple string expansion — no operator
// prefix (`+ # . / ; ? &`), no explode/prefix modifiers, no comma-separated
// variable lists. This is deliberately narrower than the full RFC: it is
// exactly the subset `spec/openapi.json` emits (verified directly against
// every href in the vendored spec — see `template.test.ts`).
const SIMPLE_VAR_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * RFC 6570 level-1 "simple string expansion": substitutes each `{varname}`
 * in `href` with the percent-encoded value from `vars`.
 *
 * Anything inside braces that isn't a bare `{varname}` — a missing variable,
 * or an expression using an RFC 6570 operator/modifier this module doesn't
 * implement (`{+var}`, `{?a,b}`, `{var*}`, …) — is treated the same way: an
 * unresolved expression. This function never returns a URL with a literal
 * `{`/`}` still in it; it throws {@link HalTemplateError} instead, naming
 * every expression it could not resolve.
 *
 * @example
 * expandTemplate('/v0/wallets/{wallet_id}/assets/{symbol}', {
 *   wallet_id: 'w_1',
 *   symbol: 'USDC',
 * });
 * // => '/v0/wallets/w_1/assets/USDC'
 *
 * @throws {HalTemplateError} if any expression in `href` is left unresolved.
 */
export function expandTemplate(href: string, vars: TemplateVars): string {
  const unresolved: string[] = [];

  const expanded = href.replace(EXPRESSION_RE, (match, expression: string) => {
    if (SIMPLE_VAR_RE.test(expression)) {
      const value = vars[expression];
      if (value !== undefined) {
        return encodeURIComponent(String(value));
      }
    }
    unresolved.push(expression);
    return match;
  });

  if (unresolved.length > 0) {
    throw new HalTemplateError(href, unresolved);
  }

  return expanded;
}
