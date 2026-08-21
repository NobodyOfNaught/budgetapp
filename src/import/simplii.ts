// Simplii Financial chequing statement CSV:
// `Date, Transaction Details, Funds Out, Funds In ` — verified against a
// real export (20 rows, Mar–Aug 2026, CAD).
//
// The plainest format any provider here has had, and it reuses machinery
// that already exists: BECU's split-column sign rule
// (src/import/becu.ts), the US-style `M/D/YYYY` converter in
// src/import/dates.ts, and the content-derived import_id with an
// occurrence counter that every ID-less bank export needs. Three things
// are worth knowing:
//
// 1. THE HEADER IS SPACE-PADDED — the literal first line is
//    `Date, Transaction Details, Funds Out, Funds In ` (leading space on
//    every column after the first, trailing space on the last). This is
//    handled for free because parseCsvRecords trims header names, but it
//    is exactly the kind of thing that silently yields `undefined` for
//    every lookup if a parser ever reads columns positionally instead, so
//    a test pins it.
//
// 2. THE DATE IS `MM/DD/YYYY`, NOT `DD/MM/YYYY` — worth stating outright
//    because Simplii is a Canadian bank and the Canadian convention would
//    be the other way round. Confirmed from the real file rather than
//    assumed: day components run up to 31, which cannot be a month. Read
//    the wrong way round, `03/17/2026` would be rejected outright but
//    `04/01/2026` would silently land in January — half the file quietly
//    misfiled. A test pins a day > 12 for exactly this reason.
//
// 3. NO BALANCE COLUMN, unlike AACU's and Vancity's chequing exports, so
//    there is no running total to reconcile a parse against. The golden
//    suite's ground truth is instead the hand-summed Funds Out/Funds In
//    totals from the real file (6000.00 out, 5000.00 in, net -1000.00).
//
// Pure: no I/O, no DB, no Cloudflare imports.

import { parseAmountToMinor } from '../lib/money';
import { parseCsvRecords } from './csv';
import { toIsoDate } from './dates';
import type { ParsedRow, ParseResult, SkippedRow } from './types';

// Simplii is a Canadian bank and the file carries no currency column —
// same situation as Neo and Vancity.
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

/**
 * Simplii's own transaction-type vocabulary. Built only from types seen in
 * the real export, the same way BECU's was — a guessed-at list risks
 * eating a real payee name, and an unrecognized prefix costs nothing: it
 * stays in payeeName and the generic cross-provider cleanup at the route
 * layer (src/import/payee-name.ts) still runs over it.
 */
const TYPE_PREFIX_RE = /^(INTERNET BILL PAYMENT|PAYROLL DEPOSIT)\s+/i;

/** Simplii's own vocabulary stripped — nothing more. The generic cross-provider cleanup runs later, at the route layer. */
function simpliiPayeeName(description: string): string {
  return description.replace(TYPE_PREFIX_RE, '').trim();
}

export function parseSimpliiCsv(csvText: string): ParseResult {
  const records = parseCsvRecords(csvText);
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const currencies = new Set<string>();

  // No transaction-id column, so otherwise-identical rows would collide
  // under the partial unique index on (account_id, import_id) and be
  // silently dropped as duplicates. The real sample happens to contain
  // none, but two $500 payroll deposits landing on one date is an
  // entirely ordinary thing for a chequing account.
  const occurrenceCount = new Map<string, number>();

  records.forEach((record, index) => {
    const description = (record['Transaction Details'] ?? '').trim();
    const reference = description || `(row ${index + 2})`; // +2: 1-based, plus the header row

    const date = toIsoDate(record['Date'] ?? '');
    if (date === null) {
      skipped.push({ reference, reason: 'unrecognized date' });
      return;
    }

    // Which column is populated decides the sign — never the printed
    // character. Same defensive read as BECU's and Vancity's.
    const fundsOut = amountMinorOrNull(record['Funds Out'] ?? '');
    const fundsIn = amountMinorOrNull(record['Funds In'] ?? '');
    let amountMinor: number;
    if (fundsOut !== null) {
      amountMinor = -Math.abs(fundsOut);
    } else if (fundsIn !== null) {
      amountMinor = Math.abs(fundsIn);
    } else {
      skipped.push({ reference, reason: 'neither Funds Out nor Funds In had a readable amount' });
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
      payeeName: description ? simpliiPayeeName(description) : null,
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
