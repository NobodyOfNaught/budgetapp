import { describe, expect, it } from 'vitest';
import { parseBecuCsv, suggestedCategoryName } from '../../src/import/becu';
import type { ParsedOrdinary } from '../../src/import/types';

// The header and every data row here are transcribed verbatim from a real
// BECU export — same column order, same quoting. This file is the parser's
// spec; see src/import/becu.ts for the three format quirks it exists to
// handle (no transaction id, an unreliable printed sign, and a single
// free-text description column).

const HEADER = '"Date","No.","Description","Debit","Credit"';

function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows, ''].join('\n');
}

function ordinaries(result: { rows: unknown[] }): ParsedOrdinary[] {
  return result.rows as ParsedOrdinary[];
}

// The full real file, 23 data rows, used for whole-file assertions below.
const REAL_FILE = csv(
  '"8/18/2026","","External Withdrawal - CHASE CREDIT CRD  - AUTOPAY","-154",""',
  '"8/17/2026","","External Deposit - AMERICANAIRLINES DIRECT DEPOSIT - PAYROLL","","1071.48"',
  '"8/14/2026","","POS Withdrawal - 160000101207 GIANT FOOD INC #152 13 COLESVILLE   MDUS - Card Ending In 1658","-109.21",""',
  '"8/14/2026","","External Deposit - WEB - KRISTINE SANDT 86711325310921 - TINE SANDT  KRISTINE SANDT From Kristine Sandt Via WISE","","140.73"',
  '"8/13/2026","","POS Withdrawal - UBER *TRIP HELP.UBER.C 1455 Market Street     8005928996   C - Card Ending In 1658","-14.40",""',
  '"8/10/2026","","Transfer Withdrawal -  Zelle KATHERINE ATWILL (800)233-2328","-175",""',
  '"8/10/2026","","POS Withdrawal - PSYCHOLOGY TODAY 927 E 8th Street Ste 11SIOUX FALLS  SDUS - Card Ending In 1658","-29.95",""',
  '"8/7/2026","","Dividend/Interest","","0.52"',
  '"8/7/2026","","External Withdrawal - VENMO  - PAYMENT","-30",""',
  '"8/7/2026","","POS Withdrawal - GOOGLE *FI G5BXZN 1600 AMPHITHEATRE PKWY MOUNTAIN VIEWCAUS - Card Ending In 1658","-191.83",""',
  '"8/6/2026","","POS Withdrawal - 043054510 TRADER JOE S #652      SILVER SPRINGMDUS - Card Ending In 1658","-26.87",""',
  '"8/2/2026","","Transfer Withdrawal -  Zelle LEMERY ROLLINS (800)233-2328","-70.80",""',
  '"8/2/2026","","Transfer Withdrawal -  Zelle LEMERY ROLLINS (800)233-2328","-70.80",""',
  '"7/30/2026","","External Deposit - AMERICANAIRLINES DIRECT DEPOSIT - PAYROLL","","675.27"',
  '"7/20/2026","","NSF - CHASE CREDIT CRD  - AUTOPAY","-10",""',
  '"7/20/2026","","External Withdrawal - CHASE CREDIT CRD  - AUTOPAY","-156",""',
  '"7/18/2026","","Transfer Deposit -  Zelle MOLDOVER - (800)233-2328","","40"',
  '"7/10/2026","","POS Withdrawal - PSYCHOLOGY TODAY 927 E 8th Street Ste 11SIOUX FALLS  SDUS - Card Ending In 1658","-29.95",""',
  '"7/8/2026","","POS Withdrawal - GOOGLE *FI 53874P 1600 AMPHITHEATRE PKWY MOUNTAIN VIEWCAUS - Card Ending In 1658","-191.47",""',
  '"7/5/2026","","POS Withdrawal - 0012356996112  AMERICAN 4000 E SKY HARBOR BL   United States - Card Ending In 1658","-127.52",""',
  '"7/4/2026","","Transfer Deposit -  Zelle Terry Sandt (800)233-2328","","127"',
  '"7/3/2026","","Dividend/Interest","","0.63"',
  '"7/1/2026","","Transfer Withdrawal -  Zelle KATHERINE ATWILL (800)233-2328","-600",""',
);

describe('date conversion', () => {
  it('converts M/D/YYYY to YYYY-MM-DD, including single-digit month and day', () => {
    const result = parseBecuCsv(csv('"7/1/2026","","Dividend/Interest","","0.63"'));
    expect(ordinaries(result)[0]?.date).toBe('2026-07-01');
  });
});

describe('sign comes from which column is populated, not the printed character', () => {
  it('a Debit value is always imported negative', () => {
    const result = parseBecuCsv(csv('"8/18/2026","","External Withdrawal - CHASE CREDIT CRD  - AUTOPAY","-154",""'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(-15400);
  });

  it('a Credit value is always imported positive', () => {
    const result = parseBecuCsv(csv('"8/17/2026","","External Deposit - AMERICANAIRLINES DIRECT DEPOSIT - PAYROLL","","1071.48"'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(107148);
  });

  it('still imports correctly even if a Debit value were printed without a leading minus', () => {
    const result = parseBecuCsv(csv('"8/18/2026","","External Withdrawal - CHASE CREDIT CRD  - AUTOPAY","154",""'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(-15400);
  });

  it('strips thousands separators before parsing', () => {
    const result = parseBecuCsv(csv('"8/17/2026","","External Deposit - PAYROLL","","1,071.48"'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(107148);
  });
});

describe('rows with no transaction-type prefix', () => {
  it('imports Dividend/Interest as plain income, description untouched', () => {
    const result = parseBecuCsv(csv('"8/7/2026","","Dividend/Interest","","0.52"'));
    const [row] = ordinaries(result);
    expect(row?.amountMinor).toBe(52);
    expect(row?.payeeRaw).toBe('Dividend/Interest');
    expect(row?.payeeName).toBe('Dividend/Interest');
  });

  it('imports an NSF fee as a plain outflow', () => {
    const result = parseBecuCsv(csv('"7/20/2026","","NSF - CHASE CREDIT CRD  - AUTOPAY","-10",""'));
    const [row] = ordinaries(result);
    expect(row?.amountMinor).toBe(-1000);
    expect(row?.payeeName).toBe('CHASE CREDIT CRD  - AUTOPAY');
  });
});

describe("BECU's own vocabulary stripped into payeeName — generic cleanup happens later, at the route layer", () => {
  it('strips the leading type prefix', () => {
    const result = parseBecuCsv(csv('"8/18/2026","","External Withdrawal - CHASE CREDIT CRD  - AUTOPAY","-154",""'));
    expect(ordinaries(result)[0]?.payeeName).toBe('CHASE CREDIT CRD  - AUTOPAY');
  });

  it('strips a trailing "Card Ending In" suffix', () => {
    const result = parseBecuCsv(
      csv('"8/13/2026","","POS Withdrawal - UBER *TRIP HELP.UBER.C 1455 Market Street     8005928996   C - Card Ending In 1658","-14.40",""'),
    );
    expect(ordinaries(result)[0]?.payeeName).toBe('UBER *TRIP HELP.UBER.C 1455 Market Street     8005928996   C');
  });

  it('leaves the rest of the description untouched — that is cleanPayeeName / payee_rules work, not this parser\'s', () => {
    const result = parseBecuCsv(
      csv('"8/14/2026","","POS Withdrawal - 160000101207 GIANT FOOD INC #152 13 COLESVILLE   MDUS - Card Ending In 1658","-109.21",""'),
    );
    expect(ordinaries(result)[0]?.payeeName).toBe('160000101207 GIANT FOOD INC #152 13 COLESVILLE   MDUS');
  });
});

describe('payeeRaw preserves the full original description', () => {
  it('stores the description verbatim, prefix and all', () => {
    const result = parseBecuCsv(
      csv('"8/14/2026","","POS Withdrawal - 160000101207 GIANT FOOD INC #152 13 COLESVILLE   MDUS - Card Ending In 1658","-109.21",""'),
    );
    expect(ordinaries(result)[0]?.payeeRaw).toBe(
      'POS Withdrawal - 160000101207 GIANT FOOD INC #152 13 COLESVILLE   MDUS - Card Ending In 1658',
    );
  });
});

describe('the check-number column becomes memo', () => {
  it('is null when blank', () => {
    const result = parseBecuCsv(csv('"8/7/2026","","Dividend/Interest","","0.52"'));
    expect(ordinaries(result)[0]?.memo).toBeNull();
  });

  it('is recorded when present', () => {
    const result = parseBecuCsv(csv('"8/7/2026","1042","Dividend/Interest","","0.52"'));
    expect(ordinaries(result)[0]?.memo).toBe('Check 1042');
  });
});

describe('duplicate-looking rows are two real transactions, not one', () => {
  it('imports both identical $70.80 Zelle payments as separate rows with distinct import ids', () => {
    const result = parseBecuCsv(
      csv(
        '"8/2/2026","","Transfer Withdrawal -  Zelle LEMERY ROLLINS (800)233-2328","-70.80",""',
        '"8/2/2026","","Transfer Withdrawal -  Zelle LEMERY ROLLINS (800)233-2328","-70.80",""',
      ),
    );
    const rows = ordinaries(result);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.importId).not.toBe(rows[1]?.importId);
    expect(new Set(rows.map((r) => r.importId)).size).toBe(2);
    expect(rows.every((r) => r.amountMinor === -7080)).toBe(true);
  });
});

describe('provider category', () => {
  it('BECU never supplies one', () => {
    expect(suggestedCategoryName('Groceries')).toBeNull();
    expect(suggestedCategoryName(null)).toBeNull();
    const result = parseBecuCsv(csv('"8/7/2026","","Dividend/Interest","","0.52"'));
    expect(ordinaries(result)[0]?.providerCategory).toBeNull();
  });
});

describe('the real 23-row file', () => {
  it('imports every row as ordinary, none skipped, correct currency', () => {
    const result = parseBecuCsv(REAL_FILE);
    expect(result.rowCount).toBe(23);
    expect(result.rows).toHaveLength(23);
    expect(result.skipped).toEqual([]);
    expect(result.currencies).toEqual(['USD']);
  });

  it('every import id is unique, including the two identical Zelle rows', () => {
    const result = parseBecuCsv(REAL_FILE);
    const ids = ordinaries(result).map((r) => r.importId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('nets to the same total as summing the raw Debit/Credit columns by hand', () => {
    // Independent ground truth: every debit and credit value from the file
    // above, summed directly — not derived from the parser at all.
    const rawTotal =
      -154 + 1071.48 - 109.21 + 140.73 - 14.4 - 175 - 29.95 + 0.52 - 30 - 191.83 - 26.87 - 70.8 - 70.8 + 675.27 -
      10 - 156 + 40 - 29.95 - 191.47 - 127.52 + 127 + 0.63 - 600;
    const parsedTotal = ordinaries(parseBecuCsv(REAL_FILE)).reduce((sum, r) => sum + r.amountMinor, 0);
    expect(parsedTotal).toBe(Math.round(rawTotal * 100));
  });
});
