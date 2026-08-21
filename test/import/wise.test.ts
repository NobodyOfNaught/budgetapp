import { describe, expect, it } from 'vitest';
import { parseWiseCsv, suggestedCategoryName } from '../../src/import/wise';
import type { ParsedOrdinary, ParsedTransfer } from '../../src/import/types';

// Every fixture below is transcribed verbatim from a real Wise export —
// same column order, same quoting, same variable decimal places ("5.0" vs
// "15.70"). This file is the parser's spec; see src/import/wise.ts for the
// three format quirks it exists to handle.

const HEADER =
  'ID,Status,Direction,"Created on","Finished on","Source fee amount","Source fee currency",' +
  '"Target fee amount","Target fee currency","Source name","Source amount (after fees)","Source currency",' +
  '"Target name","Target amount (after fees)","Target currency","Exchange rate",Reference,Batch,' +
  '"Created by",Category,Note';

function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows, ''].join('\n');
}

function ordinaries(result: { rows: unknown[] }): ParsedOrdinary[] {
  return (result.rows as ParsedOrdinary[]).filter((r) => r.kind === 'ordinary');
}
function transfers(result: { rows: unknown[] }): ParsedTransfer[] {
  return (result.rows as ParsedTransfer[]).filter((r) => r.kind === 'transfer');
}

// A plain single-currency card purchase — the overwhelming majority of rows.
const GIANT_FOOD =
  '"CARD_TRANSACTION-4113574733",COMPLETED,OUT,"2026-07-27 15:09:01","2026-07-27 15:09:01",0.00,USD,,,' +
  '"Palle Helenius",149.18,USD,"Giant Food",149.18,USD,1.0000000000000000,,,"Palle Helenius",Groceries,';

// The two legs of ONE $34.50 purchase, funded from both a CAD and a USD balance.
const SPLIT_LEG_CAD =
  '"CARD_TRANSACTION-4145111585",COMPLETED,OUT,"2026-08-03 17:11:26","2026-08-03 17:11:26",0.07,CAD,,,' +
  '"Palle Helenius",15.70,CAD,"Taste of Europe Enterp",11.18,USD,0.7118960000000000,,,"Palle Helenius",Groceries,';
const SPLIT_LEG_USD =
  '"CARD_TRANSACTION-4145111585",COMPLETED,OUT,"2026-08-03 17:11:26","2026-08-03 17:11:26",0.00,USD,,,' +
  '"Palle Helenius",23.32,USD,"Taste of Europe Enterp",23.32,USD,1.0000000000000000,,,"Palle Helenius",Groceries,';

describe('single-currency card purchase', () => {
  it('imports as one outflow for the full amount, payee taken from the target side', () => {
    const result = parseWiseCsv(csv(GIANT_FOOD));
    expect(result.skipped).toEqual([]);
    expect(result.rows).toHaveLength(1);

    const [purchase] = ordinaries(result);
    expect(purchase).toEqual({
      kind: 'ordinary',
      importId: 'CARD_TRANSACTION-4113574733',
      date: '2026-07-27',
      amountMinor: -14918,
      currencyCode: 'USD',
      payeeRaw: 'Giant Food',
      payeeName: 'Giant Food',
      memo: null,
      providerCategory: 'Groceries',
    });
  });
});

describe('split-currency purchase (two rows sharing one id)', () => {
  it('produces the FULL purchase amount plus a transfer covering the foreign-funded part', () => {
    const result = parseWiseCsv(csv(SPLIT_LEG_CAD, SPLIT_LEG_USD));
    expect(result.skipped).toEqual([]);

    // The purchase is the real $34.50 the merchant charged (11.18 + 23.32),
    // NOT either leg on its own.
    const purchases = ordinaries(result);
    expect(purchases).toHaveLength(1);
    expect(purchases[0]?.amountMinor).toBe(-3450);
    expect(purchases[0]?.currencyCode).toBe('USD');
    expect(purchases[0]?.payeeRaw).toBe('Taste of Europe Enterp');

    // The CAD-funded portion becomes an explicit conversion. The CAD side
    // includes the 0.07 fee Wise charged on top of the 15.70.
    const conversions = transfers(result);
    expect(conversions).toHaveLength(1);
    expect(conversions[0]?.fromAmountMinor).toBe(-1577);
    expect(conversions[0]?.fromCurrencyCode).toBe('CAD');
    expect(conversions[0]?.toAmountMinor).toBe(1118);
    expect(conversions[0]?.toCurrencyCode).toBe('USD');
  });

  it('nets the USD balance to exactly what actually left it', () => {
    // This is the whole point of the model: the purchase overstates what
    // left USD, and the incoming conversion makes up the difference, so the
    // account still reconciles against Wise to the cent.
    const result = parseWiseCsv(csv(SPLIT_LEG_CAD, SPLIT_LEG_USD));
    const usdNet =
      ordinaries(result).reduce((sum, r) => sum + r.amountMinor, 0) +
      transfers(result).reduce((sum, r) => sum + (r.toCurrencyCode === 'USD' ? r.toAmountMinor : 0), 0);
    expect(usdNet).toBe(-2332); // exactly the 23.32 USD leg
  });

  it('gives the purchase and the conversion distinct dedupe keys', () => {
    // Both derive from the same Wise ID; if they collided, the partial
    // unique index on (account_id, import_id) would drop one of them.
    const result = parseWiseCsv(csv(SPLIT_LEG_CAD, SPLIT_LEG_USD));
    const ids = result.rows.map((r) => r.importId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('handles a three-figure split the same way — 83.91 + 115.09 = 199.00 exactly', () => {
    const legCad =
      '"CARD_TRANSACTION-4119778634",COMPLETED,OUT,"2026-07-29 02:17:22","2026-07-29 02:17:22",0.54,CAD,,,' +
      '"Palle Helenius",118.29,CAD,"Dance Jam Productions",83.91,USD,0.7093460000000000,,,"Palle Helenius",Entertainment,';
    const legUsd =
      '"CARD_TRANSACTION-4119778634",COMPLETED,OUT,"2026-07-29 02:17:22","2026-07-29 02:17:22",0.00,USD,,,' +
      '"Palle Helenius",115.09,USD,"Dance Jam Productions",115.09,USD,1.0000000000000000,,,"Palle Helenius",Entertainment,';

    const result = parseWiseCsv(csv(legCad, legUsd));
    expect(ordinaries(result)[0]?.amountMinor).toBe(-19900);
    expect(transfers(result)[0]?.fromAmountMinor).toBe(-11883); // 118.29 + 0.54 fee
    expect(transfers(result)[0]?.toAmountMinor).toBe(8391);
  });
});

describe('own-account conversion', () => {
  it('is a transfer, not income — an OUTbound move between the user’s own balances', () => {
    // Source and target are both the user AND the direction is OUT: money
    // already inside Wise changing currency.
    const conversionRow =
      'TRANSFER-9000000001,COMPLETED,OUT,"2026-07-01 14:40:43","2026-07-02 10:05:43",5.76,CAD,,,' +
      '"Palle Helenius",1136.36,CAD,"Palle Helenius",800.0,USD,0.704002,,,"Palle Helenius","Converted",';

    const result = parseWiseCsv(csv(conversionRow));
    expect(ordinaries(result)).toHaveLength(0);

    const [conversion] = transfers(result);
    expect(conversion?.fromAmountMinor).toBe(-114212); // 1136.36 + 5.76 fee
    expect(conversion?.fromCurrencyCode).toBe('CAD');
    expect(conversion?.toAmountMinor).toBe(80000);
    expect(conversion?.toCurrencyCode).toBe('USD');
    // Settled on the 2nd, not created on the 1st — the balance moved when it finished.
    expect(conversion?.date).toBe('2026-07-02');
  });

  it('does NOT swallow an inbound top-up that merely has the user’s name on both sides', () => {
    // NOTE: this case originally lived in the test above, asserting that
    // the identical row WAS a conversion — the fixture even carried Wise's
    // own "Money added" label. That expectation was wrong, and wrong in a
    // way nothing surfaced: funding your Wise account from an external
    // bank is direction IN with your name on both sides, because you are
    // indeed sending money to yourself. Treated as an internal
    // conversion it became a DEBIT against a balance that had never
    // received the money.
    //
    // Repeated across a statement it drives the source-currency account
    // arbitrarily negative — every conversion out, no funding in. A real
    // Wise CAD account reached -6,663.28 CAD this way, against a balance
    // that never went below zero.
    const topUp =
      'TRANSFER-2223856519,COMPLETED,IN,"2026-07-01 14:40:43","2026-07-02 10:05:43",5.76,CAD,,,' +
      '"Palle Helenius",1136.36,CAD,"Palle Helenius",800.0,USD,0.704002,,,"Palle Helenius","Money added",';

    const result = parseWiseCsv(csv(topUp));
    expect(transfers(result)).toHaveLength(0); // NOT a conversion

    // It is money arriving, in the currency it actually landed in. The CAD
    // side belongs to the sending bank's statement, not to Wise's.
    const [inflow] = ordinaries(result);
    expect(inflow?.amountMinor).toBe(80000);
    expect(inflow?.currencyCode).toBe('USD');
  });

  it('a same-currency top-up lands as an inflow in that currency', () => {
    // The other real shape: CAD in, CAD out, no conversion at all. As a
    // bogus "conversion" this became a CAD debit AND a CAD credit against
    // the same account, netting the fee as a phantom loss.
    const topUp =
      'TRANSFER-2270774033,COMPLETED,IN,"2026-07-25 23:08:26","2026-07-28 10:05:13",0.31,CAD,,,' +
      '"Palle Helenius",1900.00,CAD,"Palle Helenius",1900.0,CAD,1.0,,,"Palle Helenius","Money added",';

    const result = parseWiseCsv(csv(topUp));
    expect(transfers(result)).toHaveLength(0);

    const [inflow] = ordinaries(result);
    expect(inflow?.amountMinor).toBe(190000); // what actually arrived
    expect(inflow?.currencyCode).toBe('CAD');
  });
});

describe('external transfers', () => {
  it('an inbound transfer from another person is an inflow, payee from the source side', () => {
    const received =
      'TRANSFER-2246160468,COMPLETED,IN,"2026-07-13 02:39:14","2026-07-13 02:39:26",,,,,' +
      '"Kristine Sandt",600.0,USD,"Palle Helenius",600.0,USD,1,,,,"Money added",';

    const [inflow] = ordinaries(parseWiseCsv(csv(received)));
    expect(inflow?.amountMinor).toBe(60000);
    expect(inflow?.payeeRaw).toBe('Kristine Sandt');
  });

  it('an outbound transfer to another person is an outflow including its fee', () => {
    const sent =
      'TRANSFER-2223819887,COMPLETED,OUT,"2026-07-01 14:27:13","2026-07-01 14:27:33",1.13,USD,,,' +
      '"Palle Helenius",1100.00,USD,"Katherine Obear Atwill",1100.0,USD,1.0,,,"Palle Helenius",General,';

    const [outflow] = ordinaries(parseWiseCsv(csv(sent)));
    expect(outflow?.amountMinor).toBe(-110113); // 1100.00 + 1.13 fee
    expect(outflow?.payeeRaw).toBe('Katherine Obear Atwill');
  });
});

describe('status filtering', () => {
  it('keeps an inbound refund — that is real money coming back', () => {
    const refund =
      '"CARD_TRANSACTION-4141462178",REFUNDED,IN,"2026-08-02 20:51:42","2026-08-02 20:51:42",,,,,' +
      '"Advance Auto Parts",23.32,USD,"Palle Helenius",23.32,USD,1,,,"Palle Helenius",Transport,';

    const result = parseWiseCsv(csv(refund));
    expect(result.skipped).toEqual([]);
    expect(ordinaries(result)[0]?.amountMinor).toBe(2332);
    expect(ordinaries(result)[0]?.payeeRaw).toBe('Advance Auto Parts');
  });

  it('skips an outbound refund — the money left and came back, with no return row to pair it against', () => {
    const bounced =
      'TRANSFER-2247430954,REFUNDED,OUT,"2026-07-13 15:13:30","2026-07-21 07:28:57",1.41,USD,,,' +
      '"Palle Helenius",3.54,USD,"Palle Helenius",5.0,CAD,1.41395,,,"Palle Helenius",General,';

    const result = parseWiseCsv(csv(bounced));
    expect(result.rows).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reference).toBe('TRANSFER-2247430954');
    expect(result.skipped[0]?.reason).toMatch(/refunded/i);
  });

  it('skips anything that is neither completed nor an inbound refund, saying why', () => {
    const cancelled =
      '"CARD_TRANSACTION-999",CANCELLED,OUT,"2026-07-27 15:09:01","2026-07-27 15:09:01",0.00,USD,,,' +
      '"Palle Helenius",10.00,USD,"Somewhere",10.00,USD,1.0,,,"Palle Helenius",Groceries,';

    const result = parseWiseCsv(csv(cancelled));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('CANCELLED');
  });
});

describe('file-level reporting', () => {
  it('reports every currency the file touches and the raw row count', () => {
    const result = parseWiseCsv(csv(GIANT_FOOD, SPLIT_LEG_CAD, SPLIT_LEG_USD));
    expect(result.currencies).toEqual(['CAD', 'USD']);
    expect(result.rowCount).toBe(3);
  });

  it('tolerates the trailing blank line real exports end with', () => {
    const withTrailingNewlines = `${HEADER}\n${GIANT_FOOD}\n\n`;
    expect(parseWiseCsv(withTrailingNewlines).rows).toHaveLength(1);
  });

  it('returns nothing for a header-only file rather than throwing', () => {
    const result = parseWiseCsv(`${HEADER}\n`);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });
});

describe('payeeName mirrors payeeRaw', () => {
  it('sets payeeName equal to payeeRaw on every ordinary row — Wise\'s own fields are already clean, nothing to strip', () => {
    // PR 9 split payeeRaw into a verbatim field (what payee_rules match
    // against) and payeeName (a provider's own best-effort clean name, fed
    // to the shared cleanPayeeName heuristic when no rule matches). Wise
    // never needs a separate best-effort — this pins that the contract
    // split didn't change Wise's actual behavior.
    const result = parseWiseCsv(csv(GIANT_FOOD, SPLIT_LEG_CAD, SPLIT_LEG_USD));
    for (const row of ordinaries(result)) {
      expect(row.payeeName).toBe(row.payeeRaw);
    }
  });
});

describe('category suggestions', () => {
  it('maps the labels that have a confident seeded equivalent', () => {
    expect(suggestedCategoryName('Groceries')).toBe('Groceries');
    expect(suggestedCategoryName('Transport')).toBe('Transportation');
    expect(suggestedCategoryName('Eating out')).toBe('Dining Out');
  });

  it('leaves the vague ones for the user to decide', () => {
    // 'General' and 'Money added' say nothing about intent, and there's no
    // seeded 'Personal care' — guessing here would be worse than blank.
    expect(suggestedCategoryName('General')).toBeNull();
    expect(suggestedCategoryName('Money added')).toBeNull();
    expect(suggestedCategoryName('Personal care')).toBeNull();
    expect(suggestedCategoryName(null)).toBeNull();
  });
});
