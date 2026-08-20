import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { CategoryGroup, IncomeExpenseReport, NetWorthReport, SpendingReport } from '../types';

// Same formatMinor/amountColor duplication as every other screen
// (Register.tsx, BudgetMonth.tsx) — house style, not shared, per those
// files' own comments.
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
 * Three reports named in docs/plan.md's Phase 2 roadmap — spending by
 * category, income vs. expense, and net worth — over a shared start/end
 * month range. Plain HTML tables throughout: this app has no charting
 * dependency (see src/routes/reports.ts's doc comment), and every other
 * screen (Register, BudgetMonth, UpcomingPanel) is a table with the same
 * formatMinor idiom, so this stays consistent rather than being the first
 * screen to introduce one.
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
  const [start, setStart] = useState(() => shiftMonth(currentMonth(), -5));
  const [end, setEnd] = useState(() => currentMonth());
  const [spending, setSpending] = useState<SpendingReport | null>(null);
  const [incomeExpense, setIncomeExpense] = useState<IncomeExpenseReport | null>(null);
  const [netWorth, setNetWorth] = useState<NetWorthReport | null>(null);

  useEffect(() => {
    setSpending(null);
    setIncomeExpense(null);
    setNetWorth(null);
    const params = `start=${start}&end=${end}`;
    apiFetch<SpendingReport>(`/budgets/${budgetId}/reports/spending?${params}`).then(setSpending);
    apiFetch<IncomeExpenseReport>(`/budgets/${budgetId}/reports/income-expense?${params}`).then(setIncomeExpense);
    apiFetch<NetWorthReport>(`/budgets/${budgetId}/reports/net-worth?${params}`).then(setNetWorth);
  }, [budgetId, start, end]);

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

      <h3>Spending by category</h3>
      {spending === null ? (
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
      )}

      <h3>Income vs. expense</h3>
      {incomeExpense === null ? (
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
      )}

      <h3>Net worth</h3>
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
        <div className="table-scroll">
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
              {netWorth.months.map((m) => (
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
    </section>
  );
}
