import { describe, expect, it } from 'vitest';
import { netWorthTrend, type AccountBalanceRow, type NetWorthAccountRow } from '../../src/domain/reports';
import type { AccountKind } from '../../src/domain/types';

// Same tiny-builder discipline as test/domain/ledger.test.ts.

function account(id: string, type: AccountKind): NetWorthAccountRow {
  return { id, type };
}

function row(accountId: string, date: string, dollars: number): AccountBalanceRow {
  return { accountId, date, budgetAmountMinor: Math.round(dollars * 100) };
}

const M1 = '2026-01-01';
const M2 = '2026-02-01';
const M3 = '2026-03-01';

describe('netWorthTrend', () => {
  it('trends a single checking account across three months', () => {
    const points = netWorthTrend(
      [row('checking', '2026-01-05', 1000), row('checking', '2026-02-10', 200), row('checking', '2026-03-01', -50)],
      [account('checking', 'checking')],
      [M1, M2, M3],
    );

    expect(points).toEqual([
      { month: M1, assetsMinor: 100000, liabilitiesMinor: 0, netWorthMinor: 100000 },
      { month: M2, assetsMinor: 120000, liabilitiesMinor: 0, netWorthMinor: 120000 },
      { month: M3, assetsMinor: 115000, liabilitiesMinor: 0, netWorthMinor: 115000 },
    ]);
  });

  it('classifies a credit card balance as a liability, correctly negative', () => {
    const points = netWorthTrend(
      [row('checking', M1, 500), row('card', '2026-01-15', -120)],
      [account('checking', 'checking'), account('card', 'credit_card')],
      [M1],
    );

    expect(points).toEqual([{ month: M1, assetsMinor: 50000, liabilitiesMinor: -12000, netWorthMinor: 38000 }]);
  });

  it('classifies a tracking_liability account (e.g. a mortgage) as a liability too', () => {
    const points = netWorthTrend(
      [row('mortgage', M1, -300000)],
      [account('mortgage', 'tracking_liability')],
      [M1],
    );

    expect(points).toEqual([{ month: M1, assetsMinor: 0, liabilitiesMinor: -30000000, netWorthMinor: -30000000 }]);
  });

  it('sums multiple accounts into one snapshot', () => {
    const points = netWorthTrend(
      [row('checking', M1, 1000), row('savings', M1, 5000), row('card', M1, -200)],
      [account('checking', 'checking'), account('savings', 'savings'), account('card', 'credit_card')],
      [M1],
    );

    expect(points).toEqual([{ month: M1, assetsMinor: 600000, liabilitiesMinor: -20000, netWorthMinor: 580000 }]);
  });

  it('counts a transaction dated on a month’s last day in that month, not the next', () => {
    const points = netWorthTrend(
      [row('checking', '2026-01-31', 100), row('checking', '2026-02-01', 50)],
      [account('checking', 'checking')],
      [M1, M2],
    );

    expect(points[0]).toEqual({ month: M1, assetsMinor: 10000, liabilitiesMinor: 0, netWorthMinor: 10000 });
    expect(points[1]).toEqual({ month: M2, assetsMinor: 15000, liabilitiesMinor: 0, netWorthMinor: 15000 });
  });

  it('keeps a closed account’s pre-close balance in later months’ trend — closing sets no zeroing transaction', () => {
    // Mirrors reality: POST /accounts { closed: true } only sets closedAt —
    // see src/routes/accounts.ts. The account's last real balance stays
    // exactly where it was.
    const points = netWorthTrend([row('savings', M1, 800)], [account('savings', 'savings')], [M1, M2, M3]);

    expect(points.map((p) => p.assetsMinor)).toEqual([80000, 80000, 80000]);
  });

  it('an account absent from the accounts list is silently excluded from both totals', () => {
    const points = netWorthTrend([row('ghost', M1, 999)], [], [M1]);
    expect(points).toEqual([{ month: M1, assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0 }]);
  });

  it('an empty budget over any month range is all zero', () => {
    const points = netWorthTrend([], [], [M1, M2]);
    expect(points).toEqual([
      { month: M1, assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0 },
      { month: M2, assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0 },
    ]);
  });
});
