import { describe, expect, it } from 'vitest';
import { parseVancityCsv, suggestedCategoryName } from '../../src/import/vancity';
import type { ParsedOrdinary } from '../../src/import/types';

// Header and every data row transcribed verbatim from a real Vancity
// chequing export (Jul–Aug 2026, CAD). This file is the parser's spec; see
// src/import/vancity.ts for the three format quirks it exists to handle.

const HEADER = 'Date,Description,Debits,Credits,Balance';

function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows, ''].join('\n');
}

function ordinaries(result: { rows: unknown[] }): ParsedOrdinary[] {
  return result.rows as ParsedOrdinary[];
}

// All 18 real rows, newest-first exactly as the bank emits them. The
// Balance column is deliberately preserved even though the parser ignores
// it — it is this suite's independent ground truth (see the last test).
const REAL_FILE = csv(
  '18-Aug-2026,Preauthorized payment BLUESHORE FINANCIAL PAD BLUESHORE FINANCIAL PAD BLUESHORE FINANCIAL PAD,500.00,,55.63',
  '17-Aug-2026,Preauthorized credit Tangerine Tangerine Tangerine,,10.00,555.63',
  '17-Aug-2026,Preauthorized payment IND ALL LIFE IN IND ALL LIFE IN IND ALL LIFE IN,164.16,,545.63',
  '14-Aug-2026,Bill payment-online WISE 6154 180470,2093.80,,709.79',
  '14-Aug-2026,Payroll deposit INOVATEC INOVATEC INOVATEC,,2455.48,2803.59',
  '04-Aug-2026,Preauthorized payment Tangerine Tangerine Tangerine,10.00,,348.11',
  '04-Aug-2026,Bill payment-online WISE 6154 576167,2100.00,,358.11',
  '31-Jul-2026,Payroll deposit INOVATEC INOVATEC INOVATEC,,2455.48,2458.11',
  '25-Jul-2026,Bill payment-online WISE 6154 376459,1900.31,,2.63',
  '25-Jul-2026,Bill payment-online VANCITY VISA 2476 376282,200.00,,1902.94',
  '18-Jul-2026,Preauthorized payment BLUESHORE FINANCIAL PAD BLUESHORE FINANCIAL PAD BLUESHORE FINANCIAL PAD,500.00,,2102.94',
  '16-Jul-2026,Preauthorized credit Tangerine Tangerine Tangerine,,10.00,2602.94',
  '16-Jul-2026,Preauthorized payment IND ALL LIFE IN IND ALL LIFE IN IND ALL LIFE IN,164.16,,2592.94',
  '15-Jul-2026,Payroll deposit INOVATEC INOVATEC INOVATEC,,2455.48,2757.10',
  '13-Jul-2026,Bill payment-online VANCITY VISA 2476 596606,350.00,,301.62',
  '02-Jul-2026,Preauthorized payment Tangerine Tangerine Tangerine,10.00,,651.62',
  '01-Jul-2026,Bill payment-online WISE 6154 261014,1142.12,,661.62',
  '01-Jul-2026,Bill payment-online WISE 6154 260665,716.00,,1803.74',
);

describe('DD-Mon-YYYY dates', () => {
  it('converts to ISO', () => {
    const result = parseVancityCsv(csv('18-Aug-2026,Payroll deposit INOVATEC INOVATEC INOVATEC,,2455.48,55.63'));
    expect(ordinaries(result)[0]?.date).toBe('2026-08-18');
  });

  it('handles every month name, single- and double-digit days', () => {
    const months = [
      ['01-Jan-2026', '2026-01-01'],
      ['9-Feb-2026', '2026-02-09'],
      ['31-Mar-2026', '2026-03-31'],
      ['15-Apr-2026', '2026-04-15'],
      ['15-May-2026', '2026-05-15'],
      ['15-Jun-2026', '2026-06-15'],
      ['15-Jul-2026', '2026-07-15'],
      ['15-Aug-2026', '2026-08-15'],
      ['15-Sep-2026', '2026-09-15'],
      ['15-Oct-2026', '2026-10-15'],
      ['15-Nov-2026', '2026-11-15'],
      ['15-Dec-2026', '2026-12-15'],
    ] as const;
    for (const [raw, iso] of months) {
      const result = parseVancityCsv(csv(`${raw},Payroll deposit ACME ACME ACME,,10.00,0.00`));
      expect(ordinaries(result)[0]?.date).toBe(iso);
    }
  });

  it('skips a row whose month name is not real, rather than guessing', () => {
    const result = parseVancityCsv(csv('18-Xyz-2026,Payroll deposit ACME ACME ACME,,10.00,0.00'));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('unrecognized date');
  });
});

describe('sign comes from which column is populated, not the printed character', () => {
  it('a Debit is an outflow', () => {
    const result = parseVancityCsv(csv('18-Aug-2026,Preauthorized payment Tangerine Tangerine Tangerine,10.00,,55.63'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(-1000);
  });

  it('a Credit is an inflow', () => {
    const result = parseVancityCsv(csv('14-Aug-2026,Payroll deposit INOVATEC INOVATEC INOVATEC,,2455.48,2803.59'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(245548);
  });

  it('a Debit already printed negative is still an outflow, not double-negated', () => {
    const result = parseVancityCsv(csv('18-Aug-2026,Preauthorized payment Tangerine Tangerine Tangerine,-10.00,,55.63'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(-1000);
  });

  it('skips a row with neither column readable', () => {
    const result = parseVancityCsv(csv('18-Aug-2026,Preauthorized payment Tangerine Tangerine Tangerine,,,55.63'));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('neither Debits nor Credits had a readable amount');
  });
});

describe("the triplicated merchant name — Vancity's signature quirk", () => {
  it('collapses a single repeated word', () => {
    const result = parseVancityCsv(csv('17-Aug-2026,Preauthorized credit Tangerine Tangerine Tangerine,,10.00,555.63'));
    expect(ordinaries(result)[0]?.payeeName).toBe('Tangerine');
  });

  it('collapses a repeated multi-word run', () => {
    const result = parseVancityCsv(
      csv('18-Aug-2026,Preauthorized payment BLUESHORE FINANCIAL PAD BLUESHORE FINANCIAL PAD BLUESHORE FINANCIAL PAD,500.00,,55.63'),
    );
    expect(ordinaries(result)[0]?.payeeName).toBe('BLUESHORE FINANCIAL PAD');
  });

  it('collapses a four-word run — the unit length is not assumed', () => {
    const result = parseVancityCsv(
      csv('17-Aug-2026,Preauthorized payment IND ALL LIFE IN IND ALL LIFE IN IND ALL LIFE IN,164.16,,545.63'),
    );
    expect(ordinaries(result)[0]?.payeeName).toBe('IND ALL LIFE IN');
  });

  it('collapses a doubled name too — the repeat count is not assumed to be three', () => {
    const result = parseVancityCsv(csv('17-Aug-2026,Payroll deposit ACME CORP ACME CORP,,10.00,0.00'));
    expect(ordinaries(result)[0]?.payeeName).toBe('ACME CORP');
  });

  it('leaves a non-repeating description alone apart from its type prefix', () => {
    const result = parseVancityCsv(csv('14-Aug-2026,Bill payment-online WISE 6154 180470,2093.80,,709.79'));
    // The trailing reference number is deliberately NOT stripped here —
    // cleanPayeeName does that centrally at the route layer.
    expect(ordinaries(result)[0]?.payeeName).toBe('WISE 6154 180470');
  });

  it('does not mangle a name that merely ends with a repeated word', () => {
    // "VISA 2476 2476" would collapse to "2476" if the scan ran right to
    // left; going left to right keeps the whole tail as the unit.
    const result = parseVancityCsv(csv('13-Jul-2026,Bill payment-online BIG BANK BIG BANK,350.00,,301.62'));
    expect(ordinaries(result)[0]?.payeeName).toBe('BIG BANK');
  });
});

describe('payeeRaw preserves the description verbatim', () => {
  it('keeps the stutter, so a payee_rule can still match the raw text', () => {
    const result = parseVancityCsv(csv('17-Aug-2026,Preauthorized credit Tangerine Tangerine Tangerine,,10.00,555.63'));
    expect(ordinaries(result)[0]?.payeeRaw).toBe('Preauthorized credit Tangerine Tangerine Tangerine');
  });
});

describe('provider category', () => {
  it('Vancity never supplies one', () => {
    expect(suggestedCategoryName('Groceries')).toBeNull();
    expect(suggestedCategoryName(null)).toBeNull();
    const result = parseVancityCsv(csv('17-Aug-2026,Preauthorized credit Tangerine Tangerine Tangerine,,10.00,555.63'));
    expect(ordinaries(result)[0]?.providerCategory).toBeNull();
  });
});

describe('duplicate-looking rows stay distinct', () => {
  it('two identical same-day rows get different import ids', () => {
    const result = parseVancityCsv(
      csv(
        '02-Jul-2026,Preauthorized payment Tangerine Tangerine Tangerine,10.00,,651.62',
        '02-Jul-2026,Preauthorized payment Tangerine Tangerine Tangerine,10.00,,641.62',
      ),
    );
    const rows = ordinaries(result);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.importId).not.toBe(rows[1]?.importId);
  });
});

describe('the real 18-row statement', () => {
  it('imports every row, all CAD, with unique import ids', () => {
    const result = parseVancityCsv(REAL_FILE);
    expect(result.rowCount).toBe(18);
    expect(result.rows).toHaveLength(18);
    expect(result.skipped).toEqual([]);
    expect(result.currencies).toEqual(['CAD']);

    const ids = ordinaries(result).map((r) => r.importId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("nets to the change in the bank's own running Balance column", () => {
    // Independent ground truth, taken from the file itself rather than
    // from the parser: the oldest row's stated Balance (1803.74) minus
    // that row's own amount gives the opening balance (2519.74); the
    // newest row's stated Balance is the closing one (55.63). Every row
    // in between was verified to reconcile against this column before the
    // parser was written, which is what proves the Debits/Credits sign
    // convention is the right way round.
    const opening = 1803.74 - -716.0;
    const closing = 55.63;
    const parsedTotal = ordinaries(parseVancityCsv(REAL_FILE)).reduce((sum, r) => sum + r.amountMinor, 0);

    expect(opening).toBeCloseTo(2519.74, 2);
    expect(parsedTotal).toBe(Math.round((closing - opening) * 100));
    expect(parsedTotal).toBe(-246411);
  });

  it('cleans the recurring payees down to something a rule could match', () => {
    const byName = new Map<string, number>();
    for (const row of ordinaries(parseVancityCsv(REAL_FILE))) {
      byName.set(row.payeeName!, (byName.get(row.payeeName!) ?? 0) + 1);
    }
    // The three payroll deposits collapse to ONE payee name, not three
    // stuttering variants — the whole point of the collapse.
    expect(byName.get('INOVATEC')).toBe(3);
    expect(byName.get('Tangerine')).toBe(4); // 2 debits + 2 credits
    expect(byName.get('BLUESHORE FINANCIAL PAD')).toBe(2);
    expect(byName.get('IND ALL LIFE IN')).toBe(2);
  });
});
