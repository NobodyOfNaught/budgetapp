import { describe, expect, it } from 'vitest';
import { parseVancityVisaCsv, suggestedCategoryName } from '../../src/import/vancity-visa';
import type { ParsedOrdinary } from '../../src/import/types';

// Rows transcribed verbatim from two real Vancity Visa exports (Jun–Aug
// 2026, CAD, 25 rows across both files). This file is the parser's spec;
// see src/import/vancity-visa.ts for the five format quirks it handles.

const HEADER =
  '"Date","Posted Date","Reference Number","Activity Type","Status","Transaction Card Number",' +
  '"Merchant Category","Merchant Name","Merchant City","Merchant State/Province","Merchant Country",' +
  '"Merchant Postal Code/Zip","Amount","Rewards","Name on Card"';

function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows, ''].join('\n');
}

/** The real files are UTF-8-with-BOM on disk; parseCsv strips it if it survives decoding (see test/import/csv.test.ts). */
function bomCsv(...dataRows: string[]): string {
  return '﻿' + csv(...dataRows);
}

function ordinaries(result: { rows: unknown[] }): ParsedOrdinary[] {
  return result.rows as ParsedOrdinary[];
}

const ANTHROPIC =
  '"2026-08-16","2026-08-17","""24011346229100022196833""","TRANS","APPROVED","************2476",' +
  '"Computer Software Stores","ANTHROPIC* CLAUDE SUB","ANTHROPIC.COM","CA","USA","94104","$31.36","39","PALLE E HELENIUS"';
const GIANT =
  '"2026-08-07","2026-08-10","""24692166220405219756951""","TRANS","APPROVED","************2476",' +
  '"Grocery Stores and Supermarkets","GIANT LANDOVER #2746","HERNDON","VA","USA","20171","$62.29","156","PALLE E HELENIUS"';
const PAYMENT =
  '"2026-07-25","2026-07-27","""74789016208100000803318""","TRANS","APPROVED","************2476",' +
  '"","PAYMENT RECEIVED -- THANK","YOU","","","","-$200.00","","PALLE E HELENIUS"';
const INTEREST =
  '"2026-07-21","2026-07-21","","TRANS","APPROVED","************2476",' +
  '"","PURCHASE INT. CHARGED","","","","","$96.49","","PALLE E HELENIUS"';
const RESTAURANT =
  '"2026-08-09","2026-08-10","""24692166222302113479665""","TRANS","APPROVED","************2476",' +
  '"Eating Places and Restaurants","TST*CHARCOAL CHICKEN RES","Chantilly","VA","USA","20151","$41.99","52","PALLE E HELENIUS"';
// Note the trailing non-breaking space the bank emits in this category.
const MSFT =
  '"2026-08-07","2026-08-10","""74587276219631456004390""","TRANS","APPROVED","************2476",' +
  '"Computers, Computer Peripheral Equipment, and Software ","MSFT * E07010CZAJ","MSFT AZURE","ON","CAN","00000","$0.52","1","PALLE E HELENIUS"';
const PHARMACY =
  '"2026-06-25","2026-06-26","""24445006177001012895285""","TRANS","APPROVED","************2476",' +
  '"Drug Stores and Pharmacies","WALGREENS #18255","SILVER SPRING","MD","USA","20904","$26.31","33","PALLE E HELENIUS"';

describe('the inverted sign convention — the quirk most likely to go unnoticed', () => {
  it('a purchase prints POSITIVE in the file and becomes an outflow', () => {
    const result = parseVancityVisaCsv(csv(ANTHROPIC));
    expect(ordinaries(result)[0]?.amountMinor).toBe(-3136);
  });

  it('a payment prints NEGATIVE in the file and becomes an inflow', () => {
    const result = parseVancityVisaCsv(csv(PAYMENT));
    expect(ordinaries(result)[0]?.amountMinor).toBe(20000);
  });

  it('interest charged is spending, not income', () => {
    // The one that would be silently wrong if the flip were dropped: a
    // fee would read as money arriving.
    const result = parseVancityVisaCsv(csv(INTEREST));
    expect(ordinaries(result)[0]?.amountMinor).toBe(-9649);
  });

  it('is the OPPOSITE of Neo, the other credit card here', () => {
    // Neo prints a charge negative and passes straight through
    // (src/import/neo.ts); this one prints it positive and must flip.
    // Pinned so the two can never be "unified" by mistake.
    const result = parseVancityVisaCsv(csv(GIANT));
    expect(ordinaries(result)[0]?.amountMinor).toBeLessThan(0);
  });
});

describe('amounts carry a currency symbol', () => {
  it('strips the dollar sign', () => {
    expect(ordinaries(parseVancityVisaCsv(csv(MSFT)))[0]?.amountMinor).toBe(-52);
  });

  it('handles the minus sitting OUTSIDE the symbol', () => {
    // "-$200.00", never "$-200.00" — stripping "$" from the front first
    // would lose the sign entirely.
    expect(ordinaries(parseVancityVisaCsv(csv(PAYMENT)))[0]?.amountMinor).toBe(20000);
  });

  it('skips a row whose amount is unreadable', () => {
    const broken = ANTHROPIC.replace('"$31.36"', '"n/a"');
    const result = parseVancityVisaCsv(csv(broken));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('Amount was not a readable number');
  });
});

describe('Reference Number as a real transaction id', () => {
  it('uses it, unwrapped from the literal quotes the export adds', () => {
    const result = parseVancityVisaCsv(csv(ANTHROPIC));
    expect(ordinaries(result)[0]?.importId).toBe('ref|24011346229100022196833');
  });

  it('falls back to content for a bank row that has none', () => {
    const result = parseVancityVisaCsv(csv(INTEREST));
    expect(ordinaries(result)[0]?.importId).toBe('gen|2026-07-21|-9649|PURCHASE INT. CHARGED|0');
  });

  it('keeps two id-less identical rows distinct', () => {
    const result = parseVancityVisaCsv(csv(INTEREST, INTEREST));
    const ids = ordinaries(result).map((r) => r.importId);
    expect(new Set(ids).size).toBe(2);
  });

  it('cannot collide a reference id with a generated one', () => {
    const result = parseVancityVisaCsv(csv(ANTHROPIC, INTEREST));
    const [withRef, withoutRef] = ordinaries(result);
    expect(withRef?.importId.startsWith('ref|')).toBe(true);
    expect(withoutRef?.importId.startsWith('gen|')).toBe(true);
  });
});

describe('Merchant Category becomes a suggested category', () => {
  it('maps the confident cases', () => {
    expect(suggestedCategoryName('Grocery Stores and Supermarkets')).toBe('Groceries');
    expect(suggestedCategoryName('Eating Places and Restaurants')).toBe('Dining Out');
    expect(suggestedCategoryName('Taxicabs and Limousines')).toBe('Transportation');
    expect(suggestedCategoryName('Motion Picture Theater')).toBe('Fun Money');
    expect(suggestedCategoryName('Computer Software Stores')).toBe('Subscriptions');
  });

  it('tolerates the trailing non-breaking space the bank emits', () => {
    expect(suggestedCategoryName('Computers, Computer Peripheral Equipment, and Software ')).toBe('Subscriptions');
    // ...and end to end, through the parser's own trimming.
    const result = parseVancityVisaCsv(csv(MSFT));
    expect(suggestedCategoryName(ordinaries(result)[0]!.providerCategory)).toBe('Subscriptions');
  });

  it('returns null rather than guessing at a category with no obvious home', () => {
    expect(suggestedCategoryName('Drug Stores and Pharmacies')).toBeNull();
    const result = parseVancityVisaCsv(csv(PHARMACY));
    // The raw category is still carried through for the user to see.
    expect(ordinaries(result)[0]?.providerCategory).toBe('Drug Stores and Pharmacies');
    expect(suggestedCategoryName(ordinaries(result)[0]!.providerCategory)).toBeNull();
  });

  it('is null for a bank row with no category at all', () => {
    expect(suggestedCategoryName(null)).toBeNull();
    expect(ordinaries(parseVancityVisaCsv(csv(PAYMENT)))[0]?.providerCategory).toBeNull();
  });
});

describe('bank-generated rows spill their text into Merchant City', () => {
  it('rejoins "PAYMENT RECEIVED -- THANK" + "YOU"', () => {
    const result = parseVancityVisaCsv(csv(PAYMENT));
    expect(ordinaries(result)[0]?.payeeName).toBe('PAYMENT RECEIVED -- THANK YOU');
  });

  it('does NOT join a real merchant to its real city', () => {
    // The whole reason the join is gated: "ANTHROPIC* CLAUDE SUB" must not
    // become "ANTHROPIC* CLAUDE SUB ANTHROPIC.COM".
    expect(ordinaries(parseVancityVisaCsv(csv(ANTHROPIC)))[0]?.payeeName).toBe('ANTHROPIC* CLAUDE SUB');
    expect(ordinaries(parseVancityVisaCsv(csv(RESTAURANT)))[0]?.payeeName).toBe('TST*CHARCOAL CHICKEN RES');
  });

  it('leaves a bank row with an empty city alone', () => {
    expect(ordinaries(parseVancityVisaCsv(csv(INTEREST)))[0]?.payeeName).toBe('PURCHASE INT. CHARGED');
  });
});

describe('non-approved rows', () => {
  it('are skipped with the status in the reason', () => {
    const declined = ANTHROPIC.replace('"APPROVED"', '"DECLINED"');
    const result = parseVancityVisaCsv(csv(declined));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('status was declined, not approved');
  });
});

describe('dates', () => {
  it('uses the transaction Date, not Posted Date — they differ on most rows', () => {
    const result = parseVancityVisaCsv(csv(ANTHROPIC)); // 2026-08-16 vs posted 2026-08-17
    expect(ordinaries(result)[0]?.date).toBe('2026-08-16');
  });

  it('skips a row whose date is not ISO', () => {
    const result = parseVancityVisaCsv(csv(ANTHROPIC.replace('"2026-08-16"', '"16/08/2026"')));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('unrecognized date');
  });
});

describe('a real file, BOM and all', () => {
  it('parses every row despite the leading byte-order mark', () => {
    // Blob.text() strips the BOM before upload, so this exercises the
    // reader's own guard rather than a break seen in practice — see
    // src/import/csv.ts.
    const result = parseVancityVisaCsv(bomCsv(ANTHROPIC, GIANT, PAYMENT, INTEREST, RESTAURANT, MSFT, PHARMACY));
    expect(result.rowCount).toBe(7);
    expect(result.rows).toHaveLength(7);
    expect(result.skipped).toEqual([]);
    expect(result.currencies).toEqual(['CAD']);
  });

  it('nets purchases against payments in this app’s direction', () => {
    const result = parseVancityVisaCsv(bomCsv(ANTHROPIC, GIANT, PAYMENT, INTEREST));
    // File states: +31.36 +62.29 -200.00 +96.49 = -9.86 (what you owe).
    // This app states the account: the negation, +9.86.
    const total = ordinaries(result).reduce((sum, r) => sum + r.amountMinor, 0);
    expect(total).toBe(986);
  });

  it('every import id is unique across a mixed file', () => {
    const ids = ordinaries(parseVancityVisaCsv(bomCsv(ANTHROPIC, GIANT, PAYMENT, INTEREST, RESTAURANT, MSFT, PHARMACY))).map(
      (r) => r.importId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
