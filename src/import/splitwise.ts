// Splitwise expense export: Date,Description,Category,Cost,Currency,<person>,<person>,...
//
// Splitwise isn't a bank — the file has no account and no balance, and it
// isn't shaped like one: each row is a shared expense, and every person's
// column is their NET position change on that row (what they paid minus
// their share), which sums to zero across the row. Two things about that
// shape drive this whole parser:
//
// 1. THE PERSON COLUMNS ARE DYNAMIC, discovered from the header — Splitwise
//    exports whoever is in the group, in whatever order they were added.
//    `options.members` selects which of those columns belong to THIS
//    budget (two housemates might share a budget while splitting rent with
//    two more who don't) — src/routes/imports.ts's POST /imports/inspect
//    exists specifically to surface the discovered names to the UI before
//    a real import happens.
//
// 2. A ROW'S NET FOR THE SELECTED PEOPLE IS THE RIGHT NUMBER TO IMPORT, not
//    their share alone — because some of what they're "owed" back is cash
//    they already spent out of an account this app also imports (BECU/
//    Wise). On a real 284-row export: of $36,708.47 in true household
//    share, only $4,123.94 was ever fronted by the two budget members
//    themselves (62 rows) — the rest was fronted by other housemates and
//    repaid later via settlements. Importing "share" instead of "net"
//    would double-count every one of those 62 rows against the bank
//    import. Importing "net" makes this account a clearing account: a
//    housemate fronting a purchase makes the Splitwise line POSITIVE (the
//    group reimbursing the two budget members) which exactly cancels the
//    portion of the bank charge that wasn't theirs, and the category
//    lands at the true combined share, verified to the cent against the
//    file's own footer.
//
// Settlement rows ("Category" is Payment, or the description says "Settle
// all balances") are imported UNCATEGORIZED on purpose — the matching bank
// outflow paying off that same debt is also uncategorized, so the two net
// to zero in Ready to Assign. Paying back money you already owe isn't a
// new expense.
//
// Pure: no I/O, no DB, no Cloudflare imports.

import { parseAmountToMinor } from '../lib/money';
import { parseCsv, parseCsvRecords } from './csv';
import type { ImportOptions, ParsedRow, ParseResult, SkippedRow } from './types';

const FIXED_COLUMN_COUNT = 5; // Date, Description, Category, Cost, Currency

/**
 * Splitwise's own Category column mapped onto the names src/budget/seed.ts
 * seeds. Only confident matches are listed — "General" (the vaguest and
 * most common label in a real export), "Household supplies", and "Hotel"
 * are deliberately left blank for the user to pick, or better, to write a
 * payee rule for (src/import/rules.ts already applies to every provider).
 */
const CATEGORY_SUGGESTIONS: Record<string, string> = {
  Groceries: 'Groceries',
  'Dining out': 'Dining Out',
  Rent: 'Rent/Mortgage',
  Mortgage: 'Rent/Mortgage',
  'Gas/fuel': 'Transportation',
  Taxi: 'Transportation',
  Electricity: 'Utilities',
  'Heat/gas': 'Utilities',
  Water: 'Utilities',
  Trash: 'Utilities',
  'TV/Phone/Internet': 'Utilities',
  'Entertainment - Other': 'Fun Money',
};

/** The seeded category NAME suggested for a Splitwise category label, or null when there's no confident match. */
export function suggestedCategoryName(providerCategory: string | null): string | null {
  if (!providerCategory) return null;
  return CATEGORY_SUGGESTIONS[providerCategory] ?? null;
}

/** Splitwise writes plain decimals; blank or unreadable means zero, matching a person who wasn't charged on this row. */
function amountOrZero(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim().replace(/,/g, '');
  if (trimmed === '') return 0;
  try {
    return parseAmountToMinor(trimmed);
  } catch {
    return 0;
  }
}

function isSettlementRow(category: string, description: string): boolean {
  return category.trim().toLowerCase() === 'payment' || description.toLowerCase().includes('settle all balances');
}

export function parseSplitwiseCsv(csvText: string, options?: ImportOptions): ParseResult {
  const header = parseCsv(csvText)[0];
  const participants = (header ?? []).slice(FIXED_COLUMN_COUNT).map((h) => h.trim()).filter((h) => h !== '');

  const records = parseCsvRecords(csvText);
  const selectedMembers = options?.members ?? [];

  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const currencies = new Set<string>();
  const occurrenceCount = new Map<string, number>();

  for (const record of records) {
    const date = (record['Date'] ?? '').trim();
    const description = (record['Description'] ?? '').trim();
    const reference = description || '(row with no description)';

    // The file's own trailing "Total balance" line — a summary, not a transaction.
    if (description.toLowerCase() === 'total balance') {
      skipped.push({ reference, reason: 'file total row, not a transaction' });
      continue;
    }
    if (date === '') {
      skipped.push({ reference, reason: 'missing a date' });
      continue;
    }

    const category = (record['Category'] ?? '').trim();
    const currencyCode = (record['Currency'] ?? '').trim() || 'USD';
    const costMinor = amountOrZero(record['Cost']);

    let netMinor = 0;
    for (const member of selectedMembers) {
      netMinor += amountOrZero(record[member]);
    }

    if (netMinor === 0) {
      skipped.push({ reference, reason: 'no net effect on the selected people' });
      continue;
    }

    // Identity is the ROW's own content, deliberately independent of which
    // members are selected — re-importing the same file with a different
    // selection is a no-op rather than a silent double-import; changing
    // the selection means undo, then re-import (see docs/plan.md).
    const dedupeKey = `${date}|${description}|${costMinor}`;
    const occurrence = occurrenceCount.get(dedupeKey) ?? 0;
    occurrenceCount.set(dedupeKey, occurrence + 1);

    const settlement = isSettlementRow(category, description);
    currencies.add(currencyCode);

    rows.push({
      kind: 'ordinary',
      importId: `${dedupeKey}|${occurrence}`,
      date,
      amountMinor: netMinor,
      currencyCode,
      // Splitwise descriptions are already short, human-written text
      // ("July rent", "Groceries") — nothing to strip, so payeeName equals
      // payeeRaw, same as Wise's already-clean fields.
      payeeRaw: description || null,
      payeeName: description || null,
      memo: null,
      providerCategory: settlement ? null : category || null,
    });
  }

  return {
    rows,
    skipped,
    currencies: [...currencies].sort(),
    rowCount: records.length,
    participants,
  };
}
