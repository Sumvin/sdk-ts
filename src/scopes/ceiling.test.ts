import { describe, expect, it } from 'vitest';
import { isSumvinError } from '../errors/sumvin-error.js';
import { readScopeCeiling, type ScopeCeiling } from './ceiling.js';
import { isScopeCeilingError, ScopeCeilingError, type ScopeCeilingRefusal } from './errors.js';

/**
 * Golden vectors are checked against sumvin-api's own scope parser and
 * statement renderer at main `3f1f4ee66e9a7b80dd87b84c571df274ef354c97`
 * (`scopes/statement.py`, `sumvin/utils/currency.py`). The premise-gate
 * amendments — observed directly against the API at main `5dba4e41` — add
 * the query-strictness, ASCII-only, and vector-correction cases below and
 * OVERRIDE the base contract where the two would otherwise disagree (ENG-3594
 * plan, "Premise-gate amendments").
 */
const BASE = 'sr:us:pint:errand:search';

function expectRefusal(scope: string, reason: ScopeCeilingRefusal): void {
  let thrown: unknown;
  try {
    readScopeCeiling(scope);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ScopeCeilingError);
  expect(isScopeCeilingError(thrown)).toBe(true);
  const error = thrown as ScopeCeilingError;
  expect(error.reason).toBe(reason);
  expect(error.scope).toBe(scope);
}

describe('readScopeCeiling — no ceiling', () => {
  // When: this test goes red if a scope with no "max" key throws or returns
  // anything other than null.
  it('returns null when the scope states no ceiling', () => {
    expect(readScopeCeiling(`${BASE}?time=2592000`)).toBeNull();
  });

  // When: this test goes red if a scope with no query string at all is
  // treated as malformed instead of "no ceiling".
  it('returns null for a scope name with no query string', () => {
    expect(readScopeCeiling(BASE)).toBeNull();
  });

  // When: this test goes red if a bare trailing "?" (no query pairs at all)
  // is treated as malformed instead of "no query parameters".
  it('returns null for a scope with a trailing "?" and no query pairs', () => {
    expect(readScopeCeiling(`${BASE}?`)).toBeNull();
  });
});

describe('readScopeCeiling — malformed scope grammar', () => {
  // When: this test goes red if the 5-segment / "sr" / "pint" grammar check
  // is relaxed to accept a name it should refuse.
  const cases: ReadonlyArray<{ label: string; scope: string }> = [
    {
      label: 'an empty segment (amendment: all 5 segments must be non-empty)',
      scope: `sr::pint:x:y?max=5&currency=USD`,
    },
    { label: 'fewer than 5 segments', scope: 'sr:us:pint:errand?max=5&currency=USD' },
    { label: 'more than 5 segments', scope: `${BASE}:extra?max=5&currency=USD` },
    {
      label: 'position 0 is not "sr"',
      scope: 'xx:us:pint:errand:search?max=5&currency=USD',
    },
    {
      label: 'position 2 is not "pint"',
      scope: 'sr:us:xxxx:errand:search?max=5&currency=USD',
    },
  ];

  it.each(cases)('refuses $label', ({ scope }) => {
    expectRefusal(scope, 'malformed-scope');
  });
});

describe('readScopeCeiling — query grammar stricter than URLSearchParams', () => {
  // When: this test goes red if the pre-`URLSearchParams` strictness check
  // (amendment: "Query strictness") is dropped — `URLSearchParams` itself
  // silently accepts every one of these.
  const cases: ReadonlyArray<{ label: string; scope: string }> = [
    { label: 'a repeated leading "?"', scope: `${BASE}??max=5&currency=USD` },
    { label: 'a leading "&"', scope: `${BASE}?&max=5&currency=USD` },
    { label: 'a trailing "&"', scope: `${BASE}?max=5&currency=USD&` },
    { label: 'an empty "&&" segment', scope: `${BASE}?max=5&&currency=USD` },
    { label: 'a segment with no "="', scope: `${BASE}?max=5&currency` },
  ];

  it.each(cases)('refuses $label', ({ scope }) => {
    expectRefusal(scope, 'malformed-scope');
  });
});

describe('readScopeCeiling — duplicate and empty query values', () => {
  // When: this test goes red if a duplicate `max`/`currency`/`asset` key is
  // resolved last-wins (Node's own `URLSearchParams.get` behavior) instead
  // of refused — rendering one value while a different one governs
  // enforcement is the defect class this reader exists to close.
  const duplicateCases: ReadonlyArray<{ label: string; scope: string }> = [
    { label: 'a duplicate "max" key', scope: `${BASE}?max=5&max=10&currency=USD` },
    { label: 'a duplicate "currency" key', scope: `${BASE}?max=5&currency=USD&currency=EUR` },
    { label: 'a duplicate "asset" key', scope: `${BASE}?max=5&asset=USDC&asset=USDC` },
  ];
  it.each(duplicateCases)('refuses $label', ({ scope }) => {
    expectRefusal(scope, 'malformed-scope');
  });

  // When: this test goes red if an empty `max`/`currency`/`asset` value is
  // read as an absent key (and so silently falls through to a different
  // refusal, or is accepted) instead of being refused directly.
  const emptyCases: ReadonlyArray<{ label: string; scope: string }> = [
    { label: 'an empty "max" value', scope: `${BASE}?max=&currency=USD` },
    { label: 'an empty "currency" value', scope: `${BASE}?max=5&currency=` },
    { label: 'an empty "asset" value', scope: `${BASE}?max=5&asset=` },
  ];
  it.each(emptyCases)('refuses $label', ({ scope }) => {
    expectRefusal(scope, 'malformed-scope');
  });
});

describe('readScopeCeiling — invalid amount', () => {
  // When: this test goes red if the amount grammar (`^[0-9]+(\.[0-9]+)?$`)
  // is loosened to accept a sign, an exponent, a bare/trailing dot, embedded
  // whitespace, a non-ASCII digit, or a trailing control character.
  const cases: ReadonlyArray<{ label: string; scope: string }> = [
    { label: 'scientific notation', scope: `${BASE}?max=1e3&currency=USD` },
    { label: 'a leading-dot fraction with no integer part', scope: `${BASE}?max=.5&currency=USD` },
    { label: 'a trailing dot with no fraction', scope: `${BASE}?max=1.&currency=USD` },
    { label: 'two decimal points', scope: `${BASE}?max=1.5.0&currency=USD` },
    { label: 'non-numeric text', scope: `${BASE}?max=abc&currency=USD` },
    { label: 'a %-encoded embedded space', scope: `${BASE}?max=%201&currency=USD` },
    { label: 'a literal "+" (decodes to a space)', scope: `${BASE}?max=+1&currency=USD` },
    { label: 'a leading "-" on a fractional amount', scope: `${BASE}?max=-0.5&currency=USD` },
    { label: 'a leading "-" on zero', scope: `${BASE}?max=-0&currency=USD` },
    {
      label: 'non-ASCII (Arabic-Indic) digits',
      scope: `${BASE}?max=%D9%A1%D9%A2&currency=USD`,
    },
    { label: 'a trailing newline', scope: `${BASE}?max=25%0A&currency=USD` },
  ];

  it.each(cases)('refuses $label', ({ scope }) => {
    expectRefusal(scope, 'invalid-amount');
  });

  // When: this test goes red if zero is treated as an invalid amount — the
  // reader reports what was signed, and the API's own parser admits zero.
  it('admits zero as a valid amount', () => {
    expect(readScopeCeiling(`${BASE}?max=0&currency=USD`)).toEqual({
      kind: 'fiat',
      amount: '0.00',
      currency: 'USD',
      decimals: 2,
    });
  });
});

describe('readScopeCeiling — denomination presence', () => {
  // When: this test goes red if both "currency" and "asset" being present
  // is silently resolved to one of them instead of refused.
  it('refuses both "currency" and "asset" present', () => {
    expectRefusal(`${BASE}?max=5&currency=USD&asset=USDC`, 'ambiguous-denomination');
  });

  // When: this test goes red if neither "currency" nor "asset" is treated
  // as fiat-by-default (or any other silent resolution) instead of refused.
  it('refuses neither "currency" nor "asset" present', () => {
    expectRefusal(`${BASE}?time=2592000&max=5`, 'missing-denomination');
  });
});

describe('readScopeCeiling — accepted fiat ceilings', () => {
  // When: this test goes red if fiat padding to the currency's decimals is
  // dropped, if the currency code is not upper-cased, or if a leading
  // integer zero is not stripped.
  const cases: ReadonlyArray<{ label: string; scope: string; expected: ScopeCeiling }> = [
    {
      label: 'a whole number pads to 2 decimals for USD',
      scope: `${BASE}?max=25&currency=USD`,
      expected: { kind: 'fiat', amount: '25.00', currency: 'USD', decimals: 2 },
    },
    {
      label: 'one fractional digit pads to 2 decimals',
      scope: `${BASE}?max=25.5&currency=USD`,
      expected: { kind: 'fiat', amount: '25.50', currency: 'USD', decimals: 2 },
    },
    {
      label: 'a lower-case currency code is upper-cased in the output',
      scope: `${BASE}?max=250.50&currency=usd`,
      expected: { kind: 'fiat', amount: '250.50', currency: 'USD', decimals: 2 },
    },
    {
      label: 'a zero-decimal currency (JPY) is never padded with a dot',
      scope: `${BASE}?max=25&currency=JPY`,
      expected: { kind: 'fiat', amount: '25', currency: 'JPY', decimals: 0 },
    },
    {
      label: 'a 3-decimal currency (KWD) at exactly its precision',
      scope: `${BASE}?max=1.234&currency=KWD`,
      expected: { kind: 'fiat', amount: '1.234', currency: 'KWD', decimals: 3 },
    },
    {
      label: 'zero pads to the currency decimals',
      scope: `${BASE}?max=0&currency=USD`,
      expected: { kind: 'fiat', amount: '0.00', currency: 'USD', decimals: 2 },
    },
    {
      label: 'exact trailing zeros beyond the decimals are exact, not over-precise',
      scope: `${BASE}?max=25.000&currency=USD`,
      expected: { kind: 'fiat', amount: '25.00', currency: 'USD', decimals: 2 },
    },
    {
      label: 'leading integer zeros are stripped to a single significant value',
      scope: `${BASE}?max=007&currency=USD`,
      expected: { kind: 'fiat', amount: '7.00', currency: 'USD', decimals: 2 },
    },
    {
      label: 'a mixed-case currency code is upper-cased',
      scope: `${BASE}?max=25&currency=Usd`,
      expected: { kind: 'fiat', amount: '25.00', currency: 'USD', decimals: 2 },
    },
  ];

  it.each(cases)('$label', ({ scope, expected }) => {
    expect(readScopeCeiling(scope)).toEqual(expected);
  });
});

describe('readScopeCeiling — fiat over-precision is refused, never truncated', () => {
  // When: this test goes red if an amount whose significant digits exceed
  // the currency's decimals is silently truncated to fit instead of refused.
  const cases: ReadonlyArray<{ label: string; scope: string }> = [
    { label: 'one digit over USD’s 2 decimals', scope: `${BASE}?max=25.001&currency=USD` },
    { label: 'any fraction at all for JPY’s 0 decimals', scope: `${BASE}?max=1.5&currency=JPY` },
    { label: 'one digit over KWD’s 3 decimals', scope: `${BASE}?max=1.2345&currency=KWD` },
  ];

  it.each(cases)('refuses $label', ({ scope }) => {
    expectRefusal(scope, 'over-precise');
  });
});

describe('readScopeCeiling — unknown fiat currency', () => {
  // When: this test goes red if an unrecognized currency code is defaulted
  // to 2 decimals (or any other fallback) instead of refused.
  it('refuses a currency not in the static ISO 4217 table', () => {
    expectRefusal(`${BASE}?max=25&currency=XYZ`, 'unknown-denomination');
  });
});

describe('readScopeCeiling — accepted asset ceilings', () => {
  // When: this test goes red if trailing zeros stop being stripped from an
  // asset amount, if the verbatim "asset" value is altered, or if a chain
  // suffix stops being ignored for the decimals lookup.
  const cases: ReadonlyArray<{ label: string; scope: string; expected: ScopeCeiling }> = [
    {
      label: 'a sub-unit amount with no trailing zeros to strip',
      scope: `${BASE}?max=0.5&asset=USDC`,
      expected: { kind: 'asset', amount: '0.5', asset: 'USDC', symbol: 'USDC', decimals: 6 },
    },
    {
      label: 'a whole number carries no decimal point',
      scope: `${BASE}?max=25&asset=USDC`,
      expected: { kind: 'asset', amount: '25', asset: 'USDC', symbol: 'USDC', decimals: 6 },
    },
    {
      label: 'one fractional digit with nothing to strip',
      scope: `${BASE}?max=25.5&asset=USDC`,
      expected: { kind: 'asset', amount: '25.5', asset: 'USDC', symbol: 'USDC', decimals: 6 },
    },
    {
      label: 'exactly at USDC’s 6-decimal precision',
      scope: `${BASE}?max=0.000001&asset=USDC`,
      expected: { kind: 'asset', amount: '0.000001', asset: 'USDC', symbol: 'USDC', decimals: 6 },
    },
    {
      label: 'a chain suffix is kept verbatim in "asset" but ignored for the decimals lookup',
      scope: `${BASE}?max=10&asset=USDC@sei`,
      expected: { kind: 'asset', amount: '10', asset: 'USDC@sei', symbol: 'USDC', decimals: 6 },
    },
  ];

  it.each(cases)('$label', ({ scope, expected }) => {
    expect(readScopeCeiling(scope)).toEqual(expected);
  });
});

describe('readScopeCeiling — asset over-precision is refused, never truncated', () => {
  // When: this test goes red if an asset amount finer than its known
  // decimals is silently truncated instead of refused.
  it('refuses one digit over USDC’s 6 decimals', () => {
    expectRefusal(`${BASE}?max=25.0000001&asset=USDC`, 'over-precise');
  });
});

describe('readScopeCeiling — unrecognized asset denomination', () => {
  // When: this test goes red if an unknown symbol, an unlisted asset, a
  // raw contract address, or an upper-case chain suffix is accepted instead
  // of refused.
  const cases: ReadonlyArray<{ label: string; scope: string }> = [
    { label: 'a symbol not in the static decimals table', scope: `${BASE}?max=10&asset=SEI` },
    {
      label: 'a raw 0x… contract address instead of a symbol',
      scope: `${BASE}?max=10&asset=0x1234567890abcdef1234567890abcdef12345678`,
    },
    {
      label: 'an upper-case chain suffix (amendment: chain must be lower-case)',
      scope: `${BASE}?max=10&asset=USDC@SEI`,
    },
  ];

  it.each(cases)('refuses $label', ({ scope }) => {
    expectRefusal(scope, 'unknown-denomination');
  });
});

describe('ScopeCeilingError', () => {
  // When: this test goes red if ScopeCeilingError stops extending
  // SumvinError, breaking the one-funnel `isSumvinError` guard every other
  // SDK error family is caught by.
  it('is a SumvinError', () => {
    try {
      readScopeCeiling(`${BASE}?max=abc`);
      expect.fail('expected readScopeCeiling to throw');
    } catch (e) {
      expect(isSumvinError(e)).toBe(true);
    }
  });

  // When: this test goes red if isScopeCeilingError stops narrowing
  // correctly, e.g. by matching an unrelated Error or SumvinError subclass.
  it('isScopeCeilingError rejects an unrelated error', () => {
    expect(isScopeCeilingError(new Error('not a scope ceiling error'))).toBe(false);
  });
});
