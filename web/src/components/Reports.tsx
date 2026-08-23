import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { NetWorthChart } from './NetWorthChart';
import type { CategoryGroup, IncomeExpenseReport, NetWorthReport, SpendingReport } from '../types';

// Same formatMinor/amountColor duplication as every other screen
// (Register.tsx, BudgetMonth.tsx) — house style, not shared.
function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function amountColor(minor: number): string {
  if (minor > 0) return '#0a7a2f';
  if (minor < 0) return '#c0392b';
  return '#666';
}

function monthLabel(month: string): string {
  return new Date(`${month.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y! * 12 + (m! - 1) + delta;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  return `${String(newYear).padStart(4, '0')}-${String(newMonth).padStart(2, '0')}`;
}

interface FlatCategory {
  id: string;
  name: string;
  groupName: string;
}

/**
 * Drops the leading run of all-zero months (no account existed yet, or
 * every one was empty) from a net-worth series. Without this, "All" — a
 * generous fixed lookback rather than a real earliest-data query, see
 * ALL_TIME_MONTHS_BACK — buries a real few months of history under years
 * of flat $0 rows in both the chart and the table below it. Applied
 * unconditionally (not just for the "All" preset) since a hand-picked
 * custom start earlier than any data hits the same problem. A series
 * that's all zero (no accounts yet) is left alone — trimming it to
 * nothing would be worse than a flat line at $0.
 */
function trimLeadingZeros(months: NetWorthReport['months']): NetWorthReport['months'] {
  const firstActive = months.findIndex((m) => m.assetsMinor !== 0 || m.liabilitiesMinor !== 0);
  return firstActive <= 0 ? months : months.slice(firstActive);
}

type ReportTab = 'spending' | 'income-expense' | 'net-worth';

const TAB_LABELS: Record<ReportTab, string> = {
  spending: 'Spending by category',
  'income-expense': 'Income vs. expense',
  'net-worth': 'Net worth',
};

// Net worth is looked at over a very different horizon than the other two
// reports (often "all time" rather than "the last few months"), so it gets
// its own period control instead of sharing start/end with them. `months:
// null` is "All" — ALL_TIME_MONTHS_BACK years back is a generous ceiling,
// not a real earliest-data lookup (there's no endpoint for that); months
// before any transactions exist just render as a flat $0, which is the
// honest answer rather than a wrong one.
const ALL_TIME_MONTHS_BACK = 120; // 10 years
const NET_WORTH_PRESETS: { label: string; months: number | null }[] = [
  { label: '6M', months: 6 },
  { label: '1Y', months: 12 },
  { label: '2Y', months: 24 },
  { label: '5Y', months: 60 },
  { label: 'All', months: null },
];

/**
 * Three reports named in docs/plan.md's Phase 2 roadmap — spending by
 * category, income vs. expense, and net worth — now tabbed rather than
 * stacked on one page. Spending and income-vs-expense keep the original
 * shared start/end range; net worth gets its own period control (presets +
 * custom) and a line-chart view (NetWorthChart) alongside its table. Still
 * no charting *library* — see docs/plan.md's original "no charting
 * dependency" note — NetWorthChart is hand-rolled inline SVG, so that
 * decision holds even though a graph now exists.
 */
export function Reports({
  budgetId,
  categoryGroups,
  onOpenAccount,
}: {
  budgetId: string;
  categoryGroups: CategoryGroup[];
  /** Jumps to an account's register, where its exchange rate can be set — see AccountSettings. */
  onOpenAccount: (accountId: string) => void;
}) {
  const [tab, setTab] = useState<ReportTab>('spending');

  const [start, setStart] = useState(() => shiftMonth(currentMonth(), -5));
  const [end, setEnd] = useState(() => currentMonth());
  const [spending, setSpending] = useState<SpendingReport | null>(null);
  const [incomeExpense, setIncomeExpense] = useState<IncomeExpenseReport | null>(null);

  const [nwStart, setNwStart] = useState(() => shiftMonth(currentMonth(), -11));
  const [nwEnd, setNwEnd] = useState(() => currentMonth());
  const [nwPreset, setNwPreset] = useState<string | null>('1Y');
  const [netWorth, setNetWorth] = useState<NetWorthReport | null>(null);

  useEffect(() => {
    setSpending(null);
    setIncomeExpense(null);
    const params = `start=${start}&end=${end}`;
    apiFetch<SpendingReport>(`/budgets/${budgetId}/reports/spending?${params}`).then(setSpending);
    apiFetch<IncomeExpenseReport>(`/budgets/${budgetId}/reports/income-expense?${params}`).then(setIncomeExpense);
  }, [budgetId, start, end]);

  useEffect(() => {
    setNetWorth(null);
    apiFetch<NetWorthReport>(`/budgets/${budgetId}/reports/net-worth?start=${nwStart}&end=${nwEnd}`).then(setNetWorth);
  }, [budgetId, nwStart, nwEnd]);

  function applyNetWorthPreset(label: string, months: number | null) {
    const end = currentMonth();
    const start = shiftMonth(end, -((months ?? ALL_TIME_MONTHS_BACK) - 1));
    setNwStart(start);
    setNwEnd(end);
    setNwPreset(label);
  }

  const flatCategories: FlatCategory[] = categoryGroups.flatMap((g) =>
    g.categories.filter((c) => c.kind === 'spending').map((c) => ({ id: c.id, name: c.name, groupName: g.name })),
  );
  const categoryById = new Map(flatCategories.map((c) => [c.id, c]));

  const spendingRows = (spending?.categories ?? [])
    .map((row) => ({ ...row, category: categoryById.get(row.categoryId) }))
    .filter((row): row is typeof row & { category: FlatCategory } => row.category !== undefined)
    .sort((a, b) => a.spentMinor - b.spentMinor); // most spent (most negative) first

  return (
    <section>
      <h2>Reports</h2>

      <div role="tablist" style={{ display: 'flex', gap: '1.5rem', borderBottom: '1px solid #ddd', marginBottom: '1rem' }}>
        {(Object.keys(TAB_LABELS) as ReportTab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            style={{
              padding: '0.5rem 0',
              border: 'none',
              borderBottom: tab === t ? '2px solid #2a78d6' : '2px solid transparent',
              background: 'none',
              cursor: 'pointer',
              fontWeight: tab === t ? 'bold' : 'normal',
              fontSize: '1em',
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {(tab === 'spending' || tab === 'income-expense') && (
        <p>
          <label>
            From{' '}
            <input type="month" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>{' '}
          <label>
            Through{' '}
            <input type="month" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </p>
      )}

      {tab === 'spending' &&
        (spending === null ? (
          <p>Loading…</p>
        ) : spendingRows.length === 0 ? (
          <p>No spending in this range.</p>
        ) : (
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th align="left">Category</th>
                  <th align="left">Group</th>
                  <th align="right">Spent</th>
                </tr>
              </thead>
              <tbody>
                {spendingRows.map((row) => (
                  <tr key={row.categoryId} style={{ borderTop: '1px solid #ddd' }}>
                    <td>{row.category.name}</td>
                    <td>{row.category.groupName}</td>
                    <td align="right" style={{ color: amountColor(row.spentMinor) }}>
                      {formatMinor(row.spentMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'income-expense' &&
        (incomeExpense === null ? (
          <p>Loading…</p>
        ) : (
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th align="left">Month</th>
                  <th align="right">Income</th>
                  <th align="right">Expense</th>
                  <th align="right">Net</th>
                </tr>
              </thead>
              <tbody>
                {incomeExpense.months.map((m) => (
                  <tr key={m.month} style={{ borderTop: '1px solid #ddd' }}>
                    <td>{monthLabel(m.month)}</td>
                    <td align="right" style={{ color: amountColor(m.incomeMinor) }}>
                      {formatMinor(m.incomeMinor)}
                    </td>
                    <td align="right" style={{ color: amountColor(-m.expenseMinor) }}>
                      {formatMinor(m.expenseMinor)}
                    </td>
                    <td align="right" style={{ color: amountColor(m.incomeMinor - m.expenseMinor) }}>
                      {formatMinor(m.incomeMinor - m.expenseMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'net-worth' && (
        <>
          <p style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', gap: '0.25rem' }}>
              {NET_WORTH_PRESETS.map(({ label, months }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => applyNetWorthPreset(label, months)}
                  aria-pressed={nwPreset === label}
                  style={{
                    padding: '0.25rem 0.6rem',
                    border: '1px solid #ccc',
                    borderRadius: 4,
                    background: nwPreset === label ? '#2a78d6' : 'none',
                    color: nwPreset === label ? '#fff' : 'inherit',
                    fontWeight: nwPreset === label ? 'bold' : 'normal',
                    cursor: 'pointer',
                  }}
                >
                  {label}
                </button>
              ))}
            </span>
            <label>
              From{' '}
              <input
                type="month"
                value={nwStart}
                onChange={(e) => {
                  setNwStart(e.target.value);
                  setNwPreset(null);
                }}
              />
            </label>
            <label>
              Through{' '}
              <input
                type="month"
                value={nwEnd}
                onChange={(e) => {
                  setNwEnd(e.target.value);
                  setNwPreset(null);
                }}
              />
            </label>
          </p>

          {netWorth === null ? (
            <p>Loading…</p>
          ) : (
            <>
              {netWorth.unvalued.length > 0 && (
                <div style={{ color: '#c0392b', fontSize: '0.9em', marginBlock: '0.5rem' }}>
                  <p style={{ margin: 0 }}>
                    {netWorth.unvalued.length === 1 ? 'This account has' : 'These accounts have'} no exchange rate, so{' '}
                    {netWorth.unvalued.length === 1 ? 'its balance is an estimate' : 'their balances are estimates'} rather
                    than a real conversion:
                  </p>
                  <ul style={{ margin: '0.25rem 0 0' }}>
                    {netWorth.unvalued.map((a) => (
                      <li key={a.accountId}>
                        {a.name} ({a.currencyCode}) —{' '}
                        <button type="button" onClick={() => onOpenAccount(a.accountId)}>
                          Set a rate
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <NetWorthChart points={trimLeadingZeros(netWorth.months)} />

              <div className="table-scroll" style={{ marginTop: '1rem' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th align="left">Month</th>
                      <th align="right">Assets</th>
                      <th align="right">Liabilities</th>
                      <th align="right">Net worth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trimLeadingZeros(netWorth.months).map((m) => (
                      <tr key={m.month} style={{ borderTop: '1px solid #ddd' }}>
                        <td>{monthLabel(m.month)}</td>
                        <td align="right">{formatMinor(m.assetsMinor)}</td>
                        <td align="right" style={{ color: amountColor(m.liabilitiesMinor) }}>
                          {formatMinor(m.liabilitiesMinor)}
                        </td>
                        <td align="right" style={{ color: amountColor(m.netWorthMinor) }}>
                          {formatMinor(m.netWorthMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
