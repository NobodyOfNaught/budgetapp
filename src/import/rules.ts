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
   * Optional price band, in the BUDGET's currency, as a non-negative
   * magnitude in minor units (cents) — null means "no limit on that side".
   * Both ends are inclusive. It lets one merchant mean different things at
   * different prices: a $20–$40 charge from a dance studio is a weekly
   * class, a $115 one is an event. It is measured in budget currency, not
   * the account's own, so a CAD 57 charge is judged as the ~$42 it is
   * worth rather than as 57.
   */
  amountMinMinor?: number | null;
  amountMaxMinor?: number | null;
}

function isBounded(rule: PayeeRule): boolean {
  return (rule.amountMinMinor ?? null) !== null || (rule.amountMaxMinor ?? null) !== null;
}

/** How wide a rule's band is; an open side is infinitely wide, so a narrower band sorts as more specific. */
function bandWidth(rule: PayeeRule): number {
  const lo = rule.amountMinMinor ?? 0;
  const hi = rule.amountMaxMinor ?? Number.POSITIVE_INFINITY;
  return hi - lo;
}

function inBand(rule: PayeeRule, magnitudeMinor: number): boolean {
  if (rule.amountMinMinor != null && magnitudeMinor < rule.amountMinMinor) return false;
  if (rule.amountMaxMinor != null && magnitudeMinor > rule.amountMaxMinor) return false;
  return true;
}

/**
 * The best rule matching `rawDescription` (a case-insensitive substring
 * match against the FULL raw statement text — never against
 * cleanPayeeName's output, so a rule can recover anything the generic
 * heuristic discarded), or null when none match.
 *
 * `amountMinor` is the row's amount in the budget's currency; its SIGN is
 * ignored (a refund and a charge of the same size fall in the same band).
 * A rule with a price band only matches when the amount is known and inside
 * the band — a banded rule is a claim about price, so with no price it is
 * skipped rather than guessed at. Unbanded rules ignore the amount, so
 * every existing rule behaves exactly as before.
 *
 * When several rules match, the most specific wins, in this order:
 *   1. the LONGEST matchText — "GIANT FOOD INC" beats "GIANT FOOD" on a
 *      row containing both, without needing a drag-to-reorder UI;
 *   2. then a rule WITH a price band over one without — which is what lets
 *      "DANCE JAM, up to $50" sit in front of a plain "DANCE JAM" fallback;
 *   3. then the narrower band;
 *   4. then whichever appears EARLIEST in `rules` — so for "ties broken by
 *      oldest rule" to hold, callers must pass rules ordered
 *      oldest-created-first (src/budget/payee-rules.ts's loader does).
 */
export function matchPayeeRule(rules: PayeeRule[], rawDescription: string, amountMinor?: number): PayeeRule | null {
  const haystack = rawDescription.toLowerCase();
  const magnitude = amountMinor === undefined ? undefined : Math.abs(amountMinor);
  let best: PayeeRule | null = null;

  for (const rule of rules) {
    if (rule.matchText === '') continue;
    if (!haystack.includes(rule.matchText.toLowerCase())) continue;
    if (isBounded(rule) && (magnitude === undefined || !inBand(rule, magnitude))) continue;
    if (best === null || moreSpecific(rule, best)) best = rule;
  }

  return best;
}

/** Strictly more specific than `other`; an exact tie is false, so the earlier rule is kept. */
function moreSpecific(rule: PayeeRule, other: PayeeRule): boolean {
  if (rule.matchText.length !== other.matchText.length) return rule.matchText.length > other.matchText.length;
  if (isBounded(rule) !== isBounded(other)) return isBounded(rule);
  return bandWidth(rule) < bandWidth(other);
}
