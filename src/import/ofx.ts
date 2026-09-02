// OFX / QFX / QBO — the one format that isn't a bank-specific CSV.
//
// Verified against a real Chase credit-card export (14 transactions,
// 2026-07-01 to 2026-08-21). The .qfx and .qbo downloads for that period
// are byte-identical except a single `<INTU.BID>` line, which names the
// Intuit product the download was aimed at (Quicken vs QuickBooks) and
// means nothing to us — so ONE parser serves both extensions, and there is
// no reason to offer the user a choice between them.
//
// Why this is worth having alongside seven CSV parsers: OFX carries the
// things a CSV export throws away.
//
// 1. `<FITID>` IS A REAL BANK-ASSIGNED TRANSACTION ID. Five of the CSV
//    parsers have to synthesise an import_id from
//    `date|amount|description|occurrence` because their files have no id
//    column — a content hash that survives most, but not all, of what a
//    bank can do to a re-export. transactions.import_id's own schema
//    comment reads "Bank-provided FITID or a content hash"; this is the
//    first provider that supplies the former.
// 2. DATES ARE UNAMBIGUOUS. `20260820120000[0:GMT]` needs no guess about
//    field order — unlike Simplii (MM/DD/YYYY despite being a Canadian
//    bank) or Vancity (DD-Mon-YYYY), both of which had to be pinned by
//    test against real files.
// 3. THE CURRENCY IS STATED (`<CURDEF>`), not hardcoded per provider.
//
// Two format quirks drive the implementation:
//
// - OFX 1.x IS SGML, NOT XML. Closing tags on leaf elements are optional
//   and Chase omits them: `<CODE>0` is a complete element. An XML parser
//   rejects the whole document. So values are read with a tolerant scan
//   that ends at the next `<` or line break — which also happens to parse
//   OFX 2.x (real XML, closing tags present) correctly, since a closing
//   tag is just another `<`.
// - THE SIGN IS ON `<TRNAMT>`, NOT `<TRNTYPE>`. TRNTYPE is a label
//   (DEBIT/CREDIT/FEE/INT/...) and TRNAMT is already signed the way this
//   app wants it: negative for a charge, positive for a payment or refund.
//   TRNAMT is what moves the balance, so it is the one trusted; TRNTYPE is
//   read only to report a skipped row usefully.
//
// Pure: no I/O, no DB, no Cloudflare imports.

import { parseAmountToMinor } from '../lib/money';
import type { ParsedRow, ParseResult, SkippedRow } from './types';

/**
 * OFX has no category concept at all — no provider label to map. Same as
 * BECU/AACU/Neo: categorization is the payee-rules layer's job
 * (src/import/rules.ts), which applies above every provider.
 */
export function suggestedCategoryName(_providerCategory: string | null): string | null {
  return null;
}

/**
 * The value of the first `<TAG>` in `block`, or null.
 *
 * A leaf value runs to the next `<` or line break — the tolerant rule that
 * makes unclosed SGML tags readable. Deliberately NOT a regex over the
 * whole document per call site: `block` is always one already-extracted
 * element, so "first match" is unambiguous.
 */
function tagValue(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<\r\n]*)`, 'i').exec(block);
  if (!match) return null;
  const value = match[1]!.trim();
  return value === '' ? null : value;
}

/**
 * `20260820120000[0:GMT]` or a bare `20260820` to 'YYYY-MM-DD'.
 *
 * The timestamp is deliberately truncated rather than converted: Chase
 * stamps every transaction at 12:00:00 GMT precisely so that reading it in
 * any timezone lands on the same calendar day. Applying a timezone offset
 * would move dates around the month boundary for no gain — and
 * transactions.date is a calendar date, not an instant (see the schema).
 */
function toIsoDate(dtposted: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(dtposted);
  if (!match) return null;
  const [, year, month, day] = match;
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;
  return `${year}-${month}-${day}`;
}

/** Every `<STMTTRN>…</STMTTRN>` block in the given text, body only. */
function transactionBlocks(text: string): string[] {
  return [...text.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)].map((m) => m[1]!);
}

/**
 * The statement blocks in the file — `<STMTRS>` for a bank account,
 * `<CCSTMTRS>` for a credit card. Both carry `<CURDEF>`, an account
 * identifier and a `<BANKTRANLIST>`, so both are handled by the same code.
 */
function statementBlocks(text: string): string[] {
  return [...text.matchAll(/<(CC)?STMTRS>([\s\S]*?)<\/(?:CC)?STMTRS>/gi)].map((m) => m[2]!);
}

/** Whitespace-collapsed and lowercased, for comparing two renderings of the same description. */
function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Splits `<NAME>` and `<MEMO>` into the parser contract's two fields.
 *
 * The naive reading — `<NAME>` is the merchant, `<MEMO>` is a note — does
 * not survive contact with real files. Banks routinely truncate `<NAME>` to
 * a fixed width and put the fuller description in `<MEMO>`: across a real
 * AACU export of 757 rows, `<MEMO>` was longer on 754 of them, `<NAME>` was
 * never longer, and `<MEMO>` always began with `<NAME>`'s text. `<NAME>`
 * capped at 36 characters, `<MEMO>` at 58.
 *
 * That matters more than cosmetics, because payee_rules match `payeeRaw`
 * (src/import/rules.ts). With `<NAME>` there, an AACU card purchase reads
 * "Withdrawal POS #090108228049 GOO" — the type prefix and POS reference
 * eat the width and the merchant is cut off mid-word, so a rule for a
 * merchant name cannot match at all. So:
 *
 * - `payeeRaw` is whichever field is FULLER. It is the contract's "full raw
 *   description", and it is what rules get to see.
 * - `payeeName` is `<NAME>` only when it is a genuinely different, shorter
 *   rendering. When it is merely a prefix-truncation of `<MEMO>`, it is left
 *   null so the route layer's cleanPayeeName heuristic runs over the whole
 *   description instead of a fragment that stops mid-merchant.
 */
export function resolvePayeeFields(
  name: string | null,
  memo: string | null,
): { payeeRaw: string | null; payeeName: string | null } {
  if (!memo) return { payeeRaw: name ?? null, payeeName: name ?? null };
  if (!name) return { payeeRaw: memo, payeeName: null };

  const truncated = normalise(memo).startsWith(normalise(name));
  const fuller = memo.length >= name.length ? memo : name;
  return { payeeRaw: fuller, payeeName: truncated ? null : name };
}

export function parseOfx(fileText: string): ParseResult {
  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  const currencies = new Set<string>();
  // Counted across the WHOLE file, including any statement skipped below,
  // so "rowCount" stays "how many transactions the file contained" the way
  // it means "data rows" for a CSV.
  const rowCount = transactionBlocks(fileText).length;

  const statements = statementBlocks(fileText);
  if (statements.length === 0) {
    return { rows, skipped: [{ reference: '(file)', reason: 'no OFX statement found in this file' }], currencies: [], rowCount };
  }

  // An import writes into ONE account, and a second statement is a second
  // account — merging them would silently file one card's charges against
  // another. Two statements in the same currency are indistinguishable to
  // the currency routing in src/routes/imports.ts, so the extras are
  // refused visibly instead. Chase exports one statement per file; this is
  // for the multi-account exports some other institutions produce.
  for (const extra of statements.slice(1)) {
    const acctId = tagValue(extra, 'ACCTID') ?? '(unknown account)';
    skipped.push({
      reference: acctId,
      reason: 'this file holds more than one account — only the first was imported',
    });
  }

  const statement = statements[0]!;
  // Statement-level default. A single transaction may override it with its
  // own <CURRENCY><CURSYM>, which genuinely means "this one is in another
  // currency". <ORIGCURRENCY> is the opposite claim — the amount is in
  // CURDEF and the ORIGINAL was foreign — so it is deliberately ignored.
  const statementCurrency = tagValue(statement, 'CURDEF') ?? 'USD';

  transactionBlocks(statement).forEach((block, index) => {
    const fitid = tagValue(block, 'FITID');
    const name = tagValue(block, 'NAME');
    const reference = fitid ?? name ?? `(transaction ${index + 1})`;

    const dtposted = tagValue(block, 'DTPOSTED');
    const date = dtposted ? toIsoDate(dtposted) : null;
    if (date === null) {
      skipped.push({ reference, reason: 'unrecognized or missing DTPOSTED date' });
      return;
    }

    const rawAmount = tagValue(block, 'TRNAMT');
    let amountMinor: number;
    try {
      if (rawAmount === null) throw new Error('missing');
      amountMinor = parseAmountToMinor(rawAmount);
    } catch {
      const trnType = tagValue(block, 'TRNTYPE') ?? '(none)';
      skipped.push({ reference, reason: `TRNAMT was not a readable number (TRNTYPE ${trnType})` });
      return;
    }

    // Without a FITID there is no stable dedupe key, and inventing one
    // from content would quietly reintroduce exactly the weakness this
    // format exists to avoid. Refused rather than guessed at.
    if (fitid === null) {
      skipped.push({ reference, reason: 'no FITID — cannot be safely deduplicated on re-import' });
      return;
    }

    const currencyCode = tagValue(block, 'CURSYM') ?? statementCurrency;
    currencies.add(currencyCode);

    const memo = tagValue(block, 'MEMO');
    const { payeeRaw, payeeName } = resolvePayeeFields(name, memo);

    rows.push({
      kind: 'ordinary',
      importId: `fitid|${fitid}`,
      date,
      amountMinor,
      currencyCode,
      payeeRaw,
      payeeName,
      memo,
      providerCategory: null,
    });
  });

  return { rows, skipped, currencies: [...currencies].sort(), rowCount };
}
