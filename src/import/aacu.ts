// AACU statement CSV:
// "Account Number,Post Date,Check,Description,Debit,Credit,Status,Balance"
// — verified against a real export.
//
// Close to BECU's shape (src/import/becu.ts) — same M/D/YYYY dates, same
// column-presence-decides-sign rule, same one-free-text-description
// problem — but two things about this format are AACU's own and drive
// what's different here:
//
// 1. A "Status" COLUMN (Posted / Pending). A pending row's description is
//    printed in a completely different shape than the same transaction
//    once posted (no "Withdrawal POS #… / … Card NNNN" wrapper at all —
//    just the raw merchant string), so a pending row can never dedupe
//    against its own later posted version under a content-derived
//    import_id. Pending rows are skipped, not imported as uncleared —
//    see docs/plan.md's PR 13 notes for why.
// 2. DIVIDEND CREDITS PRINT AS ".01", NOT "0.01". parseAmountToMinor
//    (src/lib/money.ts) requires a digit before the decimal point and
//    throws on a bare leading dot — copying BECU's amount reader verbatim
//    would silently drop every dividend row as "unreadable". Fixed by
//    normalizing a leading dot before parsing.
//
// Pure: no I/O, no DB, no Cloudflare imports.

import { parseAmountToMinor } from '../lib/money';
import { parseCsvRecords } from './csv';
import { toIsoDate } from './dates';
import type { ParsedRow, ParseResult, SkippedRow } from './types';

// This provider never sends a category — always null, same as BECU.
// Categorization is the payee-rules layer's job (src/import/rules.ts),
// which already applies above every provider.
export function suggestedCategoryName(_providerCategory: string | null): string | null {
  return null;
}

const LEADING_DOT_RE = /^-?\.\d+$/;

/** Strips thousands separators and normalizes a leading-dot decimal (".01" -> "0.01") before parseAmountToMinor, which accepts neither. */
function amountMinorOrNull(raw: string): number | null {
  let cleaned = raw.trim().replace(/,/g, '');
  if (cleaned === '') return null;
  if (LEADING_DOT_RE.test(cleaned)) {
    cleaned = cleaned.startsWith('-') ? `-0${cleaned.slice(1)}` : `0${cleaned}`;
  }
  try {
    return parseAmountToMinor(cleaned);
  } catch {
    return null;
  }
}

// Prefixes AACU prints ahead of the merchant, and the tails it appends —
// prototyped against a real 52-row export; every posted row's leftover
// text is a recognizable merchant name after these come off. Nothing here
// is provider-agnostic cleanup (that's cleanPayeeName, applied centrally
// at the route layer) — only AACU's own known vocabulary.
const TYPE_PREFIX_RE =
  /^(Recurring Withdrawal Bill Payment\s*-\s*#\S+|Recurring Withdrawal Debit Card|Withdrawal Debit Card|Withdrawal POS\s*#\S+|Withdrawal ACH|ACH Deposit:\s*Deposit ACH|Credit\/Debit Card Deposit:\s*Deposit Debit Card)\s*/i;
const CARD_TAIL_RE = /\s*Card\s+\d{4}\s*$/i;
const AUTH_TAIL_RE = /\s*Date\s+\d{2}\/\d{2}\/\d{2}\s+\d{6,}.*$/i;
const ACH_TAIL_RE = /\s*TYPE:\s.*$/i;
const DIVIDEND_RE = /^Deposit Dividend\b/i;

/** AACU's own vocabulary stripped — nothing more. See the file header. */
function aacuPayeeName(description: string): string {
  if (DIVIDEND_RE.test(description)) return 'Dividend';
  return description.replace(TYPE_PREFIX_RE, '').replace(CARD_TAIL_RE, '').replace(AUTH_TAIL_RE, '').replace(ACH_TAIL_RE, '').trim();
}

export function parseAacuCsv(csvText: string): ParseResult {
  const records = parseCsvRecords(csvText);
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const currencies = new Set<string>();

  // Same collision-avoidance as BECU (see that file's header) — this
  // export has repeated same-day, same-amount SMARTRIP and UBER rows that
  // would otherwise collide under the partial unique index.
  const occurrenceCount = new Map<string, number>();

  // AACU exports one account per file; this is defensive, not something
  // the sample file needs — but silently merging two accounts' rows into
  // one register is a severe, invisible error, while a visible skip line
  // is cheap insurance against it.
  let firstAccountNumber: string | null = null;

  records.forEach((record, index) => {
    const date = toIsoDate(record['Post Date'] ?? '');
    const description = (record['Description'] ?? '').trim();
    const reference = description || `(row ${index + 2})`; // +2: 1-based, plus the header row

    const accountNumber = (record['Account Number'] ?? '').trim();
    if (firstAccountNumber === null) firstAccountNumber = accountNumber;
    if (accountNumber !== firstAccountNumber) {
      skipped.push({ reference, reason: `belongs to a different account (${accountNumber})` });
      return;
    }

    if ((record['Status'] ?? '').trim().toLowerCase() === 'pending') {
      skipped.push({ reference, reason: 'pending, not yet posted by the bank' });
      return;
    }

    if (date === null) {
      skipped.push({ reference, reason: 'unrecognized date' });
      return;
    }

    const debit = amountMinorOrNull(record['Debit'] ?? '');
    const credit = amountMinorOrNull(record['Credit'] ?? '');
    let amountMinor: number;
    if (debit !== null) {
      amountMinor = -Math.abs(debit);
    } else if (credit !== null) {
      amountMinor = Math.abs(credit);
    } else {
      skipped.push({ reference, reason: 'neither Debit nor Credit had a readable amount' });
      return;
    }

    const dedupeKey = `${date}|${amountMinor}|${description}`;
    const occurrence = occurrenceCount.get(dedupeKey) ?? 0;
    occurrenceCount.set(dedupeKey, occurrence + 1);

    const checkNumber = (record['Check'] ?? '').trim();

    currencies.add('USD');
    rows.push({
      kind: 'ordinary',
      importId: `${dedupeKey}|${occurrence}`,
      date,
      amountMinor,
      currencyCode: 'USD',
      payeeRaw: description || null,
      payeeName: description ? aacuPayeeName(description) : null,
      memo: checkNumber ? `Check ${checkNumber}` : null,
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
