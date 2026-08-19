import { describe, expect, it } from 'vitest';
import { parseAacuCsv, suggestedCategoryName } from '../../src/import/aacu';
import type { ParsedOrdinary } from '../../src/import/types';

// The header and every data row here are transcribed verbatim from a real
// AACU export — same column order, same quoting (header unquoted, Account
// Number/Description quoted, everything else bare). This file is the
// parser's spec; see src/import/aacu.ts for the two format quirks it
// exists to handle (a Status column whose Pending rows can't dedupe
// against their own later Posted version, and dividend credits printed as
// a bare ".01").

const HEADER = 'Account Number,Post Date,Check,Description,Debit,Credit,Status,Balance';

function csv(...dataRows: string[]): string {
  return [HEADER, ...dataRows, ''].join('\n');
}

function ordinaries(result: { rows: unknown[] }): ParsedOrdinary[] {
  return result.rows as ParsedOrdinary[];
}

// The full real file, 52 data rows (51 posted + 1 pending), newest-first,
// used for whole-file assertions below.
const REAL_FILE = csv(
  '"XXXX1465-0050",8/19/2026,,"TRITON SUPERMARK 5411021140 0819131100 623117429371                    11",6.44,,Pending,',
  '"XXXX1465-0050",8/14/2026,,"Withdrawal POS #622617041268 WALGREENS STORE 13307 NEW SILVER SPRING Card 7013",37.28,,Posted,270.21',
  '"XXXX1465-0050",8/14/2026,,"ACH Deposit:  Deposit ACH AMERICANAIRLINES TYPE: PAYROLL ID: 6131502798 DATA: DIRECT DEPOSIT CO: Entry Class Code: PPDACH Trace Number: 02100002247189",,300.00,Posted,307.49',
  '"XXXX1465-0050",8/10/2026,,"Withdrawal Debit Card VENMO *Katherine Atwill New York NY Date 08/10/26 04248186223406310063100 Card 7013",190.00,,Posted,7.49',
  '"XXXX1465-0050",8/6/2026,,"Withdrawal POS #621814897641 GIANT FOOD INC #152 COLESVILLE MD Card 7013",23.61,,Posted,197.49',
  '"XXXX1465-0050",8/6/2026,,"Withdrawal Debit Card SMARTRIP WASHINGTON DC WASHINGTON DC Date 08/05/26 24445006218500659609520 Card 7013",20.00,,Posted,221.10',
  '"XXXX1465-0050",8/1/2026,,"Recurring Withdrawal Bill Payment - #621327408786 GOOGLE *SVCSkristinesa g.co/HelpPay# CA Card 7013",14.81,,Posted,241.10',
  '"XXXX1465-0050",8/1/2026,,"Withdrawal POS #080107962294 GOOGLE *Workspace_kristin Mountain View Card 7013",29.15,,Posted,255.91',
  '"XXXX1465-0050",8/1/2026,,"Withdrawal Debit Card DANCE JAM PRODUCTIONS DANCEJAMPRODU MD Date 07/31/26 24064666213100007811138 Card 7013",30.00,,Posted,285.06',
  '"XXXX1465-0050",8/1/2026,,"Deposit Dividend 0.050% Annual Percentage Yield Earned 0.07% from 07/01/26 through 07/31/26",,.01,Posted,315.06',
  '"XXXX1465-0050",7/28/2026,,"Withdrawal POS #2WDCT3IO UBER * PENDING 405 Howard St San CA Card 7013",30.52,,Posted,315.05',
  '"XXXX1465-0050",7/28/2026,,"ACH Deposit:  Deposit ACH AMERICANAIRLINES TYPE: PAYROLL ID: 6131502798 DATA: DIRECT DEPOSIT CO: Entry Class Code: PPDACH Trace Number: 02100002348567",,300.00,Posted,345.57',
  '"XXXX1465-0050",7/28/2026,,"Withdrawal Debit Card LYFT *STANDARD 07-27 LYFT.COM CA Date 07/28/26 24011346209100096105516 Card 7013",24.81,,Posted,45.57',
  '"XXXX1465-0050",7/28/2026,,"Credit/Debit Card Deposit:  Deposit Debit Card VENMO*Sandt Kristine New York City NY Date 07/28/26 14248186209393757937572 Card 7013",,24.57,Posted,70.38',
  '"XXXX1465-0050",7/25/2026,,"Withdrawal Debit Card DANCE JAM PRODUCTIONS DANCEJAMPRODU MD Date 07/25/26 24064666206100011360329 Card 7013",20.00,,Posted,45.81',
  '"XXXX1465-0050",7/23/2026,,"Withdrawal Debit Card SMARTRIP WASHINGTON DC WASHINGTON DC Date 07/22/26 24445006204500653588015 Card 7013",20.00,,Posted,65.81',
  '"XXXX1465-0050",7/21/2026,,"Withdrawal POS #24ZAWU40 UBER *TRIP HELP.UBER.CO 405 Howard St Francisco CA Card 7013",2.00,,Posted,85.81',
  '"XXXX1465-0050",7/21/2026,,"Withdrawal POS #3NU00C8U UBER * PENDING 405 Howard St San CA Card 7013",14.21,,Posted,87.81',
  '"XXXX1465-0050",7/20/2026,,"Withdrawal POS #620111755961 GIANT FOOD INC #152 COLESVILLE MD Card 7013",33.28,,Posted,102.02',
  '"XXXX1465-0050",7/20/2026,,"Withdrawal POS #255Z06DT UBER * PENDING 405 Howard St San CA Card 7013",16.95,,Posted,135.30',
  '"XXXX1465-0050",7/20/2026,,"Withdrawal POS #1WW9T8N4 UBER *TRIP HELP.UBER.CO 405 Howard St Francisco CA Card 7013",2.00,,Posted,152.25',
  '"XXXX1465-0050",7/20/2026,,"Withdrawal ACH VENMO TYPE: PURCHASE ID: 3264681992 CO: VENMO NAME: KRISTINE SANDT Entry Class Code: WEBACH Trace Number: 091000011524190",33.29,,Posted,154.25',
  '"XXXX1465-0050",7/20/2026,,"Withdrawal ACH VENMO TYPE: PURCHASE ID: 3264681992 CO: VENMO NAME: KRISTINE SANDT Entry Class Code: WEBACH Trace Number: 091000018269732",14.89,,Posted,187.54',
  '"XXXX1465-0050",7/20/2026,,"Withdrawal POS #3OAJA350 UBER * PENDING 405 Howard St San CA Card 7013",13.86,,Posted,202.43',
  '"XXXX1465-0050",7/19/2026,,"Withdrawal Debit Card SMARTRIP WASHINGTON DC WASHINGTON DC Date 07/18/26 24445006200500777789626 Card 7013",10.00,,Posted,216.29',
  '"XXXX1465-0050",7/18/2026,,"Withdrawal Debit Card SMARTRIP WASHINGTON DC WASHINGTON DC Date 07/17/26 24445006199500805800331 Card 7013",10.00,,Posted,226.29',
  '"XXXX1465-0050",7/17/2026,,"Withdrawal POS #2QR8IO04 UBER *TRIP HELP.UBER.CO 405 Howard St Francisco CA Card 7013",2.00,,Posted,236.29',
  '"XXXX1465-0050",7/16/2026,,"Withdrawal Debit Card SMARTRIP WASHINGTON DC WASHINGTON DC Date 07/15/26 24445006197500649737667 Card 7013",10.00,,Posted,238.29',
  '"XXXX1465-0050",7/16/2026,,"Withdrawal POS #24PEP7Z2 UBER * PENDING 405 Howard St San CA Card 7013",17.04,,Posted,248.29',
  '"XXXX1465-0050",7/15/2026,,"Withdrawal POS #2W9P4N3A UBER *TRIP HELP.UBER.CO 405 Howard St Francisco CA Card 7013",2.00,,Posted,265.33',
  '"XXXX1465-0050",7/14/2026,,"Withdrawal POS #2SB751Y8 UBER * PENDING 405 Howard St San CA Card 7013",12.56,,Posted,267.33',
  '"XXXX1465-0050",7/14/2026,,"Withdrawal Debit Card SUSHIKO 301-961-1644 MD Date 07/12/26 24342856194017012712420 Card 7013",18.90,,Posted,279.89',
  '"XXXX1465-0050",7/13/2026,,"ACH Deposit:  Deposit ACH AMERICANAIRLINES TYPE: PAYROLL ID: 6131502798 DATA: DIRECT DEPOSIT CO: Entry Class Code: PPDACH Trace Number: 02100002816654",,245.50,Posted,298.79',
  '"XXXX1465-0050",7/13/2026,,"Withdrawal POS #3JX5E4KL UBER *TRIP HELP.UBER.CO 405 Howard St Francisco CA Card 7013",2.00,,Posted,53.29',
  '"XXXX1465-0050",7/9/2026,,"Withdrawal Debit Card EASTERN MARKET @DCA 449 ARLINGTON VA Date 07/08/26 24435656190195849128790 Card 7013",29.42,,Posted,55.29',
  '"XXXX1465-0050",7/9/2026,,"Withdrawal POS #2RE3J1KB UBER * PENDING 405 Howard St San CA Card 7013",15.66,,Posted,84.71',
  '"XXXX1465-0050",7/8/2026,,"Withdrawal POS #25T2FZKB UBER *TRIP HELP.UBER.CO 405 Howard St Francisco CA Card 7013",2.00,,Posted,100.37',
  '"XXXX1465-0050",7/8/2026,,"Withdrawal Debit Card SMARTRIP WASHINGTON DC WASHINGTON DC Date 07/07/26 24445006189500617767258 Card 7013",20.00,,Posted,102.37',
  '"XXXX1465-0050",7/8/2026,,"Withdrawal POS #25CIXBQ0 UBER * PENDING 405 Howard St San CA Card 7013",15.16,,Posted,122.37',
  '"XXXX1465-0050",7/7/2026,,"Withdrawal POS #2WWTDR9H UBER *TRIP HELP.UBER.CO 405 Howard St Francisco CA Card 7013",2.00,,Posted,137.53',
  '"XXXX1465-0050",7/7/2026,,"Withdrawal POS #618800902519 WHOLEFDS GWU 10414 2221 I ST NW DC Card 7013",46.31,,Posted,139.53',
  '"XXXX1465-0050",7/4/2026,,"Withdrawal POS #3O8H4N0R UBER * PENDING 405 Howard St San CA Card 7013",18.22,,Posted,185.84',
  '"XXXX1465-0050",7/3/2026,,"Withdrawal POS #618420081416 CVS/PHARMACY #11 11161--5 Fort Worth TX Card 7013",13.32,,Posted,204.06',
  '"XXXX1465-0050",7/3/2026,,"Withdrawal Debit Card AMAZON MKTPL*335616WL3 Amzn.com/bill WA Date 07/03/26 24692166184400617944493 Card 7013",13.75,,Posted,217.38',
  '"XXXX1465-0050",7/3/2026,,"Withdrawal POS #260Z2DE2 UBER *TRIP HELP.UBER.CO 405 Howard St Francisco CA Card 7013",3.00,,Posted,231.13',
  '"XXXX1465-0050",7/2/2026,,"Withdrawal Debit Card LAX Travel@Ease 3157 Los Angeles CA Date 07/02/26 24793386183002591273098 Card 7013",7.66,,Posted,234.13',
  '"XXXX1465-0050",7/2/2026,,"Withdrawal Debit Card LYFT *STANDARD 07-01 LYFT.COM CA Date 07/02/26 24011346183100131325772 Card 7013",18.95,,Posted,241.79',
  '"XXXX1465-0050",7/2/2026,,"Withdrawal Debit Card SMARTRIP WASHINGTON DC WASHINGTON DC Date 07/01/26 24445006183500735647701 Card 7013",10.00,,Posted,260.74',
  '"XXXX1465-0050",7/2/2026,,"Withdrawal Debit Card EASTERN MARKET @DCA 449 ARLINGTON VA Date 07/01/26 24435656183194079258251 Card 7013",21.67,,Posted,270.74',
  '"XXXX1465-0050",7/2/2026,,"Recurring Withdrawal Debit Card GOOGLE*SVCSKRISTINESAN WILMINGTON DE Date 07/01/26 24803946183910002590984 Card 7013",15.22,,Posted,292.41',
  '"XXXX1465-0050",7/1/2026,,"Withdrawal POS #070107913006 GOOGLE *Workspace_kristin Mountain View Card 7013",29.12,,Posted,307.63',
  '"XXXX1465-0050",7/1/2026,,"Deposit Dividend 0.050% Annual Percentage Yield Earned 0.06% from 06/01/26 through 06/30/26",,.01,Posted,336.75',
);

describe('date conversion', () => {
  it('converts M/D/YYYY to YYYY-MM-DD, including single-digit month and day', () => {
    const result = parseAacuCsv(csv('"XXXX1465-0050",8/6/2026,,"WHOLEFDS GWU",23.61,,Posted,197.49'));
    expect(ordinaries(result)[0]?.date).toBe('2026-08-06');
  });
});

describe('sign comes from which column is populated', () => {
  it('a Debit value is always imported negative', () => {
    const result = parseAacuCsv(
      csv('"XXXX1465-0050",8/14/2026,,"Withdrawal POS #622617041268 WALGREENS STORE 13307 NEW SILVER SPRING Card 7013",37.28,,Posted,270.21'),
    );
    expect(ordinaries(result)[0]?.amountMinor).toBe(-3728);
  });

  it('a Credit value is always imported positive', () => {
    const result = parseAacuCsv(
      csv('"XXXX1465-0050",8/14/2026,,"ACH Deposit:  Deposit ACH AMERICANAIRLINES TYPE: PAYROLL ID: 6131502798",,300.00,Posted,307.49'),
    );
    expect(ordinaries(result)[0]?.amountMinor).toBe(30000);
  });

  it('strips thousands separators', () => {
    const result = parseAacuCsv(csv('"XXXX1465-0050",7/13/2026,,"ACH Deposit: Deposit ACH AMERICANAIRLINES",,"1,234.56",Posted,1234.56'));
    expect(ordinaries(result)[0]?.amountMinor).toBe(123456);
  });
});

describe('a leading-dot decimal (".01", not "0.01")', () => {
  it('parses to 1 minor unit instead of being silently dropped', () => {
    // Regression: parseAmountToMinor (src/lib/money.ts) throws on a bare
    // leading dot with no digit in front of it — copying BECU's amount
    // reader verbatim would make this row vanish as "unreadable" instead
    // of importing the $0.01 dividend.
    const result = parseAacuCsv(
      csv('"XXXX1465-0050",7/1/2026,,"Deposit Dividend 0.050% Annual Percentage Yield Earned 0.06% from 06/01/26 through 06/30/26",,.01,Posted,336.75'),
    );
    const [row] = ordinaries(result);
    expect(row?.amountMinor).toBe(1);
    expect(result.skipped).toEqual([]);
  });
});

describe('the Status column', () => {
  it('skips a Pending row with a clear reason', () => {
    const result = parseAacuCsv(
      csv('"XXXX1465-0050",8/19/2026,,"TRITON SUPERMARK 5411021140 0819131100 623117429371                    11",6.44,,Pending,'),
    );
    expect(result.rows).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('pending, not yet posted by the bank');
  });

  it('still imports a Posted row whose own description contains the word "PENDING"', () => {
    // Uber prints "UBER * PENDING ..." on nine real rows in this file, all
    // of them Posted — the parser must key off the Status column, not
    // scan the description text for that word.
    const result = parseAacuCsv(
      csv('"XXXX1465-0050",7/28/2026,,"Withdrawal POS #2WDCT3IO UBER * PENDING 405 Howard St San CA Card 7013",30.52,,Posted,315.05'),
    );
    expect(result.skipped).toEqual([]);
    expect(ordinaries(result)[0]?.amountMinor).toBe(-3052);
  });
});

describe('a row from a different account is skipped defensively', () => {
  it('is skipped once a first account number is established', () => {
    const result = parseAacuCsv(
      csv(
        '"XXXX1465-0050",8/6/2026,,"WHOLEFDS GWU",23.61,,Posted,197.49',
        '"XXXX9999-0099",8/6/2026,,"SOME OTHER ACCOUNT ROW",10.00,,Posted,100.00',
      ),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('belongs to a different account (XXXX9999-0099)');
  });
});

describe("AACU's own vocabulary stripped into payeeName — generic cleanup happens later, at the route layer", () => {
  it('strips a "Withdrawal POS #..." prefix and trailing "Card NNNN"', () => {
    const result = parseAacuCsv(
      csv('"XXXX1465-0050",8/6/2026,,"Withdrawal POS #621814897641 GIANT FOOD INC #152 COLESVILLE MD Card 7013",23.61,,Posted,197.49'),
    );
    expect(ordinaries(result)[0]?.payeeName).toBe('GIANT FOOD INC #152 COLESVILLE MD');
  });

  it('strips a "Withdrawal Debit Card ... Date MM/DD/YY <auth> Card NNNN" wrapper', () => {
    const result = parseAacuCsv(
      csv(
        '"XXXX1465-0050",8/10/2026,,"Withdrawal Debit Card VENMO *Katherine Atwill New York NY Date 08/10/26 04248186223406310063100 Card 7013",190.00,,Posted,7.49',
      ),
    );
    expect(ordinaries(result)[0]?.payeeName).toBe('VENMO *Katherine Atwill New York NY');
  });

  it('strips an "ACH Deposit:  Deposit ACH" prefix and a "TYPE: ..." tail', () => {
    const result = parseAacuCsv(
      csv(
        '"XXXX1465-0050",8/14/2026,,"ACH Deposit:  Deposit ACH AMERICANAIRLINES TYPE: PAYROLL ID: 6131502798 DATA: DIRECT DEPOSIT CO: Entry Class Code: PPDACH Trace Number: 02100002247189",,300.00,Posted,307.49',
      ),
    );
    expect(ordinaries(result)[0]?.payeeName).toBe('AMERICANAIRLINES');
  });

  it('strips a "Credit/Debit Card Deposit:  Deposit Debit Card ... Date ..." wrapper', () => {
    const result = parseAacuCsv(
      csv(
        '"XXXX1465-0050",7/28/2026,,"Credit/Debit Card Deposit:  Deposit Debit Card VENMO*Sandt Kristine New York City NY Date 07/28/26 14248186209393757937572 Card 7013",,24.57,Posted,70.38',
      ),
    );
    expect(ordinaries(result)[0]?.payeeName).toBe('VENMO*Sandt Kristine New York City NY');
  });

  it('turns a "Deposit Dividend ..." row into the plain payee "Dividend"', () => {
    const result = parseAacuCsv(
      csv(
        '"XXXX1465-0050",7/1/2026,,"Deposit Dividend 0.050% Annual Percentage Yield Earned 0.06% from 06/01/26 through 06/30/26",,.01,Posted,336.75',
      ),
    );
    expect(ordinaries(result)[0]?.payeeName).toBe('Dividend');
  });
});

describe('payeeRaw preserves the full original description', () => {
  it('stores the description verbatim, prefix and all', () => {
    const result = parseAacuCsv(
      csv('"XXXX1465-0050",8/6/2026,,"Withdrawal POS #621814897641 GIANT FOOD INC #152 COLESVILLE MD Card 7013",23.61,,Posted,197.49'),
    );
    expect(ordinaries(result)[0]?.payeeRaw).toBe('Withdrawal POS #621814897641 GIANT FOOD INC #152 COLESVILLE MD Card 7013');
  });
});

describe('the Check column becomes memo', () => {
  it('is null when blank', () => {
    const result = parseAacuCsv(csv('"XXXX1465-0050",8/6/2026,,"WHOLEFDS GWU",23.61,,Posted,197.49'));
    expect(ordinaries(result)[0]?.memo).toBeNull();
  });

  it('is recorded when present', () => {
    const result = parseAacuCsv(csv('"XXXX1465-0050",8/6/2026,1042,"WHOLEFDS GWU",23.61,,Posted,197.49'));
    expect(ordinaries(result)[0]?.memo).toBe('Check 1042');
  });
});

describe('duplicate-looking rows are two real transactions, not one', () => {
  it('imports both identical $2.00 SmartRip-style rows as separate rows with distinct import ids', () => {
    const result = parseAacuCsv(
      csv(
        '"XXXX1465-0050",7/18/2026,,"Withdrawal Debit Card SMARTRIP WASHINGTON DC WASHINGTON DC Date 07/17/26 24445006199500805800331 Card 7013",10.00,,Posted,226.29',
        '"XXXX1465-0050",7/16/2026,,"Withdrawal Debit Card SMARTRIP WASHINGTON DC WASHINGTON DC Date 07/15/26 24445006197500649737667 Card 7013",10.00,,Posted,238.29',
      ),
    );
    const rows = ordinaries(result);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.importId).not.toBe(rows[1]?.importId);
  });
});

describe('provider category', () => {
  it('AACU never supplies one', () => {
    expect(suggestedCategoryName('Groceries')).toBeNull();
    expect(suggestedCategoryName(null)).toBeNull();
    const result = parseAacuCsv(csv('"XXXX1465-0050",8/6/2026,,"WHOLEFDS GWU",23.61,,Posted,197.49'));
    expect(ordinaries(result)[0]?.providerCategory).toBeNull();
  });
});

describe('the real 52-row file', () => {
  it('imports every Posted row, skips the one Pending row, correct currency', () => {
    const result = parseAacuCsv(REAL_FILE);
    expect(result.rowCount).toBe(52);
    expect(result.rows).toHaveLength(51);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toBe('pending, not yet posted by the bank');
    expect(result.currencies).toEqual(['USD']);
  });

  it('every import id is unique, including the repeated SmartRip/Uber rows', () => {
    const result = parseAacuCsv(REAL_FILE);
    const ids = ordinaries(result).map((r) => r.importId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reconciles against the file\'s own running Balance column', () => {
    // Independent ground truth: the file's own Balance column, walked from
    // its own implied opening balance (the oldest posted row's stated
    // balance minus that row's own signed amount) to its closing balance —
    // not derived from the parser at all. See docs/plan.md's PR 13 notes.
    const OPENING_MINOR = 33674; // implied balance before the oldest posted row ($336.74)
    const CLOSING_MINOR = 27021; // the newest posted row's stated balance ($270.21)
    const parsedNet = ordinaries(parseAacuCsv(REAL_FILE)).reduce((sum, r) => sum + r.amountMinor, 0);
    expect(parsedNet).toBe(CLOSING_MINOR - OPENING_MINOR);
    expect(parsedNet).toBe(-6653);
  });
});
