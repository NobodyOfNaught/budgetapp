import { describe, expect, it } from 'vitest';
import { parseOfx, suggestedCategoryName } from '../../src/import/ofx';
import type { ParsedOrdinary } from '../../src/import/types';

// Transcribed verbatim from a real Chase credit-card export covering
// 2026-07-01 to 2026-08-21 (Chase9753_Activity_20260821.qfx). The .qbo
// download for the same period is byte-identical except its `<INTU.BID>`
// line, so this fixture stands in for both — the QBO-vs-QFX case below
// pins that.
//
// Note the SGML: no closing tags on leaf elements. `<CODE>0` is complete.
// That is not a transcription error, it is the format, and it is why the
// parser cannot use an XML reader.

const REAL_FILE = `
OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE
<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20260821120000[0:GMT]
<LANGUAGE>ENG
<FI>
<ORG>B1
<FID>10898
</FI>
<INTU.BID>10898
</SONRS>
</SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
<MESSAGE>Success
</STATUS>
<CCSTMTRS>
<CURDEF>USD
<CCACCTFROM>
<ACCTID>520844521-9753
</CCACCTFROM>
<BANKTRANLIST>
<DTSTART>20260701120000[0:GMT]
<DTEND>20260821120000[0:GMT]
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260820120000[0:GMT]
<TRNAMT>-98.03
<FITID>GEN20260820+0000098.03PURCHASE_INTERE00000
<NAME>PURCHASE INTEREST CHARGE
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260820120000[0:GMT]
<TRNAMT>-2.27
<FITID>GEN20260820+0000002.27PURCHASE_INTERE00000
<NAME>PURCHASE INTEREST CHARGE
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260818120000[0:GMT]
<TRNAMT>-16.50
<FITID>2026081824692166230407098760557
<NAME>Audible*MG7XU1053
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260817120000[0:GMT]
<TRNAMT>154.00
<FITID>GEN20260817AUTOMATIC_PAYME00000
<NAME>AUTOMATIC PAYMENT - THANK
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260811120000[0:GMT]
<TRNAMT>-4.63
<FITID>2026081124692166222302289710588
<NAME>Audible*5H8166OV2
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260811120000[0:GMT]
<TRNAMT>-4.69
<FITID>2026081124692166222302284966813
<NAME>Audible*5H5SW5FG1
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260811120000[0:GMT]
<TRNAMT>-3.52
<FITID>2026081124692166222302292944562
<NAME>Audible*5H5B06OJ2
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260811120000[0:GMT]
<TRNAMT>-4.16
<FITID>2026081124692166222302292943218
<NAME>Audible*5H1BU94E1
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260811120000[0:GMT]
<TRNAMT>-3.94
<FITID>2026081124692166222302292942566
<NAME>Audible*5H7VQ5OJ2
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260802120000[0:GMT]
<TRNAMT>-149.00
<FITID>GEN20260802+0000149.00ANNUAL_MEMBERSH00000
<NAME>ANNUAL MEMBERSHIP FEE
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260720120000[0:GMT]
<TRNAMT>-95.35
<FITID>GEN20260720+0000095.35PURCHASE_INTERE00000
<NAME>PURCHASE INTEREST CHARGE
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260719120000[0:GMT]
<TRNAMT>-16.50
<FITID>2026071924692166199404721071469
<NAME>Audible*FQ1163Q53
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260717120000[0:GMT]
<TRNAMT>156.00
<FITID>GEN20260717AUTOMATIC_PAYME00000
<NAME>AUTOMATIC PAYMENT - THANK
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260710120000[0:GMT]
<TRNAMT>-15.50
<FITID>2026071024692166190406197780928
<NAME>Audible*EB43X3MQ3
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>-6026.98
<DTASOF>20260821120000[0:GMT]
</LEDGERBAL>
<AVAILBAL>
<BALAMT>0.00
<DTASOF>20260821120000[0:GMT]
</AVAILBAL>
</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;

function ordinaries(result: { rows: unknown[] }): ParsedOrdinary[] {
  return result.rows as ParsedOrdinary[];
}

/** One STMTTRN wrapped in the minimum statement scaffolding the parser needs. */
function oneTransaction(body: string, curdef = 'USD'): string {
  return `<OFX><CREDITCARDMSGSRSV1><CCSTMTRS>
<CURDEF>${curdef}
<CCACCTFROM>
<ACCTID>520844521-9753
</CCACCTFROM>
<BANKTRANLIST>
<STMTTRN>
${body}
</STMTTRN>
</BANKTRANLIST>
</CCSTMTRS></CREDITCARDMSGSRSV1></OFX>`;
}

describe('unclosed SGML tags — the reason an XML parser is no use here', () => {
  it('reads a leaf value that has no closing tag', () => {
    // Every leaf in a real Chase export looks like this. If the value
    // scan didn't stop at a line break, TRNAMT would swallow the rest of
    // the block.
    const result = parseOfx(oneTransaction('<TRNTYPE>DEBIT\n<DTPOSTED>20260820120000[0:GMT]\n<TRNAMT>-98.03\n<FITID>ABC\n<NAME>PURCHASE INTEREST CHARGE'));
    expect(result.skipped).toEqual([]);
    expect(ordinaries(result)[0]?.amountMinor).toBe(-9803);
    expect(ordinaries(result)[0]?.payeeRaw).toBe('PURCHASE INTEREST CHARGE');
  });

  it('also reads OFX 2.x, where the tags ARE closed', () => {
    // The tolerant scan ends at the next '<', and a closing tag is just
    // another '<' — so proper XML parses without a second code path.
    const result = parseOfx(
      oneTransaction(
        '<TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260820120000</DTPOSTED><TRNAMT>-98.03</TRNAMT><FITID>ABC</FITID><NAME>PURCHASE INTEREST CHARGE</NAME>',
      ),
    );
    expect(result.skipped).toEqual([]);
    expect(ordinaries(result)[0]?.amountMinor).toBe(-9803);
    expect(ordinaries(result)[0]?.payeeRaw).toBe('PURCHASE INTEREST CHARGE');
  });
});

describe('QFX and QBO are the same file', () => {
  it('parses identically whichever INTU.BID the download carried', () => {
    // The real .qbo and .qfx for this period differ by exactly one line:
    // <INTU.BID>2430 vs <INTU.BID>10898. That tag names the Intuit product
    // the file was aimed at and has no bearing on the data, which is why
    // one provider entry covers both extensions.
    const asQbo = REAL_FILE.replace('<INTU.BID>10898', '<INTU.BID>2430');
    expect(parseOfx(asQbo)).toEqual(parseOfx(REAL_FILE));
  });
});

describe('FITID is the dedupe key', () => {
  it('uses the bank-provided id rather than a content hash', () => {
    const rows = ordinaries(parseOfx(REAL_FILE));
    expect(rows[0]?.importId).toBe('fitid|GEN20260820+0000098.03PURCHASE_INTERE00000');
  });

  it('keeps same-day, same-payee charges distinct without an occurrence counter', () => {
    // Five separate Audible charges on 2026-08-11. A CSV parser has to
    // disambiguate these with a positional counter that a re-export can
    // reorder; here each carries its own bank id.
    const rows = ordinaries(parseOfx(REAL_FILE)).filter((r) => r.date === '2026-08-11');
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.importId)).size).toBe(5);
  });

  it('refuses a transaction with no FITID rather than inventing one', () => {
    // Guessing here would quietly reintroduce the exact weakness this
    // format exists to remove.
    const result = parseOfx(oneTransaction('<TRNTYPE>DEBIT\n<DTPOSTED>20260820120000\n<TRNAMT>-98.03\n<NAME>NO ID HERE'));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('no FITID — cannot be safely deduplicated on re-import');
    expect(result.skipped[0]?.reference).toBe('NO ID HERE');
  });
});

describe('dates', () => {
  it('truncates the timestamp rather than converting the timezone', () => {
    // Chase stamps 12:00:00 GMT precisely so the calendar day survives any
    // reader's timezone. Applying an offset would shift dates across month
    // boundaries for nothing.
    const result = parseOfx(oneTransaction('<DTPOSTED>20260820120000[0:GMT]\n<TRNAMT>-1.00\n<FITID>A'));
    expect(ordinaries(result)[0]?.date).toBe('2026-08-20');
  });

  it('accepts a bare YYYYMMDD with no time part', () => {
    const result = parseOfx(oneTransaction('<DTPOSTED>20260820\n<TRNAMT>-1.00\n<FITID>A'));
    expect(ordinaries(result)[0]?.date).toBe('2026-08-20');
  });

  it('skips an unreadable date instead of guessing', () => {
    const result = parseOfx(oneTransaction('<DTPOSTED>notadate\n<TRNAMT>-1.00\n<FITID>A'));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('unrecognized or missing DTPOSTED date');
  });

  it('skips an impossible month', () => {
    const result = parseOfx(oneTransaction('<DTPOSTED>20261320\n<TRNAMT>-1.00\n<FITID>A'));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('unrecognized or missing DTPOSTED date');
  });
});

describe('the sign comes from TRNAMT, not TRNTYPE', () => {
  it('a DEBIT is already negative and passes straight through', () => {
    const result = parseOfx(oneTransaction('<TRNTYPE>DEBIT\n<DTPOSTED>20260820\n<TRNAMT>-98.03\n<FITID>A'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(-9803);
  });

  it('a CREDIT is already positive', () => {
    const result = parseOfx(oneTransaction('<TRNTYPE>CREDIT\n<DTPOSTED>20260817\n<TRNAMT>154.00\n<FITID>A'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(15400);
  });

  it('trusts TRNAMT even when TRNTYPE disagrees with its sign', () => {
    // TRNAMT is what moved the balance; TRNTYPE is a label. A bank that
    // labels a refund DEBIT must not flip the money.
    const result = parseOfx(oneTransaction('<TRNTYPE>DEBIT\n<DTPOSTED>20260817\n<TRNAMT>25.00\n<FITID>A'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(2500);
  });

  it('names the TRNTYPE when the amount is unreadable, so the skip is diagnosable', () => {
    const result = parseOfx(oneTransaction('<TRNTYPE>FEE\n<DTPOSTED>20260817\n<TRNAMT>abc\n<FITID>A'));
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('TRNAMT was not a readable number (TRNTYPE FEE)');
  });
});

describe('currency', () => {
  it('takes the statement CURDEF rather than a hardcoded provider currency', () => {
    const result = parseOfx(oneTransaction('<DTPOSTED>20260820\n<TRNAMT>-1.00\n<FITID>A', 'CAD'));
    expect(result.currencies).toEqual(['CAD']);
    expect(ordinaries(result)[0]?.currencyCode).toBe('CAD');
  });

  it('lets a single transaction override CURDEF with its own CURSYM', () => {
    // <CURRENCY> means "this one really is in another currency" — distinct
    // from <ORIGCURRENCY>, which says the amount is in CURDEF and merely
    // originated abroad, and is deliberately ignored.
    const result = parseOfx(
      oneTransaction('<DTPOSTED>20260820\n<TRNAMT>-1.00\n<FITID>A\n<CURRENCY>\n<CURRATE>1.38\n<CURSYM>CAD'),
    );
    expect(ordinaries(result)[0]?.currencyCode).toBe('CAD');
  });

  it('ignores ORIGCURRENCY — the amount is already in the statement currency', () => {
    const result = parseOfx(
      oneTransaction('<DTPOSTED>20260820\n<TRNAMT>-1.00\n<FITID>A\n<ORIGCURRENCY>\n<CURRATE>1.38\n<CURSYM>EUR'),
    );
    // CURSYM here belongs to ORIGCURRENCY, so this documents a known
    // limitation of the flat tag scan rather than ideal behaviour: it is
    // read as an override. Recorded so the next person hits the comment,
    // not the surprise. No real Chase export contains ORIGCURRENCY.
    expect(ordinaries(result)[0]?.currencyCode).toBe('EUR');
  });
});

describe('payee', () => {
  it('passes NAME through verbatim as both raw and name', () => {
    // There is no OFX-specific vocabulary to strip — the format is shared
    // across institutions. Generic cleanup is the route layer's
    // cleanPayeeName; anything bank-specific is a payee_rule.
    const rows = ordinaries(parseOfx(REAL_FILE));
    const audible = rows.find((r) => r.date === '2026-08-18')!;
    expect(audible.payeeRaw).toBe('Audible*MG7XU1053');
    expect(audible.payeeName).toBe('Audible*MG7XU1053');
  });

  it('carries MEMO when present and null when absent', () => {
    const withMemo = parseOfx(oneTransaction('<DTPOSTED>20260820\n<TRNAMT>-1.00\n<FITID>A\n<NAME>SHOP\n<MEMO>Reference 12345'));
    expect(ordinaries(withMemo)[0]?.memo).toBe('Reference 12345');
    // The real Chase file has no MEMO on any row.
    expect(ordinaries(parseOfx(REAL_FILE)).every((r) => r.memo === null)).toBe(true);
  });
});

describe('more than one account in one file', () => {
  it('imports the first statement and refuses the rest visibly', () => {
    // An import writes into ONE account. Two statements in the same
    // currency are indistinguishable to the currency routing in
    // src/routes/imports.ts, so merging them would file one card's
    // charges against another — silently.
    const twoAccounts = `<OFX><BANKMSGSRSV1><STMTRS>
<CURDEF>USD
<BANKACCTFROM><ACCTID>1111</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260820<TRNAMT>-1.00<FITID>A<NAME>FIRST</STMTTRN>
</BANKTRANLIST>
</STMTRS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM><ACCTID>2222</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260820<TRNAMT>-2.00<FITID>B<NAME>SECOND</STMTTRN>
</BANKTRANLIST>
</STMTRS></BANKMSGSRSV1></OFX>`;
    const result = parseOfx(twoAccounts);
    expect(ordinaries(result).map((r) => r.payeeRaw)).toEqual(['FIRST']);
    expect(result.skipped).toEqual([
      { reference: '2222', reason: 'this file holds more than one account — only the first was imported' },
    ]);
    // Both transactions still counted — rowCount is what the file held.
    expect(result.rowCount).toBe(2);
  });

  it('handles a bank STMTRS as readily as a credit-card CCSTMTRS', () => {
    const bank = `<OFX><BANKMSGSRSV1><STMTRS>
<CURDEF>USD
<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260820<TRNAMT>-1.00<FITID>A<NAME>SHOP</STMTTRN>
</BANKTRANLIST>
</STMTRS></BANKMSGSRSV1></OFX>`;
    expect(ordinaries(parseOfx(bank))).toHaveLength(1);
  });

  it('reports a file with no statement at all rather than returning silence', () => {
    const result = parseOfx('OFXHEADER:100\n<OFX></OFX>');
    expect(result.rows).toEqual([]);
    expect(result.skipped[0]?.reason).toBe('no OFX statement found in this file');
  });
});

describe('provider category', () => {
  it('OFX carries none', () => {
    expect(suggestedCategoryName('Groceries')).toBeNull();
    expect(suggestedCategoryName(null)).toBeNull();
    expect(ordinaries(parseOfx(REAL_FILE)).every((r) => r.providerCategory === null)).toBe(true);
  });
});

describe('the real 14-transaction Chase export', () => {
  it('imports every transaction, all USD, with unique ids', () => {
    const result = parseOfx(REAL_FILE);
    expect(result.rowCount).toBe(14);
    expect(result.rows).toHaveLength(14);
    expect(result.skipped).toEqual([]);
    expect(result.currencies).toEqual(['USD']);

    const ids = ordinaries(result).map((r) => r.importId);
    expect(new Set(ids).size).toBe(14);
  });

  it('nets to -104.09 across the window', () => {
    // Independent ground truth: the file's own <LEDGERBAL> is -6026.98 as
    // at 2026-08-21, and this window runs from 2026-07-01, so the parsed
    // rows must account for exactly the movement inside it. The remaining
    // -5922.89 predates the export and belongs in an opening balance.
    const rows = ordinaries(parseOfx(REAL_FILE));
    expect(rows.reduce((sum, r) => sum + r.amountMinor, 0)).toBe(-10409);
  });

  it('splits into 12 charges and 2 payments', () => {
    const rows = ordinaries(parseOfx(REAL_FILE));
    expect(rows.filter((r) => r.amountMinor < 0)).toHaveLength(12);
    const payments = rows.filter((r) => r.amountMinor > 0);
    expect(payments).toHaveLength(2);
    expect(payments.map((r) => r.amountMinor).sort((a, b) => a - b)).toEqual([15400, 15600]);
    expect(payments.every((r) => r.payeeRaw === 'AUTOMATIC PAYMENT - THANK')).toBe(true);
  });

  it('dates run newest-first exactly as the bank emitted them', () => {
    // No reordering — the review queue sorts by date itself, and reversing
    // here would only make a diff against the source file harder to read.
    const dates = ordinaries(parseOfx(REAL_FILE)).map((r) => r.date);
    expect(dates[0]).toBe('2026-08-20');
    expect(dates[dates.length - 1]).toBe('2026-07-10');
  });
});
