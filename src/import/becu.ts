// BECU (Boeing Employees Credit Union) statement CSV:
// "Date","No.","Description","Debit","Credit" — verified against a real
// export.
//
// Three things about this format drive the parser, none of them true of
// Wise (src/import/wise.ts):
//
// 1. THERE IS NO TRANSACTION ID COLUMN AT ALL. import_id has to be built
//    from the row's own content — see importId below.
// 2. THE PRINTED SIGN ISN'T TRUSTED. Which column is populated (Debit vs
//    Credit) determines the sign, not whatever character happens to be in
//    front of the number — a defensive read, since nothing about a CSV
//    export format guarantees a bank always prints the minus sign.
// 3. THE DESCRIPTION IS ONE FREE-TEXT FIELD carrying the transaction type,
//    the merchant, an auth code, sometimes a street address, sometimes a
//    phone number — all run together. This parser strips only BECU's own
//    known vocabulary (the leading type word, the trailing "Card Ending
//    In" suffix) into `payeeName`; the generic cross-provider cleanup
//    (address/auth-number/phone stripping) is `cleanPayeeName`
//    (src/import/payee-name.ts), applied centrally at the route layer so
//    every provider gets it, not just this one. The full, untouched
//    description is always preserved in `payeeRaw` for user-defined
//    payee_rules to match against (src/import/rules.ts).
//
// Pure: no I/O, no DB, no Cloudflare imports.

import { parseAmountToMinor } from '../lib/money';
import { parseCsvRecords } from './csv';
import { toIsoDate } from './dates';
import type { ParsedRow, ParseResult, SkippedRow } from './types';

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

const TYPE_PREFIX_RE =
  /^(External Withdrawal|External Deposit|POS Withdrawal|Transfer Withdrawal|Transfer Deposit|NSF)\s*-\s*/i;
const CARD_SUFFIX_RE = /\s*-\s*Card Ending In\s*\d+\s*$/i;

/** BECU's own vocabulary stripped — nothing more. The generic cross-provider cleanup runs later, at the route layer. */
function becuPayeeName(description: string): string {
  return description.replace(TYPE_PREFIX_RE, '').replace(CARD_SUFFIX_RE, '').trim();
}

export function parseBecuCsv(csvText: string): ParseResult {
  const records = parseCsvRecords(csvText);
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const currencies = new Set<string>();

  // Disambiguates otherwise-identical rows (same date/amount/description),
  // which real exports genuinely contain — e.g. two separate $70.80 Zelle
  // payments to the same person on the same day. Without this, the second
  // would collide with the first under the partial unique index on
  // (account_id, import_id) and be silently dropped as a "duplicate",
  // losing real money — the same class of bug Wise's multi-leg purchases
  // exposed (see src/import/wise.ts's file header).
  const occurrenceCount = new Map<string, number>();

  records.forEach((record, index) => {
    const date = toIsoDate(record['Date'] ?? '');
    const description = (record['Description'] ?? '').trim();
    const reference = description || `(row ${index + 2})`; // +2: 1-based, plus the header row

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

    const checkNumber = (record['No.'] ?? '').trim();

    currencies.add('USD');
    rows.push({
      kind: 'ordinary',
      importId: `${dedupeKey}|${occurrence}`,
      date,
      amountMinor,
      currencyCode: 'USD',
      payeeRaw: description || null,
      payeeName: description ? becuPayeeName(description) : null,
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
