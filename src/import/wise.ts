// Wise (formerly TransferWise) statement CSV.
//
// Three things about this format drive the whole parser, all verified
// against a real export:
//
// 1. ONE PURCHASE CAN SPAN SEVERAL ROWS SHARING AN ID. When a card payment
//    is funded from more than one currency balance, Wise emits one row per
//    balance it drew from. CARD_TRANSACTION-4145111585 appears twice —
//    15.70 CAD -> 11.18 USD and 23.32 USD -> 23.32 USD — which is a single
//    $34.50 purchase, not a duplicate. Deduplicating on the ID column alone
//    would silently drop real money, so rows are GROUPED by id and the
//    foreign-funded portion becomes an explicit transfer between the user's
//    own balances (see docs/plan.md's PR 7 notes for the worked example).
//
// 2. FEES ARE EXCLUDED FROM THE AMOUNT COLUMNS. "Source amount (after
//    fees)" is post-fee: 1136.36 CAD x 0.704002 = exactly 800.00 USD, with
//    the 5.76 CAD fee charged on top. The true balance impact is therefore
//    amount + fee, which is what this parser emits.
//
// 3. SOURCE AND TARGET SWAP MEANING WITH DIRECTION. On an OUT row the
//    target is the merchant; on an IN row the source is the payer. A row
//    whose source and target names are the SAME is the user moving money
//    between their own balances — a conversion, not a payment.
//
// Pure: no I/O, no DB, no Cloudflare imports.

import { parseAmountToMinor } from '../lib/money';
import { parseCsvRecords } from './csv';
import type { ParsedRow, ParseResult, SkippedRow } from './types';

/**
 * Wise's own Category column mapped onto the category names seeded by
 * src/budget/seed.ts. Only confident matches are listed — anything absent
 * (General, Money added, Personal care, ...) is left for the user to pick
 * in review rather than guessed at. Purely a suggestion either way: the
 * review screen always allows overriding it.
 */
const CATEGORY_SUGGESTIONS: Record<string, string> = {
  Groceries: 'Groceries',
  Transport: 'Transportation',
  'Eating out': 'Dining Out',
  Entertainment: 'Fun Money',
  Bills: 'Utilities',
};

/** The seeded category NAME suggested for a provider category label, or null when there's no confident match. */
export function suggestedCategoryName(providerCategory: string | null): string | null {
  if (!providerCategory) return null;
  return CATEGORY_SUGGESTIONS[providerCategory] ?? null;
}

interface WiseRow {
  id: string;
  status: string;
  direction: string;
  date: string;
  sourceFeeMinor: number;
  sourceFeeCurrency: string;
  sourceName: string;
  sourceMinor: number;
  sourceCurrency: string;
  targetName: string;
  targetMinor: number;
  targetCurrency: string;
  category: string;
  note: string;
}

/** Wise writes plain decimals with a variable number of places ("5.0", "15.70"); blank means zero. */
function amountOrZero(raw: string): number {
  if (raw === '') return 0;
  return parseAmountToMinor(raw);
}

function toRow(record: Record<string, string>): WiseRow {
  // "Finished on" is when the balance actually settled; fall back to
  // "Created on" for rows that never got a finish timestamp.
  const finished = record['Finished on'] ?? '';
  const created = record['Created on'] ?? '';
  const timestamp = finished !== '' ? finished : created;

  return {
    id: record['ID'] ?? '',
    status: (record['Status'] ?? '').toUpperCase(),
    direction: (record['Direction'] ?? '').toUpperCase(),
    date: timestamp.slice(0, 10),
    sourceFeeMinor: amountOrZero(record['Source fee amount'] ?? ''),
    sourceFeeCurrency: record['Source fee currency'] ?? '',
    sourceName: record['Source name'] ?? '',
    sourceMinor: amountOrZero(record['Source amount (after fees)'] ?? ''),
    sourceCurrency: record['Source currency'] ?? '',
    targetName: record['Target name'] ?? '',
    targetMinor: amountOrZero(record['Target amount (after fees)'] ?? ''),
    targetCurrency: record['Target currency'] ?? '',
    category: record['Category'] ?? '',
    note: record['Note'] ?? '',
  };
}

/** The full amount that left the source balance: the post-fee amount plus the fee Wise charged on top of it. */
function sourceDebitMinor(row: WiseRow): number {
  // The fee is only part of this debit when it was charged in the same
  // currency as the source balance — which it always is in practice, but
  // the columns allow otherwise, so don't assume.
  const fee = row.sourceFeeCurrency === row.sourceCurrency ? row.sourceFeeMinor : 0;
  return row.sourceMinor + fee;
}

function isOwnTransfer(row: WiseRow): boolean {
  return row.sourceName !== '' && row.sourceName === row.targetName;
}

export function parseWiseCsv(csvText: string): ParseResult {
  const records = parseCsvRecords(csvText);
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const currencies = new Set<string>();

  // --- Status filter, before any grouping ---------------------------------
  const kept: WiseRow[] = [];
  for (const record of records) {
    let row: WiseRow;
    try {
      row = toRow(record);
    } catch {
      skipped.push({ reference: record['ID'] ?? '(unknown)', reason: 'could not read the amounts on this row' });
      continue;
    }
    if (row.id === '' || row.date === '') {
      skipped.push({ reference: row.id || '(unknown)', reason: 'missing an id or a date' });
      continue;
    }

    if (row.status === 'COMPLETED') {
      kept.push(row);
      continue;
    }
    // An inbound refund is real money coming back and has to be imported or
    // the balance ends up wrong. An OUTBOUND refund is a transfer that
    // bounced — the money left and returned, with no separate return row in
    // the export — so importing it would double-count the outflow.
    if (row.status === 'REFUNDED' && row.direction === 'IN') {
      kept.push(row);
      continue;
    }
    if (row.status === 'REFUNDED') {
      skipped.push({ reference: row.id, reason: 'outbound transfer was refunded (reversed)' });
      continue;
    }
    skipped.push({ reference: row.id, reason: `status is ${row.status || '(blank)'}, not completed` });
  }

  // --- Group by id: several rows can be one purchase -----------------------
  const groups = new Map<string, WiseRow[]>();
  for (const row of kept) {
    const existing = groups.get(row.id);
    if (existing) existing.push(row);
    else groups.set(row.id, [row]);
  }

  for (const [id, legs] of groups) {
    const first = legs[0]!;

    // Money the user moved between their own balances — a conversion, not a
    // payment. Emitted per leg, since each leg is its own movement.
    if (isOwnTransfer(first)) {
      for (const leg of legs) {
        currencies.add(leg.sourceCurrency);
        currencies.add(leg.targetCurrency);
        rows.push({
          kind: 'transfer',
          importId: `${id}:${leg.sourceCurrency}`,
          date: leg.date,
          fromAmountMinor: -sourceDebitMinor(leg),
          fromCurrencyCode: leg.sourceCurrency,
          toAmountMinor: leg.targetMinor,
          toCurrencyCode: leg.targetCurrency,
          memo: leg.note || null,
        });
      }
      continue;
    }

    if (first.direction === 'IN') {
      // Money arriving from someone else. The payer is the SOURCE side.
      currencies.add(first.targetCurrency);
      rows.push({
        kind: 'ordinary',
        importId: id,
        date: first.date,
        amountMinor: first.targetMinor,
        currencyCode: first.targetCurrency,
        // Wise's own Source/Target name fields are already clean —
        // payeeName equals payeeRaw rather than running any Wise-specific
        // stripping (there's nothing here to strip).
        payeeRaw: first.sourceName || null,
        payeeName: first.sourceName || null,
        memo: first.note || null,
        providerCategory: first.category || null,
      });
      continue;
    }

    // --- Outbound payment. The merchant is the TARGET side, and the target
    // currency is what the merchant actually charged in. Legs funded from a
    // different balance become transfers into that currency, so the
    // purchase itself can carry its true full value.
    const primaryCurrency = first.targetCurrency;
    if (legs.some((leg) => leg.targetCurrency !== primaryCurrency)) {
      skipped.push({ reference: id, reason: 'the parts of this payment settled in different currencies' });
      continue;
    }
    currencies.add(primaryCurrency);

    let purchaseMinor = 0;
    for (const leg of legs) {
      purchaseMinor += leg.targetMinor;

      if (leg.sourceCurrency === primaryCurrency) {
        // Funded from the same balance the merchant charged: any fee on it
        // is a straight extra cost of this purchase.
        purchaseMinor += leg.sourceFeeCurrency === primaryCurrency ? leg.sourceFeeMinor : 0;
        continue;
      }

      // Funded from another balance: model it as money moving into the
      // charged currency first, so BOTH balances end up exactly right while
      // the purchase still shows its real total.
      currencies.add(leg.sourceCurrency);
      rows.push({
        kind: 'transfer',
        importId: `${id}:${leg.sourceCurrency}`,
        date: leg.date,
        fromAmountMinor: -sourceDebitMinor(leg),
        fromCurrencyCode: leg.sourceCurrency,
        toAmountMinor: leg.targetMinor,
        toCurrencyCode: primaryCurrency,
        memo: `Converted to cover ${first.targetName}`.trim(),
      });
    }

    rows.push({
      kind: 'ordinary',
      importId: id,
      date: first.date,
      amountMinor: -purchaseMinor,
      currencyCode: primaryCurrency,
      payeeRaw: first.targetName || null,
      payeeName: first.targetName || null,
      memo: first.note || null,
      providerCategory: first.category || null,
    });
  }

  return {
    rows,
    skipped,
    currencies: [...currencies].filter((c) => c !== '').sort(),
    rowCount: records.length,
  };
}
