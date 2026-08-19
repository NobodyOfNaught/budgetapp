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
}

/**
 * The best rule matching `rawDescription` (a case-insensitive substring
 * match against the FULL raw statement text — never against
 * cleanPayeeName's output, so a rule can recover anything the generic
 * heuristic discarded), or null when none match.
 *
 * When several rules match, the LONGEST matchText wins — "GIANT FOOD INC"
 * beats "GIANT FOOD" on a row containing both, without needing a
 * drag-to-reorder UI: the more specific rule is the more intentional one.
 * Ties (equal length) keep whichever rule appears EARLIEST in `rules` — so
 * for "ties broken by oldest rule" to hold, callers must pass rules ordered
 * oldest-created-first (src/routes/imports.ts's loader does).
 */
export function matchPayeeRule(rules: PayeeRule[], rawDescription: string): PayeeRule | null {
  const haystack = rawDescription.toLowerCase();
  let best: PayeeRule | null = null;

  for (const rule of rules) {
    if (rule.matchText === '') continue;
    if (!haystack.includes(rule.matchText.toLowerCase())) continue;
    if (best === null || rule.matchText.length > best.matchText.length) {
      best = rule;
    }
  }

  return best;
}
