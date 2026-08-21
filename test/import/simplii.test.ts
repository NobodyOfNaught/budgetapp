import { describe, expect, it } from 'vitest';
import { parseSimpliiCsv, suggestedCategoryName } from '../../src/import/simplii';
import type { ParsedOrdinary } from '../../src/import/types';

// Header and every data row transcribed verbatim from a real Simplii
// chequing export (Mar–Aug 2026, CAD). This file is the parser's spec;
// see src/import/simplii.ts for the three things worth knowing about the
// format. Note the header's space padding is REAL and reproduced exactly —
// it is one of the things under test.

const HEADER = 'Date, Transaction Details, Funds Out, Funds In ';

function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows, ''].join('\n');
}

function ordinaries(result: { rows: unknown[] }): ParsedOrdinary[] {
  return result.rows as ParsedOrdinary[];
}

// All 20 real rows, oldest-first exactly as the bank emits them.
const REAL_FILE = csv(
  '03/17/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,1000.00,',
  '03/31/2026,PAYROLL DEPOSIT INOVATEC,,500.00',
  '04/01/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,500.00,',
  '04/15/2026,PAYROLL DEPOSIT INOVATEC,,500.00',
  '04/17/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,500.00,',
  '04/30/2026,PAYROLL DEPOSIT INOVATEC,,500.00',
  '05/01/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,500.00,',
  '05/15/2026,PAYROLL DEPOSIT INOVATEC,,500.00',
  '05/19/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,500.00,',
  '05/29/2026,PAYROLL DEPOSIT INOVATEC,,500.00',
  '06/15/2026,PAYROLL DEPOSIT INOVATEC,,500.00',
  '06/15/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,1000.00,',
  '06/30/2026,PAYROLL DEPOSIT INOVATEC,,500.00',
  '07/02/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,500.00,',
  '07/15/2026,PAYROLL DEPOSIT INOVATEC,,500.00',
  '07/27/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,500.00,',
  '07/31/2026,PAYROLL DEPOSIT INOVATEC,,500.00',
  '08/05/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,500.00,',
  '08/14/2026,PAYROLL DEPOSIT INOVATEC,,500.00',
  '08/14/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,500.00,',
);

describe('the space-padded header', () => {
  it('reads columns despite the leading and trailing spaces the bank emits', () => {
    // The literal header is `Date, Transaction Details, Funds Out, Funds In `.
    // parseCsvRecords trims header names, so this works — pinned because
    // reading columns positionally instead would yield undefined for every
    // lookup and skip the whole file.
    const result = parseSimpliiCsv(csv('03/31/2026,PAYROLL DEPOSIT INOVATEC,,500.00'));
    expect(result.skipped).toEqual([]);
    expect(ordinaries(result)[0]?.amountMinor).toBe(50000);
  });
});

describe('MM/DD/YYYY, not DD/MM/YYYY — despite being a Canadian bank', () => {
  it('reads a day greater than 12 as the day', () => {
    // 03/17 is unambiguous: 17 cannot be a month. This is the evidence
    // the whole date reading rests on.
    const result = parseSimpliiCsv(csv('03/17/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,1000.00,'));
    expect(ordinaries(result)[0]?.date).toBe('2026-03-17');
  });

  it('reads an ambiguous date the same way round', () => {
    // 04/01 would be 1 April read the Canadian way. It is 4 January
    // nowhere in this file — the whole file is one convention, fixed by
    // the unambiguous rows above.
    const result = parseSimpliiCsv(csv('04/01/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,500.00,'));
    expect(ordinaries(result)[0]?.date).toBe('2026-04-01');
  });

  it('skips an unparseable date rather than guessing', () => {
    const result = parseSimpliiCsv(csv('2026-03-17,PAYROLL DEPOSIT INOVATEC,,500.00'));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('unrecognized date');
  });
});

describe('Funds Out / Funds In decide the sign', () => {
  it('Funds Out is an outflow', () => {
    const result = parseSimpliiCsv(csv('03/17/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,1000.00,'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(-100000);
  });

  it('Funds In is an inflow', () => {
    const result = parseSimpliiCsv(csv('03/31/2026,PAYROLL DEPOSIT INOVATEC,,500.00'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(50000);
  });

  it('an amount already printed negative in Funds Out is still an outflow', () => {
    const result = parseSimpliiCsv(csv('03/17/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,-1000.00,'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(-100000);
  });

  it('skips a row with neither column readable', () => {
    const result = parseSimpliiCsv(csv('03/17/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,,'));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('neither Funds Out nor Funds In had a readable amount');
  });
});

describe("Simplii's own vocabulary stripped from payeeName", () => {
  it('strips the bill-payment prefix', () => {
    const result = parseSimpliiCsv(csv('03/17/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,1000.00,'));
    expect(ordinaries(result)[0]?.payeeName).toBe('MASTERCARD NEO FINANCIAL');
  });

  it('strips the payroll prefix', () => {
    const result = parseSimpliiCsv(csv('03/31/2026,PAYROLL DEPOSIT INOVATEC,,500.00'));
    expect(ordinaries(result)[0]?.payeeName).toBe('INOVATEC');
  });

  it('leaves an unrecognized prefix alone for the route-layer heuristic to handle', () => {
    const result = parseSimpliiCsv(csv('03/31/2026,SOME NEW TYPE ACME CORP,,500.00'));
    expect(ordinaries(result)[0]?.payeeName).toBe('SOME NEW TYPE ACME CORP');
  });

  it('keeps payeeRaw verbatim so a payee_rule can match the full text', () => {
    const result = parseSimpliiCsv(csv('03/17/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,1000.00,'));
    expect(ordinaries(result)[0]?.payeeRaw).toBe('INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL');
  });
});

describe('provider category', () => {
  it('Simplii never supplies one', () => {
    expect(suggestedCategoryName('Groceries')).toBeNull();
    expect(suggestedCategoryName(null)).toBeNull();
    const result = parseSimpliiCsv(csv('03/31/2026,PAYROLL DEPOSIT INOVATEC,,500.00'));
    expect(ordinaries(result)[0]?.providerCategory).toBeNull();
  });
});

describe('duplicate-looking rows stay distinct', () => {
  it('two identical same-day deposits get different import ids', () => {
    // The real file contains no such pair, but two $500 payroll deposits
    // on one date is entirely ordinary — and without the counter the
    // second would be silently dropped as a duplicate.
    const result = parseSimpliiCsv(
      csv('03/31/2026,PAYROLL DEPOSIT INOVATEC,,500.00', '03/31/2026,PAYROLL DEPOSIT INOVATEC,,500.00'),
    );
    const rows = ordinaries(result);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.importId).not.toBe(rows[1]?.importId);
  });

  it('the two real 06/15 rows are distinct without needing the counter', () => {
    const result = parseSimpliiCsv(
      csv('06/15/2026,PAYROLL DEPOSIT INOVATEC,,500.00', '06/15/2026,INTERNET BILL PAYMENT MASTERCARD NEO FINANCIAL,1000.00,'),
    );
    const ids = ordinaries(result).map((r) => r.importId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('the real 20-row statement', () => {
  it('imports every row, all CAD, with unique import ids', () => {
    const result = parseSimpliiCsv(REAL_FILE);
    expect(result.rowCount).toBe(20);
    expect(result.rows).toHaveLength(20);
    expect(result.skipped).toEqual([]);
    expect(result.currencies).toEqual(['CAD']);

    const ids = ordinaries(result).map((r) => r.importId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('nets to the hand-summed Funds Out / Funds In totals', () => {
    // Independent ground truth: this export has no running Balance column
    // to reconcile against (unlike AACU's and Vancity's chequing files),
    // so the two columns were summed straight from the raw file before
    // the parser was written — 6000.00 out across 10 rows, 5000.00 in
    // across 10, net -1000.00.
    const rows = ordinaries(parseSimpliiCsv(REAL_FILE));
    const out = rows.filter((r) => r.amountMinor < 0);
    const inn = rows.filter((r) => r.amountMinor > 0);

    expect(out).toHaveLength(10);
    expect(inn).toHaveLength(10);
    expect(out.reduce((s, r) => s + r.amountMinor, 0)).toBe(-600000);
    expect(inn.reduce((s, r) => s + r.amountMinor, 0)).toBe(500000);
    expect(rows.reduce((s, r) => s + r.amountMinor, 0)).toBe(-100000);
  });

  it('collapses to exactly two payees — one employer, one credit card', () => {
    const byName = new Map<string, number>();
    for (const row of ordinaries(parseSimpliiCsv(REAL_FILE))) {
      byName.set(row.payeeName!, (byName.get(row.payeeName!) ?? 0) + 1);
    }
    expect([...byName.entries()].sort()).toEqual([
      ['INOVATEC', 10],
      ['MASTERCARD NEO FINANCIAL', 10],
    ]);
  });
});
