/**
 * Reads a PINT scope's display-unit spend ceiling (ENG-3594).
 *
 * Mirrors sumvin-api's own scope parser and statement renderer
 * (`scopes/statement.py`, `sumvin/utils/currency.py`) at API main
 * `3f1f4ee66e9a7b80dd87b84c571df274ef354c97` — see `ceiling.test.ts` for the
 * golden vectors this was checked against. `readScopeCeiling` is pure: it
 * never mutates or normalizes its input string, does no floating-point
 * arithmetic, and never touches `Intl` — every amount stays a string
 * end-to-end so a display-unit ceiling can never silently lose precision
 * the way a `Number` parse would.
 */
import { ScopeCeilingError, type ScopeCeilingRefusal } from './errors.js';

/**
 * A PINT scope's spend ceiling, in the same display-unit text the server's
 * signed statement shows (`scopes/statement.py`) — never a minor-unit
 * integer. `kind` discriminates fiat from on-chain-asset denominations,
 * each of which carries a different identifying field (`currency` vs.
 * `asset`/`symbol`).
 *
 * @example
 * const ceiling = readScopeCeiling(scope);
 * if (ceiling?.kind === 'fiat') {
 *   console.log(`${ceiling.amount} ${ceiling.currency}`); // "25.00 USD"
 * } else if (ceiling?.kind === 'asset') {
 *   console.log(`${ceiling.amount} ${ceiling.symbol}`); // "0.5 USDC"
 * }
 */
export type ScopeCeiling =
  | {
      readonly kind: 'fiat';
      /** Padded to `decimals`, with no decimal point when `decimals` is 0. Never truncated. */
      readonly amount: string;
      /** Upper-cased ISO 4217 code, e.g. `"USD"`. */
      readonly currency: string;
      /** The currency's minor-unit decimal places, from a static ISO 4217 table. */
      readonly decimals: number;
    }
  | {
      readonly kind: 'asset';
      /** Trailing zeros stripped, with no decimal point when nothing remains after the point. */
      readonly amount: string;
      /** The scope's `asset` query value verbatim, chain suffix included (e.g. `"USDC@sei"`). */
      readonly asset: string;
      /** The symbol alone, without a chain suffix, e.g. `"USDC"`. */
      readonly symbol: string;
      /** The asset's decimal places, from a static per-symbol table. */
      readonly decimals: number;
    };

// A copy of `sumvin/utils/currency.py:4-20` (12 entries). ENG-3611 tracks
// the 13 ramp currencies still missing from this table upstream — a miss
// here is refused as `unknown-denomination`, never defaulted to 2.
const FIAT_DECIMALS: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  CHF: 2,
};

// D1: a static table, not a caller-supplied resolver (that variant is
// ENG-3615, deferred). Correct only while every catalog USDC row has 6
// decimals — any other asset (SEI, ETH, USDT, …) is refused as
// `unknown-denomination`, never guessed at.
const ASSET_DECIMALS: Readonly<Record<string, number>> = {
  USDC: 6,
};

const SCOPE_NAME_SEGMENTS = 5;

// ASCII-only and fully anchored by construction (amendment 4): `[0-9]`,
// never `\d` — `\d` in a JS regex without the `u`/`v` flag still only
// matches ASCII digits, but the API's Python `\d` accepts Arabic-Indic
// digits, so this reader is deliberately stricter than the API it mirrors.
const AMOUNT_RE = /^[0-9]+(?:\.[0-9]+)?$/;
const ASSET_SYMBOL_RE = /^[A-Z]{2,8}$/;
const ASSET_CHAIN_RE = /^(?:fiat|[a-z0-9_-]+)$/;

/** `frac` with trailing `"0"` characters removed — `"000"` becomes `""`, `"5"` stays `"5"`. */
function trimTrailingZeros(frac: string): string {
  let end = frac.length;
  while (end > 0 && frac[end - 1] === '0') end -= 1;
  return frac.slice(0, end);
}

/** `intPart` with leading `"0"` characters removed, keeping a single `"0"` if that's all there is. */
function stripLeadingZeros(intPart: string): string {
  let start = 0;
  while (start < intPart.length - 1 && intPart[start] === '0') start += 1;
  return intPart.slice(start);
}

/** Pads `frac` to exactly `decimals` characters with trailing zeros; never truncates a significant digit (the caller has already refused anything over-precise). */
function formatFiatAmount(intPart: string, frac: string, decimals: number): string {
  const normalizedInt = stripLeadingZeros(intPart);
  if (decimals === 0) return normalizedInt;
  const padded = `${frac}${'0'.repeat(decimals)}`.slice(0, decimals);
  return `${normalizedInt}.${padded}`;
}

/** `trimmedFrac` is already trailing-zero-stripped; omits the decimal point entirely when it's empty. */
function formatAssetAmount(intPart: string, trimmedFrac: string): string {
  const normalizedInt = stripLeadingZeros(intPart);
  return trimmedFrac.length > 0 ? `${normalizedInt}.${trimmedFrac}` : normalizedInt;
}

type Denomination =
  | { readonly kind: 'fiat'; readonly currency: string }
  | { readonly kind: 'asset'; readonly asset: string };

/**
 * Throws {@link ScopeCeilingError}. A module-level function declaration
 * (not a closure captured per-call inside `readScopeCeiling`) so TypeScript's
 * control-flow analysis trusts its `never` return type to narrow every
 * branch that calls it — a locally-declared `const` arrow function with the
 * same signature does not get that treatment, and every call site below
 * would otherwise need a redundant type assertion.
 */
function refuseScope(scope: string, reason: ScopeCeilingRefusal, detail: string): never {
  throw new ScopeCeilingError(scope, reason, detail);
}

/**
 * Reads the display-unit spend ceiling a PINT scope's `max` query parameter
 * carries, or `null` when the scope states no ceiling at all.
 *
 * Throws {@link ScopeCeilingError} for every scope this reader refuses to
 * interpret — see {@link ScopeCeilingRefusal} for the full list of reasons
 * and what triggers each one.
 *
 * Limitations a caller must know about:
 * - The asset table is static and correct only while every catalog USDC row
 *   has 6 decimals (ENG-3615 tracks a caller-supplied-decimals resolver).
 *   Any other symbol — SEI, ETH, USDT, or anything not in the table — is
 *   refused as `unknown-denomination`, not guessed at.
 * - This reader does not validate the scope name or its other query
 *   parameters against the API's scope registry. A scope with a well-formed
 *   grammar but a name the API would reject for an unrelated reason still
 *   reads its ceiling here.
 * - A PINT can carry more than one ceiling-bearing scope. Call this once
 *   per scope and render every non-`null` result — do not stop at the
 *   first.
 * - Zero is admitted (`max=0` reads as a ceiling of `"0.00"`/`"0"`),
 *   following the API's own parser. A caller drafting a NEW scope, rather
 *   than reading an existing one, should refuse a zero ceiling itself —
 *   that draft-time refusal is out of scope for this reader.
 *
 * @example
 * const ceiling = readScopeCeiling('sr:us:pint:errand:search?time=2592000&max=25.5&currency=USD');
 * // { kind: 'fiat', amount: '25.50', currency: 'USD', decimals: 2 }
 *
 * readScopeCeiling('sr:us:pint:errand:search?time=2592000'); // null — no `max`
 *
 * try {
 *   readScopeCeiling('sr:us:pint:errand:search?max=25.001&currency=USD');
 * } catch (e) {
 *   if (isScopeCeilingError(e)) console.log(e.reason); // "over-precise"
 * }
 */
export function readScopeCeiling(scope: string): ScopeCeiling | null {
  // 1. Grammar — split on the FIRST `?` only; a later `?` is left inside the query.
  const qIndex = scope.indexOf('?');
  const hasQuery = qIndex !== -1;
  const name = hasQuery ? scope.slice(0, qIndex) : scope;
  const rawQuery = hasQuery ? scope.slice(qIndex + 1) : '';

  const segments = name.split(':');
  if (
    segments.length !== SCOPE_NAME_SEGMENTS ||
    segments.some((segment) => segment.length === 0) ||
    segments[0] !== 'sr' ||
    segments[2] !== 'pint'
  ) {
    refuseScope(
      scope,
      'malformed-scope',
      `scope name "${name}" is not exactly ${SCOPE_NAME_SEGMENTS} non-empty ":"-separated ` +
        'segments with "sr" in position 0 and "pint" in position 2',
    );
  }

  // 2. Query — reject grammar `URLSearchParams` would silently accept, before decoding.
  // An absent query and a bare trailing "?" with nothing after it are both treated as
  // "no query parameters at all" rather than malformed.
  if (rawQuery.length > 0) {
    if (rawQuery.startsWith('?')) {
      refuseScope(scope, 'malformed-scope', 'query string starts with a repeated "?"');
    }
    const rawSegments = rawQuery.split('&');
    if (rawSegments.some((segment) => segment.length === 0)) {
      refuseScope(scope, 'malformed-scope', 'query string has an empty "&"-separated segment');
    }
    if (rawSegments.some((segment) => !segment.includes('='))) {
      refuseScope(scope, 'malformed-scope', 'query string has a segment with no "="');
    }
  }

  const params = new URLSearchParams(rawQuery);
  for (const key of ['max', 'currency', 'asset'] as const) {
    const values = params.getAll(key);
    if (values.length > 1) {
      refuseScope(scope, 'malformed-scope', `query has a duplicate "${key}" key`);
    }
    if (values.length === 1 && values[0] === '') {
      refuseScope(scope, 'malformed-scope', `query's "${key}" value is empty`);
    }
  }

  // 3. No ceiling.
  const maxRaw = params.get('max');
  if (maxRaw === null) return null;

  // 4. Amount.
  if (!AMOUNT_RE.test(maxRaw)) {
    refuseScope(
      scope,
      'invalid-amount',
      `"${maxRaw}" is not an unsigned ASCII-digit decimal amount`,
    );
  }

  // 5. Denomination.
  const currencyRaw = params.get('currency');
  const assetRaw = params.get('asset');
  let denomination: Denomination;
  if (currencyRaw !== null && assetRaw !== null) {
    refuseScope(scope, 'ambiguous-denomination', 'both "currency" and "asset" are present');
  } else if (currencyRaw !== null) {
    denomination = { kind: 'fiat', currency: currencyRaw };
  } else if (assetRaw !== null) {
    denomination = { kind: 'asset', asset: assetRaw };
  } else {
    refuseScope(scope, 'missing-denomination', 'neither "currency" nor "asset" is present');
  }

  const dotIndex = maxRaw.indexOf('.');
  const intPart = dotIndex === -1 ? maxRaw : maxRaw.slice(0, dotIndex);
  const fracPart = dotIndex === -1 ? '' : maxRaw.slice(dotIndex + 1);
  const trimmedFrac = trimTrailingZeros(fracPart);

  // 6. Fiat.
  if (denomination.kind === 'fiat') {
    const currency = denomination.currency.toUpperCase();
    const decimals = FIAT_DECIMALS[currency];
    if (decimals === undefined) {
      refuseScope(scope, 'unknown-denomination', `"${currency}" is not a known fiat currency`);
    }
    // 8. Precision.
    if (trimmedFrac.length > decimals) {
      refuseScope(
        scope,
        'over-precise',
        `"${maxRaw}" has more than ${decimals} decimal place(s) for ${currency}`,
      );
    }
    return {
      kind: 'fiat',
      amount: formatFiatAmount(intPart, fracPart, decimals),
      currency,
      decimals,
    };
  }

  // 7. Asset.
  const { asset } = denomination;
  const atIndex = asset.indexOf('@');
  const symbol = atIndex === -1 ? asset : asset.slice(0, atIndex);
  const chain = atIndex === -1 ? undefined : asset.slice(atIndex + 1);

  if (!ASSET_SYMBOL_RE.test(symbol)) {
    refuseScope(scope, 'unknown-denomination', `"${symbol}" is not a recognized asset symbol`);
  }
  if (chain !== undefined && !ASSET_CHAIN_RE.test(chain)) {
    refuseScope(scope, 'unknown-denomination', `"${chain}" is not a recognized chain suffix`);
  }
  const decimals = ASSET_DECIMALS[symbol];
  if (decimals === undefined) {
    refuseScope(scope, 'unknown-denomination', `"${symbol}" has no known decimals`);
  }
  // 8. Precision.
  if (trimmedFrac.length > decimals) {
    refuseScope(
      scope,
      'over-precise',
      `"${maxRaw}" has more than ${decimals} decimal place(s) for ${symbol}`,
    );
  }
  return {
    kind: 'asset',
    amount: formatAssetAmount(intPart, trimmedFrac),
    asset,
    symbol,
    decimals,
  };
}
