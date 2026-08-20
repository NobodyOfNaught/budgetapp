import { describe, expect, it } from 'vitest';
import { convertToBudgetMinor, parseFxRateToMicros } from '../../src/lib/money';

describe('parseFxRateToMicros', () => {
  it('scales a plain decimal rate to integer micros', () => {
    expect(parseFxRateToMicros('0.73')).toBe(730000);
    expect(parseFxRateToMicros('1')).toBe(1000000);
    expect(parseFxRateToMicros('1.4285')).toBe(1428500);
  });

  it('accepts a rate with more than 6 decimal places by rounding', () => {
    expect(parseFxRateToMicros('0.7333333')).toBe(733333);
  });

  it('rejects zero, negative, non-numeric, and absurdly large rates', () => {
    expect(() => parseFxRateToMicros('0')).toThrow();
    expect(() => parseFxRateToMicros('-0.73')).toThrow();
    expect(() => parseFxRateToMicros('abc')).toThrow();
    expect(() => parseFxRateToMicros('')).toThrow();
    expect(() => parseFxRateToMicros('1001')).toThrow();
  });

  it('accepts a comma as the decimal separator — a real Neo import failed on exactly this', () => {
    expect(parseFxRateToMicros('0,73')).toBe(730000);
    expect(parseFxRateToMicros(' 0,73 ')).toBe(730000);
  });

  it('does not reinterpret a thousands-separator comma as a decimal point', () => {
    // "1,234" is out of RATE_RE's shape once normalized would make it
    // "1.234" — fine — but a genuine multi-comma typo like "1,234,5"
    // should still be rejected outright, not silently mangled.
    expect(() => parseFxRateToMicros('1,234,5')).toThrow();
  });

  it('accepts a rate right at the upper bound', () => {
    expect(parseFxRateToMicros('1000')).toBe(1000000000);
  });
});

describe('convertToBudgetMinor', () => {
  it('converts using the real Neo sample: -1452.51 CAD at an implied rate', () => {
    // The declined $1,452.51 marina charge from the real Neo file — not
    // actually imported (see test/import/neo.test.ts), but a real
    // magnitude worth rounding-testing against.
    const rateMicros = parseFxRateToMicros('0.73'); // an illustrative CAD->USD rate
    expect(convertToBudgetMinor(-145251, rateMicros)).toBe(-106033); // -1452.51 * 0.73 = -1060.3323 -> rounds to -1060.33
  });

  it('a rate of exactly 1.0 is an identity conversion', () => {
    const rateMicros = parseFxRateToMicros('1');
    expect(convertToBudgetMinor(12345, rateMicros)).toBe(12345);
    expect(convertToBudgetMinor(-500, rateMicros)).toBe(-500);
  });

  it('rounds to the nearest minor unit, per row', () => {
    // 0.73 * 1 cent = 0.73 cents -> rounds to 1.
    expect(convertToBudgetMinor(1, parseFxRateToMicros('0.73'))).toBe(1);
    // 0.001 * 100 cents = 0.1 cents -> rounds to 0.
    expect(convertToBudgetMinor(100, parseFxRateToMicros('0.001'))).toBe(0);
  });

  it('preserves sign', () => {
    const rateMicros = parseFxRateToMicros('0.5');
    expect(convertToBudgetMinor(-1000, rateMicros)).toBe(-500);
    expect(convertToBudgetMinor(1000, rateMicros)).toBe(500);
    expect(convertToBudgetMinor(0, rateMicros)).toBe(0);
  });
});
