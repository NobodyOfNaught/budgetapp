import { describe, expect, it } from 'vitest';
import { parseStatement } from '../../src/import';
import { parseBecuExportCsv } from '../../src/import/becu-export';

// Rows transcribed verbatim from the owner's real BECU export (11 Nov 2026),
// per the house convention for golden tests.
const HEADER = 'Date,Description,Original Description,Amount,Type,Parent Category,Category,Account,Tags,Memo,Pending';
const PENDING_UBER =
  '11/11/26,Uber Pending Transaction,PENDING - XXXXXXXXXXX0214 UBER * PENDING         XXXXXX8996   CAUS,12.52,Debit,Travel,Rental Car & Taxi,0058 * personal checking,,XXXXXXXXXXX0214 UBER * PENDING         XXXXXX8996   CAUS,true';
const POS_LYFT =
  '11/7/26,Lyft,POS Withdrawal - LYFT   *1 RIDE 11-05 548 Market St. Ste 6851SAN FRANCISCOCAU - Card Ending In 5957,15.99,Debit,Travel,Rental Car & Taxi,0058 * personal checking,,LYFT   *1 RIDE 11-05 548 Market St. Ste 6851SAN FRANCISCOCAU,false';
const INTEREST = '11/7/26,Interest Income,Dividend/Interest,1.53,Credit,Income,Interest Income,0058 * personal checking,,,false';
const PAYROLL =
  '10/30/26,American Airlines,External Deposit - AMERICANAIRLINES DIRECT DEPOSIT - PAYROLL,597.42,Credit,Income,Paycheck,0058 * personal checking,,AMERICANAIRLINES DIRECT DEPOSIT - PAYROLL ,false';
const ZELLE_A =
  '8/2/26,Zelle Transfer,Transfer Withdrawal -  Zelle LEMERY ROLLINS (800)233-2328,70.8,Debit,Transfer,Transfer,0058 * personal checking,, Zelle LEMERY ROLLINS (800)233-2328 ,false';
const TAX_REFUND =
  '9/23/26,Federal Tax Refund,External Deposit - IRS  TREAS 310  -   TAX REF  REF*SAND*OGDEN *12/2025*TAX REFUND*30\\,610,Credit,Taxes,Taxes,0058 * personal checking,,IRS  TREAS 310  -   TAX REF  REF*SAND*OGDEN *12/2025*TAX REFUND*30\\,false';
const UNCATEGORIZED =
  '10/30/26,Metro Glenmont Georgia Ave Silver Spring,POS Withdrawal - METRO 034-GLENMONT 12501 GEORGIA AVE      SILVER SPRINGMDUS - Card Ending In 5957,10,Debit,Uncategorized,Uncategorized,0058 * personal checking,,METRO 034-GLENMONT 12501 GEORGIA AVE      SILVER SPRINGMDUS,false';

const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('parseBecuExportCsv', () => {
  it('is registered as its own provider, separate from the old BECU download', () => {
    const viaRegistry = parseStatement('becu_export', csv(POS_LYFT));
    expect(viaRegistry.rows).toHaveLength(1);
    // The OLD parser cannot read this layout at all — the reason this exists.
    expect(parseStatement('becu', csv(POS_LYFT)).rows).toHaveLength(0);
  });

  it('takes the sign from Type, since Amount is always printed unsigned', () => {
    const r = parseBecuExportCsv(csv(POS_LYFT, INTEREST));
    expect(r.rows.map((x) => (x.kind === 'ordinary' ? x.amountMinor : null))).toEqual([-1599, 153]);
  });

  it('dates a two-digit year as 20xx and zero-pads', () => {
    const r = parseBecuExportCsv(csv(POS_LYFT));
    expect(r.rows[0]).toMatchObject({ date: '2026-11-07' });
  });

  it('NEVER reads BECU\'s categories — not "Travel", not "Paycheck", not even "Uncategorized"', () => {
    // The owner does not trust them. Every row must arrive with no
    // category at all, whatever the file says.
    const r = parseBecuExportCsv(csv(POS_LYFT, PAYROLL, UNCATEGORIZED, INTEREST));
    for (const row of r.rows) expect(row.kind === 'ordinary' && row.providerCategory).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/Rental Car|Paycheck|Travel|Interest Income/);
  });

  it('skips pending rows and says so, rather than importing a hold that later reposts', () => {
    const r = parseBecuExportCsv(csv(PENDING_UBER, POS_LYFT));
    expect(r.rows).toHaveLength(1);
    expect(r.skipped).toEqual([
      {
        reference: 'PENDING - XXXXXXXXXXX0214 UBER * PENDING         XXXXXX8996   CAUS',
        reason: 'pending — will import once it posts',
      },
    ]);
  });

  it('keeps the bank\'s own text in payeeRaw (what payee rules match) and strips only its vocabulary for payeeName', () => {
    const [row] = parseBecuExportCsv(csv(POS_LYFT)).rows;
    expect(row).toMatchObject({
      payeeRaw: 'POS Withdrawal - LYFT   *1 RIDE 11-05 548 Market St. Ste 6851SAN FRANCISCOCAU - Card Ending In 5957',
      payeeName: 'LYFT   *1 RIDE 11-05 548 Market St. Ste 6851SAN FRANCISCOCAU',
    });
  });

  it('gives two genuinely identical rows distinct ids, so the second is not dropped as a duplicate', () => {
    // The real file has two $70.80 Zelle payments on 8/2.
    const r = parseBecuExportCsv(csv(ZELLE_A, ZELLE_A));
    const ids = r.rows.map((x) => x.importId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toMatch(/\|0$/);
    expect(ids[1]).toMatch(/\|1$/);
  });

  it('reads a description that ends in a backslash before the comma (the real IRS refund row)', () => {
    const r = parseBecuExportCsv(csv(TAX_REFUND));
    expect(r.skipped).toEqual([]);
    expect(r.rows[0]).toMatchObject({ amountMinor: 61000, date: '2026-09-23' });
  });

  it('refuses a file that mixes accounts rather than guessing which rows belong', () => {
    const other = INTEREST.replace('0058 * personal checking', '1234 * savings');
    expect(() => parseBecuExportCsv(csv(POS_LYFT, other))).toThrow(/mixes 2 accounts/);
  });

  it('reads a mixed sample: every non-pending row imports, only the pending one is skipped', () => {
    const r = parseBecuExportCsv(csv(PENDING_UBER, POS_LYFT, INTEREST, PAYROLL, ZELLE_A, ZELLE_A, TAX_REFUND, UNCATEGORIZED));
    expect(r.rowCount).toBe(8);
    expect(r.rows).toHaveLength(7);
    expect(r.skipped).toHaveLength(1);
    expect(r.currencies).toEqual(['USD']);
  });
});
