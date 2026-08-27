// Wise balance statement, JSON form — what the Wise API returns from
//   GET /v1/profiles/{p}/balance-statements/{b}/statement.json
//
// This is a DIFFERENT format from ./wise.ts, which parses the CSV the Wise
// web UI exports. The two share a vendor and nothing else: the web export
// has ID / Direction / "Source amount (after fees)"; the API has
// referenceNumber / type / amount / runningBalance / details.type. Both
// parsers exist because both files exist, not because one supersedes the
// other — a statement downloaded by hand still needs ./wise.ts.
//
// Four properties of the JSON drive this parser, all verified against a
// full year of a real account (309 rows across a CAD and a USD balance):
//
// 1. `amount.value` IS THE BALANCE IMPACT, FEES INCLUDED. Chaining it
//    through `runningBalance` reproduces every row exactly and lands on
//    `endOfStatementBalance`. The CSV parser's reconstruction of a true
//    debit (post-fee amount + fee charged on top) has no analogue here and
//    must not be re-invented: adding `totalFees` again would double-count.
//
// 2. `details.type` IS AN EXPLICIT DISCRIMINATOR. CARD / MONEY_ADDED /
//    DEPOSIT / TRANSFER. This replaces the CSV parser's inference from
//    whether the source and target NAMES match, which is the heuristic that
//    misclassified a real 1900.00 CAD top-up as an internal conversion (see
//    ./wise.ts's header). A top-up is now simply MONEY_ADDED.
//
// 3. ONE referenceNumber CAN COVER SEVERAL ROWS OF ONE BALANCE, and they
//    are not necessarily adjacent or even same-day. Three distinct causes
//    were found in real data, and they must NOT be merged:
//      - a tip posting separately from the base charge
//        (CARD-4070294539: -3.00 then -15.93, a day apart, of an 18.93 fare)
//      - an over-authorisation later partly refunded
//        (CARD-4113574733: +11.70 CREDIT and -160.88 DEBIT, netting -149.18)
//      - a transfer that was returned
//        (TRANSFER-2247430954: -4.95 on Jul 13, +4.95 on Jul 21, net zero)
//    The last one is why this parser emits one transaction PER ROW rather
//    than netting a group: the money really was gone for eight days, and
//    collapsing it to zero would make the daily net-worth chart claim
//    otherwise. Per-row emission is also exactly what `runningBalance`
//    validates, so correctness is structural rather than argued.
//
// 4. A CARD PURCHASE CAN DRAW ON TWO BALANCES. Then each balance's
//    statement carries its own row for its own share, and `details.amount`
//    holds the FULL purchase while `exchangeDetails.toAmount` holds only
//    this leg's contribution (CARD-4145111585: -15.77 CAD funding 11.18 of
//    a 34.50 USD purchase, the other 23.32 USD coming from the USD
//    balance). Both rows are emitted as ordinary spending on their own
//    accounts, which is what actually happened to the money; the memo says
//    so, since the description on both rows names the full amount.
//
// Pure: no I/O, no DB, no Cloudflare imports.

import { parseAmountToMinor } from '../lib/money';
import type { ParsedOrdinary, ParseResult, SkippedRow } from './types';

/**
 * Wise's `details.category` on a card row is an MCC description, not the
 * short label the web-UI CSV carries ("Groceries", "Eating out"). So this
 * map is deliberately NOT shared with ./wise.ts — the vocabularies do not
 * overlap, and pointing the CSV's map at this data would match nothing.
 *
 * Keys are matched by prefix, because Wise truncates the description at
 * roughly 32 characters ("Service Stations (with or withou", "Computer
 * Network/Information Ser"), so an exact-match table would silently miss
 * the long ones. Only confident mappings are listed; anything absent is
 * left for the user to pick in review rather than guessed at. A suggestion
 * either way — the review screen always allows overriding it.
 */
const CATEGORY_SUGGESTIONS: [prefix: string, category: string][] = [
  ['Grocery Stores', 'Groceries'],
  ['Miscellaneous Food Stores', 'Groceries'],
  ['Bakeries', 'Groceries'],
  ['Wholesale Clubs', 'Groceries'],
  ['Package Stores, Beer, Wine', 'Groceries'],
  ['Eating Places, Restaurants', 'Dining Out'],
  ['Fast Food Restaurants', 'Dining Out'],
  ['Drug Stores, Pharmacies', 'Medical'],
  ['Service Stations', 'Transportation'],
  ['Fuel Dispenser', 'Transportation'],
  ['Limousines', 'Transportation'],
  ['Transportation Suburban and Loca', 'Transportation'],
  ['Transportation Services not else', 'Transportation'],
  ['Automobile Parking Lots', 'Transportation'],
  ['Automotive Parts', 'Transportation'],
  ['Electric Utilities', 'Utilities'],
  ['Cable, Satellite', 'Utilities'],
  ['Dance Halls, Schools', 'Fun Money'],
  ['Bands, Orchestras', 'Fun Money'],
  ['Theatrical Producers', 'Fun Money'],
  ['Tourist Attractions', 'Fun Money'],
  ['Digital Goods', 'Fun Money'],
  ['Book Stores', 'Fun Money'],
];

/** The seeded category NAME suggested for a provider category label, or null when there's no confident match. */
export function suggestedCategoryName(providerCategory: string | null): string | null {
  if (!providerCategory) return null;
  const match = CATEGORY_SUGGESTIONS.find(([prefix]) => providerCategory.startsWith(prefix));
  return match ? match[1] : null;
}

interface WiseMoney {
  value: number;
  currency: string;
}

interface WiseJsonTransaction {
  type?: string;
  date?: string;
  amount?: WiseMoney;
  totalFees?: WiseMoney;
  details?: {
    type?: string;
    description?: string;
    /** The FULL purchase amount on a card row, which is not this row's share when two balances funded it. */
    amount?: WiseMoney;
    category?: string;
    merchant?: { name?: string };
  };
  exchangeDetails?: { toAmount?: WiseMoney; fromAmount?: WiseMoney; rate?: number } | null;
  runningBalance?: WiseMoney;
  referenceNumber?: string;
}

interface WiseJsonStatement {
  transactions?: WiseJsonTransaction[];
  startOfStatementBalance?: WiseMoney;
  endOfStatementBalance?: WiseMoney;
}

/**
 * Wise sends amounts as JSON numbers (-5.62), not strings. Routing them
 * through the shared string parser rather than `Math.round(value * 100)`
 * keeps one definition of "how a decimal becomes minor units" in the
 * codebase; `String(-5.62)` round-trips exactly, so nothing is lost.
 *
 * Note this fixes 2 decimal places, matching the rest of the app. A
 * zero-decimal currency (JPY) would be off by 100x — the app has that
 * assumption baked in well beyond this parser (see lib/money.ts), so it is
 * flagged rather than special-cased here.
 */
function moneyToMinor(money: WiseMoney): number {
  return parseAmountToMinor(String(money.value));
}

/**
 * The counterparty, from whichever field actually holds one.
 *
 * Card rows carry a structured `details.merchant.name` and need no
 * cleanup. Everything else only has a sentence, so the name is lifted out
 * of it — "Sent money to Katherine Obear Atwill", "Received money from
 * Kristine Sandt with reference ". A top-up has no counterparty at all
 * ("Topped up account"), so it gets none rather than a fabricated one.
 */
function counterparty(row: WiseJsonTransaction): string | null {
  const merchant = row.details?.merchant?.name;
  if (merchant) return merchant;

  const description = row.details?.description ?? '';
  const sent = /^Sent money to (.+?)(?: with reference\b.*)?$/.exec(description);
  if (sent?.[1]) return sent[1].trim();
  const received = /^Received money from (.+?)(?: with reference\b.*)?$/.exec(description);
  if (received?.[1]) return received[1].trim();
  return null;
}

/** Extra context the amount alone doesn't carry: what a card row's full purchase was when this balance only funded part of it, and the FX leg on a conversion. */
function buildMemo(row: WiseJsonTransaction): string | null {
  const parts: string[] = [];
  const amount = row.amount;
  const full = row.details?.amount;
  const leg = row.exchangeDetails?.toAmount;

  // Only worth saying when this row is a PARTIAL share of a bigger
  // purchase — i.e. the leg it funded is smaller than the whole. Every
  // other card row's description already states the full amount correctly.
  if (full && leg && moneyToMinor(leg) !== moneyToMinor(full)) {
    parts.push(
      `Part of ${full.value} ${full.currency} — this balance funded ${leg.value} ${leg.currency}`,
    );
  } else if (row.exchangeDetails?.fromAmount && row.exchangeDetails.toAmount && amount) {
    const { fromAmount, toAmount } = row.exchangeDetails;
    // A top-up or conversion: the other side is real information the
    // amount column cannot show, since it is in a different currency.
    if (fromAmount.currency !== amount.currency) {
      parts.push(`${fromAmount.value} ${fromAmount.currency} → ${toAmount.value} ${toAmount.currency}`);
    }
  }

  const fees = row.totalFees;
  if (fees && moneyToMinor(fees) !== 0) {
    // Stated, not subtracted: `amount.value` already includes it.
    parts.push(`incl. ${fees.value} ${fees.currency} fee`);
  }

  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * Stable per-account dedupe key.
 *
 * `referenceNumber` alone is NOT unique — it collided on 34 of 293 rows in
 * real data (see the header's point 3). The full timestamp disambiguates
 * the siblings and was unique across every row of both real statements,
 * while staying independent of neighbouring rows, so re-fetching a
 * different window produces the same key for the same row.
 */
function importIdFor(row: WiseJsonTransaction): string {
  return `${row.referenceNumber}:${row.date}`;
}

export function parseWiseJson(fileText: string): ParseResult {
  let statement: WiseJsonStatement;
  try {
    statement = JSON.parse(fileText) as WiseJsonStatement;
  } catch {
    throw new Error('not a Wise JSON statement: file is not valid JSON');
  }

  const transactions = statement.transactions;
  if (!Array.isArray(transactions)) {
    throw new Error('not a Wise JSON statement: no `transactions` array');
  }

  const rows: ParsedOrdinary[] = [];
  const skipped: SkippedRow[] = [];
  const currencies = new Set<string>();

  for (const row of transactions) {
    const reference = row.referenceNumber ?? '(no reference)';

    if (!row.referenceNumber || !row.date || !row.amount) {
      skipped.push({ reference, reason: 'missing referenceNumber, date or amount' });
      continue;
    }

    const amountMinor = moneyToMinor(row.amount);
    currencies.add(row.amount.currency);

    const name = counterparty(row);
    rows.push({
      kind: 'ordinary',
      importId: importIdFor(row),
      date: row.date.slice(0, 10),
      amountMinor,
      currencyCode: row.amount.currency,
      // payeeRaw is ALWAYS the full description, never the extracted name.
      // That is the contract in ./types.ts and it matters here more than in
      // most parsers: a card row's description carries the merchant town
      // and the original-currency amount ("Card transaction of 4.04 USD
      // issued by Usps Po 2384810904 SILVER SPRING") that `counterparty`
      // deliberately drops, and a payee_rule must still be able to match on
      // any of it. Only when there is no description at all does the
      // merchant name stand in as the rawest text available.
      payeeRaw: row.details?.description ?? name,
      payeeName: name,
      memo: buildMemo(row),
      providerCategory: row.details?.category ?? null,
    });
  }

  return {
    rows,
    skipped,
    currencies: [...currencies],
    rowCount: transactions.length,
  };
}

/**
 * Independent check that the parsed rows reproduce the balance Wise itself
 * reports, using `runningBalance`/`endOfStatementBalance` — information no
 * other statement format in this repo provides.
 *
 * Returns null when the statement is internally consistent, or a
 * description of the discrepancy. Wise lists newest-first, so the sum of
 * every row's amount added to `startOfStatementBalance` must equal
 * `endOfStatementBalance` regardless of order.
 */
export function checkStatementBalance(fileText: string): string | null {
  const statement = JSON.parse(fileText) as WiseJsonStatement;
  const { startOfStatementBalance: start, endOfStatementBalance: end, transactions } = statement;
  if (!start || !end || !Array.isArray(transactions)) return null;

  const movement = transactions.reduce((sum, row) => sum + (row.amount ? moneyToMinor(row.amount) : 0), 0);
  const expected = moneyToMinor(start) + movement;
  const actual = moneyToMinor(end);
  if (expected === actual) return null;
  return `statement does not balance: ${start.value} + movement != ${end.value} (off by ${(actual - expected) / 100})`;
}
