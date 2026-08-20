import { describe, expect, it } from 'vitest';
import { parseNeoCsv, suggestedCategoryName } from '../../src/import/neo';
import type { ParsedOrdinary } from '../../src/import/types';

// The header and every data row here are transcribed verbatim from two real
// Neo Mastercard exports (July and August 2026) — same column order, same
// spacing. This file is the parser's spec; see src/import/neo.ts for the
// two format quirks it exists to handle (a Status column that includes
// Declined, and dates that are already ISO).

const HEADER = 'Transaction Date,Posted Date,Status,Description,Amount';

function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows, ''].join('\n');
}

function ordinaries(result: { rows: unknown[] }): ParsedOrdinary[] {
  return result.rows as ParsedOrdinary[];
}

// Both real files concatenated, 20 data rows total, newest-first within
// each file (August file, then July file) — used for whole-file assertions
// below.
const REAL_FILE = csv(
  '2026-08-19,,Pending,7-ELEVEN 28838         SILVER SPRING USA,-9.09',
  '2026-08-18,2026-08-19,Posted,SQ *KEN ROESEL         Bethesda      USA,-44.36',
  '2026-08-17,2026-08-17,Posted,Payment Received - Thank you,500.00',
  '2026-08-16,2026-08-17,Posted,SQ *THE BELTWAY CONNEC Alexandria    USA,-28.73',
  '2026-08-16,2026-08-17,Posted,WHOLEFDS SSP 10118     SILVER SPRING USA,-19.89',
  '2026-08-15,2026-08-16,Posted,BETHESDA ROW CINEMA 26 BETHESDA      USA,-28.55',
  '2026-08-14,2026-08-15,Posted,DANCE JAM PRODUCTIONS  DERWOOD       USA,-57.45',
  '2026-08-10,2026-08-11,Posted,HYATT REGENCY DULLES   HERNDON       USA,12.93',
  '2026-08-09,2026-08-10,Posted,HYATT REGENCY DULLES   HERNDON       USA,-13.79',
  '2026-08-07,2026-08-08,Posted,DANCE JAM PRODUCTIONS  DERWOOD       USA,-79.54',
  '2026-08-06,2026-08-10,Posted,HYATT REGENCY DULLES   HERNDON       USA,-688.49',
  '2026-08-06,2026-08-07,Posted,GOOGLE *YouTubePremium HALIFAX       CAN,-25.75',
  '2026-08-06,2026-08-06,Posted,Payment Received - Thank you,500.00',
  '2026-07-31,2026-08-01,Posted,Amazon.com             SEATTLE       USA,-15.34',
  '2026-07-30,,Declined,SHELTER BAY MARINA COL COLON         PAN,-1452.51',
  '2026-07-28,2026-07-28,Posted,Payment Received - Thank you,500.00',
  '2026-07-27,2026-07-27,Posted,Interest Charged,-124.79',
  '2026-07-06,2026-07-06,Posted,GOOGLE *YouTubePremium HALIFAX       CAN,-25.75',
  '2026-07-05,2026-07-06,Posted,NINJA SUSHI            COLESVILLE    USA,-76.59',
  '2026-07-03,2026-07-03,Posted,Payment Received - Thank you,500.00',
);

describe('dates pass through as-is — Neo already emits ISO', () => {
  it('uses Transaction Date verbatim', () => {
    const result = parseNeoCsv(csv('2026-08-18,2026-08-19,Posted,SQ *KEN ROESEL         Bethesda      USA,-44.36'));
    expect(ordinaries(result)[0]?.date).toBe('2026-08-18');
  });
});

describe('sign is already this app\'s convention — no flipping needed', () => {
  it('a charge is negative', () => {
    const result = parseNeoCsv(csv('2026-08-18,2026-08-19,Posted,SQ *KEN ROESEL         Bethesda      USA,-44.36'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(-4436);
  });

  it('a payment is positive', () => {
    const result = parseNeoCsv(csv('2026-08-17,2026-08-17,Posted,Payment Received - Thank you,500.00'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(50000);
  });

  it('a refund/credit (a negative charge reversed) is positive', () => {
    const result = parseNeoCsv(csv('2026-08-10,2026-08-11,Posted,HYATT REGENCY DULLES   HERNDON       USA,12.93'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(1293);
  });
});

describe('Status', () => {
  it('skips a Declined row — the charge never went through', () => {
    const result = parseNeoCsv(csv('2026-07-30,,Declined,SHELTER BAY MARINA COL COLON         PAN,-1452.51'));
    expect(result.rows).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('declined — the charge never went through');
  });

  it('skips a Pending row', () => {
    const result = parseNeoCsv(csv('2026-08-19,,Pending,7-ELEVEN 28838         SILVER SPRING USA,-9.09'));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('pending, not yet posted by the bank');
  });

  it('imports a Posted row unaffected by the other two statuses existing', () => {
    const result = parseNeoCsv(csv('2026-08-18,2026-08-19,Posted,SQ *KEN ROESEL         Bethesda      USA,-44.36'));
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });
});

describe("Neo's own padding/country-code vocabulary stripped into payeeName", () => {
  it('strips a trailing 3-letter country code and collapses padding', () => {
    const result = parseNeoCsv(csv('2026-08-18,2026-08-19,Posted,SQ *KEN ROESEL         Bethesda      USA,-44.36'));
    expect(ordinaries(result)[0]?.payeeName).toBe('SQ *KEN ROESEL Bethesda');
  });

  it('strips a CAN country code the same way', () => {
    const result = parseNeoCsv(csv('2026-08-06,2026-08-07,Posted,GOOGLE *YouTubePremium HALIFAX       CAN,-25.75'));
    expect(ordinaries(result)[0]?.payeeName).toBe('GOOGLE *YouTubePremium HALIFAX');
  });

  it('leaves "Payment Received - Thank you" untouched — no padded country code to strip', () => {
    const result = parseNeoCsv(csv('2026-08-17,2026-08-17,Posted,Payment Received - Thank you,500.00'));
    expect(ordinaries(result)[0]?.payeeName).toBe('Payment Received - Thank you');
  });

  it('leaves "Interest Charged" untouched', () => {
    const result = parseNeoCsv(csv('2026-07-27,2026-07-27,Posted,Interest Charged,-124.79'));
    expect(ordinaries(result)[0]?.payeeName).toBe('Interest Charged');
  });
});

describe('payeeRaw preserves the full original description', () => {
  it('stores the description verbatim, padding and all', () => {
    const result = parseNeoCsv(csv('2026-08-18,2026-08-19,Posted,SQ *KEN ROESEL         Bethesda      USA,-44.36'));
    expect(ordinaries(result)[0]?.payeeRaw).toBe('SQ *KEN ROESEL         Bethesda      USA');
  });
});

describe('provider category', () => {
  it('Neo never supplies one', () => {
    expect(suggestedCategoryName('Dining')).toBeNull();
    expect(suggestedCategoryName(null)).toBeNull();
    const result = parseNeoCsv(csv('2026-08-18,2026-08-19,Posted,SQ *KEN ROESEL         Bethesda      USA,-44.36'));
    expect(ordinaries(result)[0]?.providerCategory).toBeNull();
  });
});

describe('duplicate-looking rows are separate transactions', () => {
  it('the three real HYATT REGENCY DULLES charges get distinct import ids', () => {
    const result = parseNeoCsv(
      csv(
        '2026-08-10,2026-08-11,Posted,HYATT REGENCY DULLES   HERNDON       USA,12.93',
        '2026-08-09,2026-08-10,Posted,HYATT REGENCY DULLES   HERNDON       USA,-13.79',
        '2026-08-06,2026-08-10,Posted,HYATT REGENCY DULLES   HERNDON       USA,-688.49',
      ),
    );
    const ids = ordinaries(result).map((r) => r.importId);
    expect(new Set(ids).size).toBe(3);
  });

  it('same-content rows get distinct import ids via the occurrence counter', () => {
    const result = parseNeoCsv(
      csv(
        '2026-07-06,2026-07-06,Posted,GOOGLE *YouTubePremium HALIFAX       CAN,-25.75',
        '2026-07-06,2026-07-06,Posted,GOOGLE *YouTubePremium HALIFAX       CAN,-25.75',
      ),
    );
    const rows = ordinaries(result);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.importId).not.toBe(rows[1]?.importId);
  });
});

describe('the real 20-row file (two real statements)', () => {
  it('imports every Posted row, skips Pending and Declined, currency CAD', () => {
    const result = parseNeoCsv(REAL_FILE);
    expect(result.rowCount).toBe(20);
    expect(result.rows).toHaveLength(18);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map((s) => s.reason).sort()).toEqual(
      ['declined — the charge never went through', 'pending, not yet posted by the bank'].sort(),
    );
    expect(result.currencies).toEqual(['CAD']);
  });

  it('every import id is unique, including the three repeated HYATT rows', () => {
    const ids = ordinaries(parseNeoCsv(REAL_FILE)).map((r) => r.importId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('nets to the same total as summing the raw Amount column by hand, excluding Declined and Pending', () => {
    // Independent ground truth: every Posted row's Amount from the two
    // real files, summed directly — the Declined marina charge and the
    // Pending 7-Eleven charge deliberately excluded, since neither is real
    // spending. Not derived from the parser at all.
    const rawTotal =
      -44.36 + 500.0 - 28.73 - 19.89 - 28.55 - 57.45 + 12.93 - 13.79 - 79.54 - 688.49 - 25.75 + 500.0 - 15.34 +
      500.0 - 124.79 - 25.75 - 76.59 + 500.0;
    const parsedTotal = ordinaries(parseNeoCsv(REAL_FILE)).reduce((sum, r) => sum + r.amountMinor, 0);
    expect(parsedTotal).toBe(Math.round(rawTotal * 100));
    expect(parsedTotal).toBe(78391);
  });
});
