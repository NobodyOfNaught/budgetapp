// User-defined payee-naming overrides — see migrations/0004_payee_rules.sql
// and docs/plan.md's PR 9 notes. Pure matching logic only; loading rules
// from D1 and applying the result is src/routes/imports.ts's job.
//
// Pure: no I/O, no DB, no Cloudflare imports.

export interface PayeeRule {
  id: string;
  matchText: string;
  payeeName: string;
  categoryId: string | null;
  /**
   * Optional price conditions, all in the BUDGET's currency as a
   * non-negative magnitude in minor units (cents). null means "no condition".
   *
   * `amountMinMinor`/`amountMaxMinor` are an inclusive range.
   * `amountMultipleMinor` says the price must be a whole multiple of a step
   * ($20 -> 2000), which is how a studio's flat-rate class nights ($20, $40,
   * $60) are told apart from a one-off event charge of an arbitrary size.
   *
   * They exist so one merchant can mean different things at different
   * prices. They are measured in budget currency, not the account's own, so
   * a CAD charge is judged as the ~USD it is worth. See migrations/0013,
   * 0014 and matchPayeeRule below.
   */
  amountMinMinor?: number | null;
  amountMaxMinor?: number | null;
  amountMultipleMinor?: number | null;
}

/**
 * How far a converted amount can sit from the true price of a charge made in
 * ANOTHER currency, as a fraction of the converted amount.
 *
 * A USD price charged to a CAD card comes out larger than the stored
 * exchange rate predicts, because the card adds an exchange spread and fee on
 * top: the owner's $40 class night arrives as CAD 57.45, which converts to
 * $41.94 — 4.8% over. So the true price is allowed to be up to
 * OVERSTATED_BY below the converted figure. It is allowed to be only a little
 * ABOVE it (UNDERSTATED_BY, for rate drift), deliberately: a symmetric
 * tolerance would also pull the owner's CAD 79.54 event charge, which
 * converts to $58.06, onto the $60 class price it is 3% short of.
 *
 * Applied ONLY to rows in a currency other than the budget's. A charge in the
 * budget's own currency is exact.
 */
const OVERSTATED_BY = 0.07;
const UNDERSTATED_BY = 0.02;

function isBounded(rule: PayeeRule): boolean {
  return (
    (rule.amountMinMinor ?? null) !== null ||
    (rule.amountMaxMinor ?? null) !== null ||
    (rule.amountMultipleMinor ?? null) !== null
  );
}

/** How wide a rule's range is; an open side is infinitely wide, so a narrower range sorts as more specific. */
function bandWidth(rule: PayeeRule): number {
  const lo = rule.amountMinMinor ?? 0;
  const hi = rule.amountMaxMinor ?? Number.POSITIVE_INFINITY;
  return hi - lo;
}

/**
 * Whether some price the charge could truly have been satisfies the rule.
 *
 * For a charge in the budget's own currency that is a single price and the
 * check is exact. For a converted one it is the interval
 * [amount / (1 + OVERSTATED_BY), amount * (1 + UNDERSTATED_BY)], and the rule
 * matches when ANY price in it satisfies both the range and the multiple —
 * which is why the multiple is tested against the part of the interval the
 * range leaves, not against the amount itself.
 */
function satisfies(rule: PayeeRule, magnitudeMinor: number, approximate: boolean): boolean {
  const lo = approximate ? Math.floor(magnitudeMinor / (1 + OVERSTATED_BY)) : magnitudeMinor;
  const hi = approximate ? Math.ceil(magnitudeMinor * (1 + UNDERSTATED_BY)) : magnitudeMinor;

  const from = Math.max(lo, rule.amountMinMinor ?? 0);
  const to = Math.min(hi, rule.amountMaxMinor ?? Number.POSITIVE_INFINITY);
  if (from > to) return false;

  const step = rule.amountMultipleMinor ?? null;
  if (step === null) return true;
  // Smallest whole multiple of `step` at or above `from`, and at least one
  // step: zero is a multiple of everything and must not match "a multiple of 20".
  const candidate = Math.max(Math.ceil(from / step) * step, step);
  return candidate <= to;
}

/**
 * The best rule matching `rawDescription` (a case-insensitive substring
 * match against the FULL raw statement text — never against
 * cleanPayeeName's output, so a rule can recover anything the generic
 * heuristic discarded), or null when none match.
 *
 * `amountMinor` is the row's amount in the budget's currency; its SIGN is
 * ignored (a refund and a charge of the same size fall alike).
 * `options.approximate` says the row was charged in another currency, so
 * its converted amount is only an estimate of the real price (see
 * OVERSTATED_BY). A rule with price conditions only matches when the amount
 * is known and satisfies them — such a rule is a claim about price, so with
 * no price it is skipped rather than guessed at. Rules with no price
 * conditions ignore the amount, so every older rule behaves exactly as before.
 *
 * When several rules match, the most specific wins, in this order:
 *   1. the LONGEST matchText — "GIANT FOOD INC" beats "GIANT FOOD" on a
 *      row containing both, without needing a drag-to-reorder UI;
 *   2. then a rule WITH price conditions over one without — which is what
 *      lets "DANCE JAM, a multiple of $20" sit in front of a plain
 *      "DANCE JAM" fallback;
 *   3. then a rule with a multiple over one with only a range;
 *   4. then the narrower range;
 *   5. then whichever appears EARLIEST in `rules` — so for "ties broken by
 *      oldest rule" to hold, callers must pass rules ordered
 *      oldest-created-first (src/budget/payee-rules.ts's loader does).
 */
export function matchPayeeRule(
  rules: PayeeRule[],
  rawDescription: string,
  amountMinor?: number,
  options: { approximate?: boolean } = {},
): PayeeRule | null {
  const haystack = rawDescription.toLowerCase();
  const magnitude = amountMinor === undefined ? undefined : Math.abs(amountMinor);
  let best: PayeeRule | null = null;

  for (const rule of rules) {
    if (rule.matchText === '') continue;
    if (!haystack.includes(rule.matchText.toLowerCase())) continue;
    if (isBounded(rule) && (magnitude === undefined || !satisfies(rule, magnitude, options.approximate ?? false))) continue;
    if (best === null || moreSpecific(rule, best)) best = rule;
  }

  return best;
}

/** Strictly more specific than `other`; an exact tie is false, so the earlier rule is kept. */
function moreSpecific(rule: PayeeRule, other: PayeeRule): boolean {
  if (rule.matchText.length !== other.matchText.length) return rule.matchText.length > other.matchText.length;
  if (isBounded(rule) !== isBounded(other)) return isBounded(rule);
  const ruleHasMultiple = (rule.amountMultipleMinor ?? null) !== null;
  const otherHasMultiple = (other.amountMultipleMinor ?? null) !== null;
  if (ruleHasMultiple !== otherHasMultiple) return ruleHasMultiple;
  return bandWidth(rule) < bandWidth(other);
}
