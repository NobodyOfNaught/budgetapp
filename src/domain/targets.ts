// The obligations layer. Pure functions over plain rows — same discipline
// as src/domain/ledger.ts, zero drizzle/Cloudflare imports, nothing async.
//
// The core idea: a category has two separate clocks. `computeLedger`
// answers "what's available right now" on the MONTH clock — the cadence at
// which you decide what to assign. This module answers "how much of that
// assignment should go here, and when's it actually due" on the
// OBLIGATION's own clock — which has nothing to do with month boundaries.
// A bill due every 3 weeks drifts across months; a category's `available`
// doesn't care, because it's a running balance, not a monthly reset (see
// docs/plan.md's ledger engine section). This module is what turns "how
// available compares to a target" into a concrete monthly number.

import { addDays, addMonths, addYears, monthOf, monthsBetween } from '../lib/dates';
import type { CategoryMonthResult, IntervalUnit, TargetResult, TargetRow } from './types';

// Bounds how far nextOccurrenceOnOrAfter will walk forward before giving
// up — purely defensive against a pathological (or malformed) target, e.g.
// a weekly cadence anchored decades in the past. 5000 weekly steps is
// ~96 years of headroom, far past anything a personal budget needs.
const MAX_OCCURRENCE_STEPS = 5000;

/**
 * The occurrence `steps` intervals after `firstOccurrence` — computed
 * fresh from `firstOccurrence` every time, never by adding one interval to
 * a previous RESULT. That distinction matters because addMonths/addYears
 * clamp the day-of-month (Jan 31 + 1 month -> Feb 28): stepping off an
 * already-clamped date would carry that clamp forward permanently (Feb 28
 * + 1 month -> Mar 28, silently losing the 31st forever, instead of the
 * correct Mar 31). Recomputing from the original anchor every time means
 * each candidate clamps independently, exactly once, against its own
 * target month. `steps = 0` returns `firstOccurrence` itself, unchanged.
 *
 * Exported for callers that need MULTIPLE occurrences within a range (see
 * GET /budgets/:id/upcoming in src/routes/targets.ts) rather than just the
 * first one on/after some date, which is what nextOccurrenceOnOrAfter
 * below is for.
 */
export function occurrenceAtStep(firstOccurrence: string, unit: Exclude<IntervalUnit, 'once'>, count: number, steps: number): string {
  switch (unit) {
    case 'week':
      return addDays(firstOccurrence, steps * count * 7);
    case 'month':
      return addMonths(firstOccurrence, steps * count);
    case 'year':
      return addYears(firstOccurrence, steps * count);
  }
}

/**
 * The first occurrence of a recurring target on or after `anchor`.
 * `firstOccurrence` is the target's very first-ever occurrence, so nothing
 * before it exists — if it's already on/after `anchor` it IS the answer;
 * only step forward when it's earlier. (Both arguments compare correctly
 * as plain strings: 'YYYY-MM-01' is itself a valid 'YYYY-MM-DD'.)
 */
function nextOccurrenceOnOrAfter(
  firstOccurrence: string,
  unit: Exclude<IntervalUnit, 'once'>,
  count: number,
  anchor: string,
): string {
  if (firstOccurrence >= anchor) return firstOccurrence;
  let candidate = firstOccurrence;
  for (let steps = 1; steps <= MAX_OCCURRENCE_STEPS; steps++) {
    candidate = occurrenceAtStep(firstOccurrence, unit, count, steps);
    if (candidate >= anchor) return candidate;
  }
  return candidate; // bound exhausted — defensive only, see MAX_OCCURRENCE_STEPS's comment
}

/**
 * Computes each target's "needed this month" and "next due" for one month,
 * given that month's ledger results (`monthCategories` — pass the
 * `categories` map straight off a `computeLedger` `MonthResult`). Sparse:
 * only categories carrying a live target appear in the result.
 *
 * Deliberately takes no "today" — like the ledger engine, this is a pure
 * fold over data plus a target month, not real-clock-dependent. Browsing
 * forward a month and re-calling this with the next month is what advances
 * `nextDueDate`; see test/domain/targets.test.ts. A real "what's due in the
 * next N days from right now" view is a separate, deliberately
 * clock-anchored computation — see GET /budgets/:id/upcoming.
 */
export function computeTargets(input: {
  targets: TargetRow[];
  monthCategories: Record<string, CategoryMonthResult>;
  /** 'YYYY-MM-01' */
  month: string;
}): Record<string, TargetResult> {
  const results: Record<string, TargetResult> = {};

  for (const target of input.targets) {
    const cm = input.monthCategories[target.categoryId];
    const available = cm?.available ?? 0;
    const assignedThisMonth = cm?.assigned ?? 0;

    // Build family: an open-ended savings goal with no deadline at all —
    // no monthly math forces anything here, there's just a running total.
    if (target.intervalUnit === 'once' && target.dueDate === null) {
      results[target.categoryId] = {
        categoryId: target.categoryId,
        amountMinor: target.amountMinor,
        neededMinor: 0,
        nextDueDate: null,
        status: 'building',
      };
      continue;
    }

    let nextDueDate: string | null;
    if (target.intervalUnit === 'once') {
      // dueDate is non-null here (the null case is handled above). A
      // one-time deadline either hasn't happened yet or has — there's
      // nothing to walk forward to.
      nextDueDate = target.dueDate! >= input.month ? target.dueDate! : null;
    } else if (target.dueDate === null) {
      // A recurring target with no anchor date recorded yet — nothing to
      // walk a schedule from. Falls through to the "no months left to
      // spread across" treatment below, same as an elapsed one-time date.
      nextDueDate = null;
    } else {
      nextDueDate = nextOccurrenceOnOrAfter(target.dueDate, target.intervalUnit, target.intervalCount, input.month);
    }

    let neededMinor: number;
    if (target.intervalUnit === 'week') {
      // Smoothed sub-monthly: a steady monthly rate rather than an amount
      // that alternates with however many occurrences land in a given
      // month. A category funded this way will visibly dip in a
      // two-occurrence month and recover the next — that's the smoothing
      // working as intended, not drift. Compares against assignedThisMonth
      // directly (not available) — there's no target balance to reach,
      // just a pace to keep up every month, indefinitely.
      const occurrencesPerYear = 52 / target.intervalCount;
      const monthlyContribution = Math.round((target.amountMinor * occurrencesPerYear) / 12);
      neededMinor = Math.max(0, monthlyContribution - assignedThisMonth);
    } else if (target.intervalUnit === 'month' && target.intervalCount === 1) {
      // Refill: top `available` back up to the target amount every month —
      // no date needed, no spreading, just "keep it at X". `available`
      // already reflects any assignment made this month, so this is a
      // single direct comparison, no separate subtraction needed.
      neededMinor = Math.max(0, target.amountMinor - available);
    } else {
      // Accumulate: month/N>1 (quarterly, etc.), year, or once-by-date —
      // spread the remaining gap evenly across the months still available
      // before it's due, then ask for this month's share.
      //
      // An elapsed one-time target or a recurring target missing its
      // anchor date both fall here too (nextDueDate === null): with no
      // schedule to spread across, `dueMonth` defaults to the CURRENT
      // month, which floors monthsRemaining at 1 below — "no more months
      // to spread across, the honest ask is the whole remaining gap now."
      //
      // `available` already counts whatever's been assigned this month, so
      // the gap is measured against `baseAvailable` (available with this
      // month's own assignment backed out — i.e. carryover plus this
      // month's real activity) rather than `available` itself. Using
      // `available` directly here would double-count this month's
      // assignment: once by shrinking the gap, and again in the trailing
      // `- assignedThisMonth` below.
      const dueMonth = nextDueDate !== null ? monthOf(nextDueDate) : input.month;
      const monthsRemaining = Math.max(1, monthsBetween(input.month, dueMonth));
      const baseAvailable = available - assignedThisMonth;
      const gap = Math.max(0, target.amountMinor - baseAvailable);
      const monthlyContribution = Math.ceil(gap / monthsRemaining);
      neededMinor = Math.max(0, monthlyContribution - assignedThisMonth);
    }

    results[target.categoryId] = {
      categoryId: target.categoryId,
      amountMinor: target.amountMinor,
      neededMinor,
      nextDueDate,
      status: neededMinor === 0 ? 'funded' : 'short',
    };
  }

  return results;
}
