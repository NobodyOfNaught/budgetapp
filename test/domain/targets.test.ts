import { describe, expect, it } from 'vitest';
import { computeTargets } from '../../src/domain/targets';
import type { CategoryMonthResult, IntervalUnit, TargetRow } from '../../src/domain/types';

// Same spirit as test/domain/ledger.test.ts's builders: each scenario reads
// as "what happened", not "how to satisfy the type checker".

function target(
  categoryId: string,
  amountDollars: number,
  unit: IntervalUnit,
  count: number,
  dueDate: string | null,
): TargetRow {
  return { categoryId, amountMinor: Math.round(amountDollars * 100), intervalUnit: unit, intervalCount: count, dueDate };
}

/** A category's current ledger position — what a real computeLedger() month result looks like for one category. */
function cat(categoryId: string, assignedDollars: number, activityDollars: number, availableDollars: number): CategoryMonthResult {
  return {
    categoryId,
    assigned: Math.round(assignedDollars * 100),
    activity: Math.round(activityDollars * 100),
    available: Math.round(availableDollars * 100),
  };
}

function monthCats(...rows: CategoryMonthResult[]): Record<string, CategoryMonthResult> {
  return Object.fromEntries(rows.map((r) => [r.categoryId, r]));
}

describe('monthly refill', () => {
  it('needs the shortfall between available and the target amount', () => {
    const rent = target('rent', 900, 'month', 1, '2026-01-01');
    const result = computeTargets({
      targets: [rent],
      monthCategories: monthCats(cat('rent', 500, 0, 500)),
      month: '2026-03-01',
    });
    expect(result.rent?.neededMinor).toBe(40000); // (900 - 500) * 100
    expect(result.rent?.status).toBe('short');
    // Anchored 2026-01-01, monthly — the occurrence on/after March 1 is March 1 itself.
    expect(result.rent?.nextDueDate).toBe('2026-03-01');
  });

  it('is funded once available reaches the target, even if assigned in a prior month', () => {
    const rent = target('rent', 900, 'month', 1, '2026-01-01');
    const result = computeTargets({
      targets: [rent],
      monthCategories: monthCats(cat('rent', 0, 0, 900)), // carried forward, nothing newly assigned this month
      month: '2026-03-01',
    });
    expect(result.rent?.neededMinor).toBe(0);
    expect(result.rent?.status).toBe('funded');
  });

  it('never asks for a negative amount when available overshoots the target', () => {
    const rent = target('rent', 900, 'month', 1, '2026-01-01');
    const result = computeTargets({
      targets: [rent],
      monthCategories: monthCats(cat('rent', 0, 0, 1200)),
      month: '2026-03-01',
    });
    expect(result.rent?.neededMinor).toBe(0);
    expect(result.rent?.status).toBe('funded');
  });
});

describe('accumulate: quarterly and annual spreading', () => {
  it('spreads a quarterly bill evenly across the months before it, and lowers Needed as you assign', () => {
    const tax = target('tax', 1200, 'month', 3, '2026-06-01'); // due June 1, quarterly
    // Viewed in March with nothing saved yet: March/April/May are the 3
    // funding months (June itself isn't — the money needs to already be
    // there by June 1), so $1200 / 3 = $400/mo.
    const empty = computeTargets({ targets: [tax], monthCategories: monthCats(cat('tax', 0, 0, 0)), month: '2026-03-01' });
    expect(empty.tax?.nextDueDate).toBe('2026-06-01');
    expect(empty.tax?.neededMinor).toBe(40000);
    expect(empty.tax?.status).toBe('short');

    // $150 of this month's $400 already assigned — Needed is the remaining $250, not $400 again.
    const partial = computeTargets({ targets: [tax], monthCategories: monthCats(cat('tax', 150, 0, 150)), month: '2026-03-01' });
    expect(partial.tax?.neededMinor).toBe(25000);

    // The full $400 assigned this month — funded for March.
    const full = computeTargets({ targets: [tax], monthCategories: monthCats(cat('tax', 400, 0, 400)), month: '2026-03-01' });
    expect(full.tax?.neededMinor).toBe(0);
    expect(full.tax?.status).toBe('funded');
  });

  it('recomputes the monthly share as months pass and the balance grows', () => {
    const tax = target('tax', 1200, 'month', 3, '2026-06-01');
    // By April, $400 is already carried forward from March — 2 months left (April, May) for the $800 gap.
    const april = computeTargets({ targets: [tax], monthCategories: monthCats(cat('tax', 0, 0, 400)), month: '2026-04-01' });
    expect(april.tax?.neededMinor).toBe(40000); // (1200 - 400) / 2 = 400/mo, unchanged pace
    // By May, $800 carried forward — 1 month left (May) for the final $400.
    const may = computeTargets({ targets: [tax], monthCategories: monthCats(cat('tax', 0, 0, 800)), month: '2026-05-01' });
    expect(may.tax?.neededMinor).toBe(40000);
  });

  it('spreads an annual bill over 12 months', () => {
    const insurance = target('insurance', 1200, 'year', 1, '2026-06-01');
    const result = computeTargets({
      targets: [insurance],
      monthCategories: monthCats(cat('insurance', 0, 0, 0)),
      month: '2026-06-01', // exactly a year before the *next* occurrence
    });
    // Due THIS month (June): 12 months until the following June, but the
    // occurrence landing in the viewed month itself is what's due now.
    expect(result.insurance?.nextDueDate).toBe('2026-06-01');
    expect(result.insurance?.neededMinor).toBe(120000); // nothing saved, due now — the whole thing
  });

  it('spreads an annual bill correctly when viewed well before it is due', () => {
    const insurance = target('insurance', 1200, 'year', 1, '2027-06-01');
    const result = computeTargets({
      targets: [insurance],
      monthCategories: monthCats(cat('insurance', 0, 0, 0)),
      month: '2026-06-01', // 12 months before due
    });
    expect(result.insurance?.nextDueDate).toBe('2027-06-01');
    expect(result.insurance?.neededMinor).toBe(10000); // 1200 / 12
  });
});

describe('smoothed sub-monthly: every-3-weeks', () => {
  it('asks for a steady monthly rate regardless of how many occurrences fall in the month', () => {
    const daycare = target('daycare', 50, 'week', 3, '2026-01-05');
    // 52 / 3 occurrences/year * $50 / 12 months = $72.2222... -> rounds to
    // the nearest CENT (this is minor-unit math), i.e. $72.22 = 7222 minor.
    const result = computeTargets({
      targets: [daycare],
      monthCategories: monthCats(cat('daycare', 0, -50, -50)), // one $50 occurrence already landed this month
      month: '2026-03-01',
    });
    expect(result.daycare?.neededMinor).toBe(7222);
    expect(result.daycare?.status).toBe('short');
  });

  it('is funded for the month once the smoothed contribution is assigned, independent of available', () => {
    const daycare = target('daycare', 50, 'week', 3, '2026-01-05');
    const result = computeTargets({
      targets: [daycare],
      // A double-occurrence month: available dipped even though the full
      // $72.22 contribution was assigned — that dip is the smoothing
      // buffer being drawn down, not a funding shortfall.
      monthCategories: monthCats(cat('daycare', 72.22, -100, -27.78)),
      month: '2026-03-01',
    });
    expect(result.daycare?.neededMinor).toBe(0);
    expect(result.daycare?.status).toBe('funded');
  });
});

describe('once: by-date and open-ended build', () => {
  it('spreads a one-time goal evenly across the months remaining before its date', () => {
    const trip = target('trip', 600, 'once', 1, '2026-06-01');
    // Viewed in March: March/April/May, 3 months, $200/mo.
    const result = computeTargets({ targets: [trip], monthCategories: monthCats(cat('trip', 0, 0, 0)), month: '2026-03-01' });
    expect(result.trip?.nextDueDate).toBe('2026-06-01');
    expect(result.trip?.neededMinor).toBe(20000);
  });

  it('asks for the full remaining gap at once when the one-time date has already elapsed', () => {
    const trip = target('trip', 600, 'once', 1, '2026-02-01');
    const result = computeTargets({
      targets: [trip],
      monthCategories: monthCats(cat('trip', 0, 0, 200)), // $200 saved before the deadline passed
      month: '2026-03-01', // viewing AFTER the Feb 1 deadline
    });
    expect(result.trip?.nextDueDate).toBeNull();
    expect(result.trip?.neededMinor).toBe(40000); // the whole remaining $400, no more months to spread across
    expect(result.trip?.status).toBe('short');
  });

  it('has no forced monthly ask for an open-ended goal with no deadline', () => {
    const emergencyFund = target('emergency', 5000, 'once', 1, null);
    const result = computeTargets({
      targets: [emergencyFund],
      monthCategories: monthCats(cat('emergency', 0, 0, 1200)),
      month: '2026-03-01',
    });
    expect(result.emergency?.neededMinor).toBe(0);
    expect(result.emergency?.nextDueDate).toBeNull();
    expect(result.emergency?.status).toBe('building');
    expect(result.emergency?.amountMinor).toBe(500000);
  });
});

describe('month-end clamping and leap years', () => {
  it('clamps a monthly target anchored on the 31st into shorter months rather than overflowing', () => {
    const target31 = target('t31', 100, 'month', 1, '2026-01-31');
    // February 2026 has 28 days — the occurrence lands on the 28th, not March 2/3.
    const feb = computeTargets({ targets: [target31], monthCategories: monthCats(cat('t31', 0, 0, 0)), month: '2026-02-01' });
    expect(feb.t31?.nextDueDate).toBe('2026-02-28');
  });

  it('clamps onto Feb 29 in a leap year', () => {
    const target31 = target('t31', 100, 'month', 1, '2026-01-31');
    const feb2028 = computeTargets({
      targets: [target31],
      monthCategories: monthCats(cat('t31', 0, 0, 0)),
      month: '2028-02-01', // 2028 is a leap year
    });
    expect(feb2028.t31?.nextDueDate).toBe('2028-02-29');
  });
});

describe('the rent-across-March-gap case', () => {
  it('the due date correctly walks forward across a month with no occurrence at all', () => {
    // The exact scenario that motivated this feature: rent paid Feb 27,
    // then the next payment isn't until Apr 1 — March has no occurrence,
    // but nextDueDate should still land correctly on April 1 when viewed
    // from March, not skip past it or get stuck.
    const rent = target('rent', 900, 'month', 1, '2026-02-27');
    const feb = computeTargets({ targets: [rent], monthCategories: monthCats(cat('rent', 900, -900, 0)), month: '2026-02-01' });
    expect(feb.rent?.nextDueDate).toBe('2026-02-27'); // due date itself, already on/after Feb 1

    const march = computeTargets({ targets: [rent], monthCategories: monthCats(cat('rent', 900, 0, 900)), month: '2026-03-01' });
    // Anchored the 27th: Feb 27 -> Mar 27 is the next occurrence on/after March 1.
    expect(march.rent?.nextDueDate).toBe('2026-03-27');

    const april = computeTargets({ targets: [rent], monthCategories: monthCats(cat('rent', 900, -900, 900)), month: '2026-04-01' });
    // Mar 27 -> Apr 27 is on/after April 1.
    expect(april.rent?.nextDueDate).toBe('2026-04-27');
  });
});

describe('sparse results', () => {
  it('only returns entries for categories that actually carry a live target', () => {
    const result = computeTargets({
      targets: [target('rent', 900, 'month', 1, '2026-01-01')],
      monthCategories: monthCats(cat('rent', 900, 0, 900), cat('groceries', 300, -300, 0)),
      month: '2026-03-01',
    });
    expect(Object.keys(result)).toEqual(['rent']);
  });
});
