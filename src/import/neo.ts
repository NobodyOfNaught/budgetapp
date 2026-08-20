// Neo Mastercard (Canadian credit card) statement CSV:
// "Transaction Date,Posted Date,Status,Description,Amount" — verified
// against two real exports.
//
// Two things about this format drive the parser:
//
// 1. THE FILE HAS NO TRANSACTION ID COLUMN, same as BECU/AACU — import_id
//    is built from the row's own content, with an occurrence counter for
//    genuine repeats (this file has three separate HYATT REGENCY DULLES
//    charges).
// 2. A "Status" COLUMN THAT INCLUDES "Declined". A declined charge never
//    happened — the real sample contains a $1,452.51 marina charge that
//    was refused. Importing it would invent debt that doesn't exist.
//    Skipped, same as a Pending row (which — as with AACU — can't dedupe
//    against its own later Posted version, since Posted rows here are
//    identical in shape to Pending ones anyway; skipped defensively for
//    consistency with every other provider's Pending handling).
//
// Unlike BECU/AACU, dates are already ISO (no M/D/YYYY conversion needed),
// and the sign is already this app's own convention: negative = charge,
// positive = payment/credit — verified against every row in both real
// files, so no sign-flipping logic is needed here either.
//
// Amounts are in CAD; converting to the budget's currency (a real rate,
// not 1:1) happens at the route layer (src/routes/imports.ts), not here —
// see docs/plan.md's PR 15 notes.
//
// Pure: no I/O, no DB, no Cloudflare imports.

import { parseAmountToMinor } from '../lib/money';
import { parseCsvRecords } from './csv';
import type { ParsedRow, ParseResult, SkippedRow } from './types';

// This provider never sends a category — always null, same as BECU/AACU.
// Categorization is the payee-rules layer's job (src/import/rules.ts),
// which already applies above every provider.
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

// Neo pads the merchant/city columns to a fixed width and appends a
// 3-letter country code (USA/CAN/PAN in the real files) — the >=2 spaces
// before it is what distinguishes the padded country column from an
// ordinary merchant name that happens to end in 3 capital letters (e.g.
// "... LLC", one space). "Payment Received - Thank you" and
// "Interest Charged" have neither and pass through untouched.
const COUNTRY_TAIL_RE = /\s{2,}[A-Z]{3}$/;

/** Neo's own padding/country-code vocabulary stripped — nothing more. See the file header. */
function neoPayeeName(description: string): string {
  return description.replace(COUNTRY_TAIL_RE, '').replace(/\s{2,}/g, ' ').trim();
}

export function parseNeoCsv(csvText: string): ParseResult {
  const records = parseCsvRecords(csvText);
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const currencies = new Set<string>();

  // Same collision-avoidance as BECU/AACU — this file has three separate
  // HYATT REGENCY DULLES charges that would otherwise collide under the
  // partial unique index.
  const occurrenceCount = new Map<string, number>();

  records.forEach((record, index) => {
    const date = (record['Transaction Date'] ?? '').trim();
    const description = (record['Description'] ?? '').trim();
    const reference = description || `(row ${index + 2})`; // +2: 1-based, plus the header row
    const status = (record['Status'] ?? '').trim().toLowerCase();

    if (status === 'declined') {
      skipped.push({ reference, reason: 'declined — the charge never went through' });
      return;
    }
    if (status === 'pending') {
      skipped.push({ reference, reason: 'pending, not yet posted by the bank' });
      return;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      skipped.push({ reference, reason: 'unrecognized date' });
      return;
    }

    const amountMinor = amountMinorOrNull(record['Amount'] ?? '');
    if (amountMinor === null) {
      skipped.push({ reference, reason: 'Amount was not a readable number' });
      return;
    }

    const dedupeKey = `${date}|${amountMinor}|${description}`;
    const occurrence = occurrenceCount.get(dedupeKey) ?? 0;
    occurrenceCount.set(dedupeKey, occurrence + 1);

    currencies.add('CAD');
    rows.push({
      kind: 'ordinary',
      importId: `${dedupeKey}|${occurrence}`,
      date,
      amountMinor,
      currencyCode: 'CAD',
      payeeRaw: description || null,
      payeeName: description ? neoPayeeName(description) : null,
      memo: null,
      providerCategory: null,
    });
  });

  return {
    rows,
    skipped,
    currencies: [...currencies],
    rowCount: records.length,
  };
}
