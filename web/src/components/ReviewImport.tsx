import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { CategoryGroup, ReviewTransaction } from '../types';

function formatMinor(minor: number, currencyCode: string): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const amount = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  // Foreign-currency rows show their code, since "$" would be a lie on a
  // CAD leg sitting next to USD ones in the same list.
  return `${sign}${amount} ${currencyCode}`;
}

/** Green/red/muted for a signed minor-unit amount — same idiom as BudgetMonth/Register. */
function amountColor(minor: number): string {
  if (minor > 0) return '#0a7a2f';
  if (minor < 0) return '#c0392b';
  return '#666';
}

/**
 * The "approve imported transactions" queue from docs/plan.md's phase-4
 * notes. Imported rows are real transactions that already move balances and
 * Ready to Assign — this screen is where they get a category and a human's
 * confirmation, not a gate they sit behind.
 */
export function ReviewImport({
  budgetId,
  categoryGroups,
  onChanged,
}: {
  budgetId: string;
  categoryGroups: CategoryGroup[];
  /** Bumped after approvals so the caller can refresh its unapproved-count badge. */
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ReviewTransaction[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    apiFetch<{ transactions: ReviewTransaction[] }>(`/budgets/${budgetId}/imports/review`).then((res) => {
      setRows(res.transactions);
      setDrafts(Object.fromEntries(res.transactions.map((t) => [t.id, t.categoryId ?? ''])));
    });
  }

  useEffect(reload, [budgetId]);

  const assignable = categoryGroups.flatMap((g) =>
    g.categories.filter((c) => c.kind !== 'income' && !c.hiddenAt).map((c) => ({ id: c.id, name: c.name, groupName: g.name })),
  );

  async function approve(ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/imports/review`, {
        method: 'PATCH',
        body: JSON.stringify({
          updates: ids.map((id) => ({ transactionId: id, categoryId: drafts[id] || null, approved: true })),
        }),
      });
      reload();
      onChanged();
    } catch {
      setError('Could not save those — try again.');
    } finally {
      setBusy(false);
    }
  }

  if (rows === null) return <p>Loading…</p>;

  if (rows.length === 0) {
    return (
      <section>
        <h2>Review</h2>
        <p>Nothing waiting to be reviewed. Imported transactions show up here until you approve them.</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Review</h2>
      <p style={{ color: '#666' }}>
        {rows.length} imported {rows.length === 1 ? 'transaction' : 'transactions'}. These already affect your balances — approving
        just confirms the category.
      </p>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}

      <p>
        <button onClick={() => approve(rows.map((r) => r.id))} disabled={busy}>
          {busy ? 'Saving…' : 'Approve all'}
        </button>
      </p>

      <div className="table-scroll">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Date</th>
              <th align="left">Account</th>
              <th align="left">Payee</th>
              <th align="right">Amount</th>
              <th align="left">Category</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} style={{ borderTop: '1px solid #eee' }}>
                <td>{row.date}</td>
                <td>{row.accountName}</td>
                <td>{row.payeeName ?? row.importPayeeRaw ?? ''}</td>
                <td align="right" style={{ color: amountColor(row.amountMinor), fontVariantNumeric: 'tabular-nums' }}>
                  {formatMinor(row.amountMinor, row.currencyCode)}
                </td>
                <td>
                  {row.transferAccountId ? (
                    <span style={{ color: '#666' }}>(transfer)</span>
                  ) : (
                    <select value={drafts[row.id] ?? ''} onChange={(e) => setDrafts((d) => ({ ...d, [row.id]: e.target.value }))}>
                      <option value="">(uncategorized)</option>
                      {assignable.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.groupName}: {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  <button onClick={() => approve([row.id])} disabled={busy}>
                    Approve
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
