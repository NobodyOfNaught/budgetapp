// Vancity Visa credit-card transaction history CSV — verified against two
// real exports (25 rows total, Jun–Aug 2026, CAD).
//
// Despite the shared bank, this has NOTHING in common with the Vancity
// chequing format (src/import/vancity.ts): different columns, different
// date shape, different sign convention. It is a card-processor export,
// closer in spirit to Neo's. Five things drive this parser, all found by
// analyzing the real files before writing any of it:
//
// 1. THE SIGN CONVENTION IS INVERTED relative to this app — and relative
//    to Neo, the other credit card here. A purchase prints POSITIVE
//    ("$31.36") because the card is stating what you owe; a payment prints
//    NEGATIVE ("-$200.00"). This app's convention is the opposite for a
//    credit account: spending makes the balance more negative, a payment
//    less. So every amount is NEGATED. Getting this backwards would not
//    crash anything — it would silently record a year of spending as
//    income, which is precisely why the test suite asserts a payment and a
//    purchase separately rather than only checking a total.
//
// 2. AMOUNTS CARRY A CURRENCY SYMBOL, and the minus sign sits OUTSIDE it
//    ("-$200.00", never "$-200.00"), so the symbol can't simply be
//    stripped from the front.
//
// 3. THERE IS A REAL TRANSACTION ID — "Reference Number" — which no other
//    bank export here has had (BECU/AACU/Neo/Vancity chequing all needed
//    content-derived ids). It arrives wrapped in literal quote characters
//    that survive CSV unescaping ("""24011346229100022196833"""). It is
//    NOT universally present though: bank-generated rows such as
//    "PURCHASE INT. CHARGED" have none, so the content-derived fallback
//    stays for those. The two id shapes are prefixed so they can never
//    collide.
//
// 4. THE MERCHANT CATEGORY IS A REAL PROVIDER CATEGORY. First bank export
//    here to supply one — see CATEGORY_SUGGESTIONS. Only confident
//    mappings are made; an unmapped category yields null and the row lands
//    uncategorized for the user to decide, which is strictly better than
//    guessing (see "Drug Stores and Pharmacies", which has no obvious home
//    in the seeded set).
//
// 5. BANK-GENERATED ROWS SPILL THEIR TEXT INTO "Merchant City". The
//    merchant name is capped around 25 characters, so "PAYMENT RECEIVED --
//    THANK YOU" arrives as name="PAYMENT RECEIVED -- THANK" plus
//    city="YOU". Real merchants have a real city there ("ANTHROPIC*
//    CLAUDE SUB" / "ANTHROPIC.COM"), so joining unconditionally would
//    mangle every ordinary row. The join is gated on the row having
//    neither a Merchant Category nor a Merchant Country — the signature of
//    a row the bank wrote itself rather than a payment terminal.
//
// `Date` is used rather than `Posted Date` (they differ on 20 of 25 rows):
// when the money was spent is what budgeting cares about, matching Neo.
//
// Pure: no I/O, no DB, no Cloudflare imports.

import { parseAmountToMinor } from '../lib/money';
import { parseCsvRecords } from './csv';
import type { ParsedRow, ParseResult, SkippedRow } from './types';

const CURRENCY = 'CAD';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Merchant-category → seeded category name (see src/budget/seed.ts).
 * Deliberately partial: only mappings that are obviously right. Everything
 * else returns null rather than guessing — a wrong auto-category is worse
 * than none, because it lands already-categorized in the review queue and
 * is easy to approve without noticing.
 */
const CATEGORY_SUGGESTIONS: Record<string, string> = {
  'Grocery Stores and Supermarkets': 'Groceries',
  'Eating Places and Restaurants': 'Dining Out',
  'Taxicabs and Limousines': 'Transportation',
  'Motion Picture Theater': 'Fun Money',
  'Dance Halls, Studios and Schools': 'Fun Money',
  'Tourist Attractions and Exhibits': 'Fun Money',
  'Cable, Satellite, and Other Pay Television and Radio Services': 'Subscriptions',
  'Digital Goods – Media, Books, Movies, Music': 'Subscriptions',
  'Computer Software Stores': 'Subscriptions',
  'Computers, Computer Peripheral Equipment, and Software': 'Subscriptions',
};

export function suggestedCategoryName(providerCategory: string | null): string | null {
  if (!providerCategory) return null;
  return CATEGORY_SUGGESTIONS[providerCategory.trim()] ?? null;
}

/**
 * "$31.36" / "-$200.00" -> minor units, still in the FILE's sign
 * convention. The minus is outside the symbol, so it's peeled off first
 * and reapplied rather than stripping "$" from the front and hoping.
 */
function fileAmountMinorOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const negative = trimmed.startsWith('-');
  const digits = (negative ? trimmed.slice(1) : trimmed).replace(/^\$/, '').replace(/,/g, '');
  if (digits === '') return null;
  try {
    const minor = parseAmountToMinor(digits);
    return negative ? -minor : minor;
  } catch {
    return null;
  }
}

/** The reference number arrives wrapped in literal quotes that survive CSV unescaping. */
function cleanReference(raw: string): string {
  return raw.trim().replace(/^"+|"+$/g, '').trim();
}

/**
 * The bank's own rows ("PAYMENT RECEIVED -- THANK" + "YOU") continue into
 * Merchant City; real merchants have a real city there. Distinguished by
 * the row carrying neither a category nor a country, which only the
 * bank-generated ones lack.
 */
function describe(merchantName: string, merchantCity: string, category: string, country: string): string {
  const isBankGenerated = category === '' && country === '';
  if (isBankGenerated && merchantCity !== '') return `${merchantName} ${merchantCity}`.trim();
  return merchantName;
}

export function parseVancityVisaCsv(csvText: string): ParseResult {
  const records = parseCsvRecords(csvText);
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const currencies = new Set<string>();

  // Only needed for rows with no Reference Number of their own.
  const occurrenceCount = new Map<string, number>();

  records.forEach((record, index) => {
    const merchantName = (record['Merchant Name'] ?? '').trim();
    const description = describe(
      merchantName,
      (record['Merchant City'] ?? '').trim(),
      (record['Merchant Category'] ?? '').trim(),
      (record['Merchant Country'] ?? '').trim(),
    );
    const referenceNumber = cleanReference(record['Reference Number'] ?? '');
    const reference = referenceNumber || description || `(row ${index + 2})`; // +2: 1-based, plus the header row

    // Only APPROVED activity is real money. Every row in both samples is
    // APPROVED, so this is defensive rather than demonstrated — but a
    // declined charge that imported as debt is exactly the failure Neo's
    // file proved is possible, and skipping is the safe default.
    const status = (record['Status'] ?? '').trim().toUpperCase();
    if (status !== '' && status !== 'APPROVED') {
      skipped.push({ reference, reason: `status was ${status.toLowerCase()}, not approved` });
      return;
    }

    const date = (record['Date'] ?? '').trim();
    if (!ISO_DATE_RE.test(date)) {
      skipped.push({ reference, reason: 'unrecognized date' });
      return;
    }

    const fileAmountMinor = fileAmountMinorOrNull(record['Amount'] ?? '');
    if (fileAmountMinor === null) {
      skipped.push({ reference, reason: 'Amount was not a readable number' });
      return;
    }
    // See the file header: the export states what you OWE, this app states
    // what the account IS.
    const amountMinor = -fileAmountMinor;

    let importId: string;
    if (referenceNumber !== '') {
      importId = `ref|${referenceNumber}`;
    } else {
      const dedupeKey = `${date}|${amountMinor}|${description}`;
      const occurrence = occurrenceCount.get(dedupeKey) ?? 0;
      occurrenceCount.set(dedupeKey, occurrence + 1);
      importId = `gen|${dedupeKey}|${occurrence}`;
    }

    const providerCategory = (record['Merchant Category'] ?? '').trim() || null;

    currencies.add(CURRENCY);
    rows.push({
      kind: 'ordinary',
      importId,
      date,
      amountMinor,
      currencyCode: CURRENCY,
      payeeRaw: description || null,
      payeeName: description || null,
      memo: null,
      providerCategory,
    });
  });

  return {
    rows,
    skipped,
    currencies: [...currencies].sort(),
    rowCount: records.length,
  };
}
