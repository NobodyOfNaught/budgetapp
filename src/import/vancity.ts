// Vancity (Vancouver City Savings Credit Union) chequing statement CSV:
// Date,Description,Debits,Credits,Balance — verified against a real export
// (18 rows, Jul–Aug 2026, CAD).
//
// Shares BECU's split-column shape (src/import/becu.ts), so the sign rule
// and the content-derived import_id carry over unchanged. Three things are
// Vancity's own, all found by analyzing the real file before writing any
// parser code:
//
// 1. DATES ARE `DD-Mon-YYYY` ("18-Aug-2026") — neither the US credit
//    unions' `M/D/YYYY` nor the ISO that Wise/Neo emit. See
//    toIsoDateFromDayMonthName in src/import/dates.ts.
//
// 2. THE MERCHANT NAME IS PRINTED THREE TIMES IN A ROW. Not a typo in the
//    sample and not an artifact of one bad row — every Preauthorized/
//    Payroll row does it: "Preauthorized credit Tangerine Tangerine
//    Tangerine", "Payroll deposit INOVATEC INOVATEC INOVATEC",
//    "Preauthorized payment IND ALL LIFE IN IND ALL LIFE IN IND ALL LIFE
//    IN". Left alone, every payee reads as a stutter and no payee_rule
//    written against the sane name would ever match. Collapsed by
//    detecting the longest REPEATED TAIL (see collapseRepeatedTail) rather
//    than by hardcoding "3", since the repeat count is the bank's business
//    and a two- or four-fold repeat should collapse identically.
//
// 3. THE TRANSACTION-TYPE PREFIX IS UNSEPARATED FREE TEXT. BECU prints
//    "POS Withdrawal - MERCHANT" with a dash to split on; Vancity just
//    runs the type into the name ("Bill payment-online WISE 6154 180470").
//    Where a repeated tail exists the prefix falls out for free — whatever
//    precedes the repetition IS the prefix, no list needed. Only the
//    non-repeating rows need TYPE_PREFIX_RE, and an unrecognized prefix
//    degrades gracefully: it stays in payeeName and the generic
//    cross-provider cleanup at the route layer (src/import/payee-name.ts)
//    still does its pass.
//
// Deliberately NOT handled here: the trailing reference number on bill
// payments ("WISE 6154 180470" -> "WISE"). cleanPayeeName already cuts at
// the first standalone 2+-digit token followed by more tokens, which is
// exactly right for both shapes in this file, so duplicating that rule
// here would be two places to keep in sync for no gain — see PR 9's notes
// in docs/plan.md on the parser/heuristic split.
//
// The Balance column is read but never imported: it's a running total, not
// a transaction. It IS the test suite's ground truth — reconciling every
// row against it is what proves the sign convention is right (see
// test/import/vancity.test.ts).
//
// Pure: no I/O, no DB, no Cloudflare imports.

import { parseAmountToMinor } from '../lib/money';
import { parseCsvRecords } from './csv';
import { toIsoDateFromDayMonthName } from './dates';
import type { ParsedRow, ParseResult, SkippedRow } from './types';

// Vancity is a Canadian credit union and the file carries no currency
// column, same situation as Neo (src/import/neo.ts).
const CURRENCY = 'CAD';

// This provider never sends a category — always null.
export function suggestedCategoryName(_providerCategory: string | null): string | null {
  return null;
}

/** Strips thousands separators before handing off to parseAmountToMinor, which doesn't accept commas. */
function amountMinorOrNull(raw: string): number | null {
  const cleaned = raw.trim().replace(/,/g, '');
  if (cleaned === '') return null;
  try {
    return parseAmountToMinor(cleaned);
  } catch {
    return null;
  }
}

/** Vancity's own transaction-type vocabulary, needed only for rows with no repeated tail to reveal the boundary. */
const TYPE_PREFIX_RE = /^(Preauthorized payment|Preauthorized credit|Bill payment-online|Payroll deposit)\s+/i;

/**
 * Collapses a description whose tail is the same run of words repeated:
 * "Preauthorized credit Tangerine Tangerine Tangerine" -> "Tangerine".
 *
 * Scans left to right for the EARLIEST position whose remaining words are
 * a whole number of repetitions (2+) of some shorter unit, which maximizes
 * what collapses and leaves whatever precedes it as the type prefix. That
 * ordering matters: starting from the right would find "PAD PAD"-style
 * sub-repeats inside a longer unit and mangle the name.
 *
 * Returns null when no repetition exists, so callers can tell "collapsed"
 * apart from "left alone" — "Bill payment-online WISE 6154 180470" has no
 * repeated tail and must survive untouched.
 */
function collapseRepeatedTail(description: string): string | null {
  const words = description.split(/\s+/).filter((w) => w !== '');
  for (let start = 0; start < words.length; start++) {
    const tail = words.slice(start);
    for (let unit = 1; unit <= tail.length / 2; unit++) {
      if (tail.length % unit !== 0) continue;
      if (tail.every((word, i) => word === tail[i % unit])) {
        return tail.slice(0, unit).join(' ');
      }
    }
  }
  return null;
}

/** Vancity's own vocabulary stripped — nothing more. The generic cross-provider cleanup runs later, at the route layer. */
function vancityPayeeName(description: string): string {
  return collapseRepeatedTail(description) ?? description.replace(TYPE_PREFIX_RE, '').trim();
}

export function parseVancityCsv(csvText: string): ParseResult {
  const records = parseCsvRecords(csvText);
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const currencies = new Set<string>();

  // Same reasoning as BECU's: this format has no transaction-id column, so
  // otherwise-identical rows (the two $10.00 Tangerine payments here are
  // only saved by falling in different months) need an occurrence counter
  // to avoid colliding under the partial unique index on
  // (account_id, import_id) and being silently dropped as duplicates.
  const occurrenceCount = new Map<string, number>();

  records.forEach((record, index) => {
    const description = (record['Description'] ?? '').trim();
    const reference = description || `(row ${index + 2})`; // +2: 1-based, plus the header row

    const date = toIsoDateFromDayMonthName(record['Date'] ?? '');
    if (date === null) {
      skipped.push({ reference, reason: 'unrecognized date' });
      return;
    }

    // Which column is populated decides the sign — never the printed
    // character. Same defensive read as BECU's.
    const debit = amountMinorOrNull(record['Debits'] ?? '');
    const credit = amountMinorOrNull(record['Credits'] ?? '');
    let amountMinor: number;
    if (debit !== null) {
      amountMinor = -Math.abs(debit);
    } else if (credit !== null) {
      amountMinor = Math.abs(credit);
    } else {
      skipped.push({ reference, reason: 'neither Debits nor Credits had a readable amount' });
      return;
    }

    const dedupeKey = `${date}|${amountMinor}|${description}`;
    const occurrence = occurrenceCount.get(dedupeKey) ?? 0;
    occurrenceCount.set(dedupeKey, occurrence + 1);

    currencies.add(CURRENCY);
    rows.push({
      kind: 'ordinary',
      importId: `${dedupeKey}|${occurrence}`,
      date,
      amountMinor,
      currencyCode: CURRENCY,
      payeeRaw: description || null,
      payeeName: description ? vancityPayeeName(description) : null,
      memo: null,
      providerCategory: null,
    });
  });

  return {
    rows,
    skipped,
    currencies: [...currencies].sort(),
    rowCount: records.length,
  };
}
