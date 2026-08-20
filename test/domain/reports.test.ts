import { describe, expect, it } from 'vitest';
import {
  netWorthTrend,
  unvaluedForeignAccounts,
  type AccountBalanceRow,
  type NetWorthAccountRow,
} from '../../src/domain/reports';
import type { AccountKind } from '../../src/domain/types';

// Same tiny-builder discipline as test/domain/ledger.test.ts.

const BUDGET_CURRENCY = 'USD';

function account(
  id: string,
  type: AccountKind,
  extra: Partial<NetWorthAccountRow> = {},
): NetWorthAccountRow {
  return { id, type, currencyCode: BUDGET_CURRENCY, fxRateMicros: null, ...extra };
}

/** Same-currency row: native and budget amounts are equal, as insertTransaction guarantees. */
function row(accountId: string, date: string, dollars: number): AccountBalanceRow {
  const minor = Math.round(dollars * 100);
  return { accountId, date, amountMinor: minor, budgetAmountMinor: minor };
}

/** A foreign row whose per-transaction conversion deliberately disagrees with any single rate. */
function foreignRow(accountId: string, date: string, native: number, budget: number): AccountBalanceRow {
  return { accountId, date, amountMinor: Math.round(native * 100), budgetAmountMinor: Math.round(budget * 100) };
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
      BUDGET_CURRENCY,
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
      BUDGET_CURRENCY,
    );

    expect(points).toEqual([{ month: M1, assetsMinor: 50000, liabilitiesMinor: -12000, netWorthMinor: 38000 }]);
  });

  it('classifies a tracking_liability account (e.g. a mortgage) as a liability too', () => {
    const points = netWorthTrend(
      [row('mortgage', M1, -300000)],
      [account('mortgage', 'tracking_liability')],
      [M1],
      BUDGET_CURRENCY,
    );

    expect(points).toEqual([{ month: M1, assetsMinor: 0, liabilitiesMinor: -30000000, netWorthMinor: -30000000 }]);
  });

  it('sums multiple accounts into one snapshot', () => {
    const points = netWorthTrend(
      [row('checking', M1, 1000), row('savings', M1, 5000), row('card', M1, -200)],
      [account('checking', 'checking'), account('savings', 'savings'), account('card', 'credit_card')],
      [M1],
      BUDGET_CURRENCY,
    );

    expect(points).toEqual([{ month: M1, assetsMinor: 600000, liabilitiesMinor: -20000, netWorthMinor: 580000 }]);
  });

  it('counts a transaction dated on a month’s last day in that month, not the next', () => {
    const points = netWorthTrend(
      [row('checking', '2026-01-31', 100), row('checking', '2026-02-01', 50)],
      [account('checking', 'checking')],
      [M1, M2],
      BUDGET_CURRENCY,
    );

    expect(points[0]).toEqual({ month: M1, assetsMinor: 10000, liabilitiesMinor: 0, netWorthMinor: 10000 });
    expect(points[1]).toEqual({ month: M2, assetsMinor: 15000, liabilitiesMinor: 0, netWorthMinor: 15000 });
  });

  it('keeps a closed account’s pre-close balance in later months’ trend — closing sets no zeroing transaction', () => {
    // Mirrors reality: POST /accounts { closed: true } only sets closedAt —
    // see src/routes/accounts.ts. The account's last real balance stays
    // exactly where it was.
    const points = netWorthTrend([row('savings', M1, 800)], [account('savings', 'savings')], [M1, M2, M3],
      BUDGET_CURRENCY,
    );

    expect(points.map((p) => p.assetsMinor)).toEqual([80000, 80000, 80000]);
  });

  it('an account absent from the accounts list is silently excluded from both totals', () => {
    const points = netWorthTrend([row('ghost', M1, 999)], [], [M1],
      BUDGET_CURRENCY,
    );
    expect(points).toEqual([{ month: M1, assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0 }]);
  });

  it('an empty budget over any month range is all zero', () => {
    const points = netWorthTrend([], [], [M1, M2],
      BUDGET_CURRENCY,
    );
    expect(points).toEqual([
      { month: M1, assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0 },
      { month: M2, assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0 },
    ]);
  });
});

// A BALANCE is worth what it converts to at one rate today; only a
// transaction's own historical rate belongs in category activity. Summing
// per-transaction conversions to get a balance produces a figure that is
// the value of nothing — see src/domain/reports.ts's header and
// docs/plan.md's Phase 5 notes.
describe('netWorthTrend: foreign-currency accounts are revalued, not accumulated', () => {
  const CAD_AT_0_73 = { currencyCode: 'CAD', fxRateMicros: 730000 };

  it('values the native balance at the account’s rate, ignoring the rates its transactions happened at', () => {
    const points = netWorthTrend(
      // CAD 1282.68 in (recorded 1:1 — the real UAT starting-balance bug),
      // then CAD 1276.72 converted out at the rates that actually applied.
      [
        foreignRow('cad', '2026-01-05', 1282.68, 1282.68),
        foreignRow('cad', '2026-01-10', -1142.12, -800.0),
        foreignRow('cad', '2026-01-20', -118.83, -83.91),
        foreignRow('cad', '2026-01-25', -15.77, -11.18),
      ],
      [account('cad', 'tracking_asset', CAD_AT_0_73)],
      [M1],
      BUDGET_CURRENCY,
    );

    // Native balance is CAD 5.96; at 0.73 that's USD 4.35. NOT the 387.59
    // the accumulated per-transaction sum produces.
    expect(points[0]!.assetsMinor).toBe(435);
  });

  it('a foreign account holding nothing contributes nothing, whatever rates moved underneath it', () => {
    // The sharpest form of the bug: CAD 100 in at 0.70, CAD 100 out at
    // 0.80. Native balance zero, so the account is worth zero — but the
    // accumulated sum says -$10 for an account holding no money at all.
    const points = netWorthTrend(
      [foreignRow('cad', '2026-01-05', 100, 70), foreignRow('cad', '2026-01-20', -100, -80)],
      [account('cad', 'tracking_asset', CAD_AT_0_73)],
      [M1],
      BUDGET_CURRENCY,
    );

    expect(points[0]).toEqual({ month: M1, assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0 });
  });

  it('revalues a foreign LIABILITY the same way', () => {
    const points = netWorthTrend(
      [foreignRow('neo', '2026-01-05', -1000, -650)], // CAD 1000 owed, booked at some older rate
      [account('neo', 'credit_card', CAD_AT_0_73)],
      [M1],
      BUDGET_CURRENCY,
    );

    // CAD 1000.00 owed -> USD 730.00 owed at 0.73, not the 650.00 it was booked at.
    expect(points[0]).toEqual({ month: M1, assetsMinor: 0, liabilitiesMinor: -73000, netWorthMinor: -73000 });
  });

  it('re-applies the rate to every month, so a past month restates — the accepted cost of one stored rate', () => {
    const points = netWorthTrend(
      [foreignRow('cad', '2026-01-05', 100, 70)],
      [account('cad', 'tracking_asset', CAD_AT_0_73)],
      [M1, M2, M3],
      BUDGET_CURRENCY,
    );

    // Every month reads 73.00 (the CURRENT rate), not the 70.00 the row was
    // booked at. Documented behaviour, not an accident.
    expect(points.map((p) => p.assetsMinor)).toEqual([7300, 7300, 7300]);
  });

  it('falls back to the accumulated sum for a foreign account with no rate on file', () => {
    const rows = [foreignRow('cad', '2026-01-05', 1282.68, 1282.68)];
    const accountsList = [account('cad', 'tracking_asset', { currencyCode: 'CAD', fxRateMicros: null })];

    const points = netWorthTrend(rows, accountsList, [M1], BUDGET_CURRENCY);
    expect(points[0]!.assetsMinor).toBe(128268); // unchanged from before this behaviour existed

    // ...and it is reported, so the UI can call the figure an estimate.
    expect(unvaluedForeignAccounts(rows, accountsList, BUDGET_CURRENCY).map((a) => a.id)).toEqual(['cad']);
  });

  it('ignores a rate stored on an account already in the budget’s currency', () => {
    // Nothing stops fxRate being set on a same-currency account (see
    // src/routes/accounts.ts) — applying it would scale a balance that
    // needs no conversion.
    const points = netWorthTrend(
      [row('checking', '2026-01-05', 100)],
      [account('checking', 'checking', { currencyCode: BUDGET_CURRENCY, fxRateMicros: 500000 })],
      [M1],
      BUDGET_CURRENCY,
    );

    expect(points[0]!.assetsMinor).toBe(10000); // not 5000
  });
});

describe('unvaluedForeignAccounts', () => {
  it('reports only foreign, rate-less accounts that actually hold rows', () => {
    const rows = [foreignRow('cad', '2026-01-05', 100, 100), row('checking', '2026-01-05', 50)];
    const accountsList = [
      account('cad', 'tracking_asset', { currencyCode: 'CAD', fxRateMicros: null }), // reported
      account('eur', 'tracking_asset', { currencyCode: 'EUR', fxRateMicros: null }), // no rows — nothing to caveat
      account('gbp', 'tracking_asset', { currencyCode: 'GBP', fxRateMicros: 800000 }), // has a rate
      account('checking', 'checking'), // budget currency
    ];

    expect(unvaluedForeignAccounts(rows, accountsList, BUDGET_CURRENCY).map((a) => a.id)).toEqual(['cad']);
  });

  it('is empty for a single-currency budget', () => {
    expect(
      unvaluedForeignAccounts([row('checking', M1, 10)], [account('checking', 'checking')], BUDGET_CURRENCY),
    ).toEqual([]);
  });
});
