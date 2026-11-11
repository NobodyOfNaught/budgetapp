// BECU's CURRENT export: a spreadsheet-style download with the columns
//
//   Date, Description, Original Description, Amount, Type, Parent Category,
//   Category, Account, Tags, Memo, Pending
//
// BECU replaced the older `Date, No., Description, Debit, Credit` download
// (src/import/becu.ts, which stays for the history already imported) with
// this one, so the two are separate providers rather than one parser that
// guesses. Verified against a real 82-line export.
//
// Four decisions, each driven by something in that file:
//
// 1. THE CATEGORY COLUMNS ARE DELIBERATELY NEVER READ. `Parent Category`
//    and `Category` carry BECU's own guesses ("Travel / Rental Car & Taxi",
//    and a lot of "Uncategorized"), and the owner does not trust them: every
//    row arrives uncategorised, for payee rules and the owner to decide.
//    `providerCategory` is always null and the suggester always returns
//    null, so there is no path by which a BECU category reaches a row.
//
// 2. PENDING ROWS ARE SKIPPED, BY NAME. A pending Lyft hold appears with
//    its own amount and description and later reappears as the posted
//    charge, often with a different amount and description. Importing it
//    would leave a phantom row beside the real one. Each is reported in
//    `skipped` with the reason, so it is visible rather than lost, and the
//    posted version imports on a later export.
//
// 3. THE SIGN COMES FROM `Type`, NOT FROM `Amount`. `Amount` is always
//    printed unsigned ("12.52" for a Debit, "1.53" for a Credit), so the
//    column says how much and `Type` says which way.
//
// 4. THERE IS STILL NO TRANSACTION ID. The id is built from content, with
//    an occurrence counter so two genuinely identical rows on one day (the
//    real file has two $70.80 Zelle payments on 8/2) get distinct ids
//    instead of the second being dropped as a duplicate — see becu.ts.
//
// `Original Description` (the bank's own text, with its "POS Withdrawal - "
// style type prefix) goes in `payeeRaw`, because that is what the owner's
// existing payee_rules were written against. `Description` is NOT used: it
// is a third-party cleanup that changes between exports.
//
// Pure: no I/O, no DB, no Cloudflare imports.

import { parseAmountToMinor } from '../lib/money';
import { parseCsvRecords } from './csv';
import type { ParsedRow, ParseResult, SkippedRow } from './types';

// Never suggests anything — see decision 1. Kept as a function only because
// every provider registers one in src/import/index.ts.
export function suggestedCategoryName(_providerCategory: string | null): string | null {
  return null;
}

// This export prints two-digit years ("11/11/26"), unlike the older BECU
// and AACU downloads, so the shared M/D/YYYY helper in dates.ts does not
// apply. 20xx is assumed: a bank statement is never from the 1900s.
const SHORT_US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/;

function toIsoDate(raw: string): string | null {
  const m = SHORT_US_DATE_RE.exec(raw.trim());
  if (!m) return null;
  const [, month, day, year] = m;
  return `20${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
}

const TYPE_PREFIX_RE =
  /^(External Withdrawal|External Deposit|POS Withdrawal|POS Deposit|Transfer Withdrawal|Transfer Deposit|Descriptive Withdrawal|NSF)\s*-\s*/i;
const CARD_SUFFIX_RE = /\s*-\s*Card Ending In\s*\d+\s*$/i;

/** The bank's own vocabulary stripped, nothing more; the shared cleanPayeeName heuristic runs later at the route layer. */
function payeeNameFrom(original: string): string {
  return original.replace(TYPE_PREFIX_RE, '').replace(CARD_SUFFIX_RE, '').trim();
}

function amountMinorOrNull(raw: string): number | null {
  const cleaned = raw.trim().replace(/,/g, '');
  if (cleaned === '') return null;
  try {
    return parseAmountToMinor(cleaned);
  } catch {
    return null;
  }
}

export function parseBecuExportCsv(csvText: string): ParseResult {
  const records = parseCsvRecords(csvText);
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const currencies = new Set<string>();
  const occurrenceCount = new Map<string, number>();

  // One file, one account. An export that mixes several would silently put
  // another account's money into this one, so refuse the whole file rather
  // than guess which rows belong — the caller reports an unparseable file.
  const accountsInFile = new Set(records.map((r) => (r['Account'] ?? '').trim()).filter((a) => a !== ''));
  if (accountsInFile.size > 1) {
    throw new Error(`file mixes ${accountsInFile.size} accounts: ${[...accountsInFile].join(', ')}`);
  }

  records.forEach((record, index) => {
    const original = (record['Original Description'] ?? '').trim();
    const reference = original || (record['Description'] ?? '').trim() || `(row ${index + 2})`; // +2: 1-based, plus the header row

    if ((record['Pending'] ?? '').trim().toLowerCase() === 'true') {
      skipped.push({ reference, reason: 'pending — will import once it posts' });
      return;
    }

    const date = toIsoDate(record['Date'] ?? '');
    if (date === null) {
      skipped.push({ reference, reason: 'unrecognized date' });
      return;
    }

    const magnitude = amountMinorOrNull(record['Amount'] ?? '');
    const type = (record['Type'] ?? '').trim().toLowerCase();
    if (magnitude === null || (type !== 'debit' && type !== 'credit')) {
      skipped.push({ reference, reason: 'no readable Amount and Debit/Credit Type' });
      return;
    }
    const amountMinor = type === 'debit' ? -Math.abs(magnitude) : Math.abs(magnitude);

    const dedupeKey = `${date}|${amountMinor}|${original}`;
    const occurrence = occurrenceCount.get(dedupeKey) ?? 0;
    occurrenceCount.set(dedupeKey, occurrence + 1);

    currencies.add('USD');
    rows.push({
      kind: 'ordinary',
      importId: `${dedupeKey}|${occurrence}`,
      date,
      amountMinor,
      currencyCode: 'USD',
      payeeRaw: original || null,
      payeeName: original ? payeeNameFrom(original) : null,
      memo: null,
      providerCategory: null,
    });
  });

  return { rows, skipped, currencies: [...currencies].sort(), rowCount: records.length };
}
