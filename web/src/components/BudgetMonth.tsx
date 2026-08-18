import { Fragment, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { CategoryGroup, MonthView } from '../types';

function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function toDraft(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Green/red/muted for a signed minor-unit amount — used for Available, Activity, and RTA. */
function amountColor(minor: number): string {
  if (minor > 0) return '#0a7a2f';
  if (minor < 0) return '#c0392b';
  return '#666';
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

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

interface FlatCategory {
  id: string;
  name: string;
  groupName: string;
}

export function BudgetMonth({
  budgetId,
  categoryGroups,
  refreshToken,
}: {
  budgetId: string;
  categoryGroups: CategoryGroup[];
  /** Bump this (from the parent) to force a re-fetch — see Budget.tsx's comment. */
  refreshToken?: number;
}) {
  const [month, setMonth] = useState(currentMonth);
  const [view, setView] = useState<MonthView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [moveOpenFor, setMoveOpenFor] = useState<string | null>(null);
  const [moveAmount, setMoveAmount] = useState('');
  const [moveTargetId, setMoveTargetId] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reload() {
    apiFetch<MonthView>(`/budgets/${budgetId}/months/${month}`).then((res) => {
      setView(res);
      setDrafts(Object.fromEntries(Object.entries(res.categories).map(([id, c]) => [id, toDraft(c.assigned)])));
    });
  }

  useEffect(reload, [budgetId, month, refreshToken]);

  const assignable: FlatCategory[] = categoryGroups.flatMap((g) =>
    g.categories.filter((c) => c.kind !== 'income' && !c.hiddenAt).map((c) => ({ id: c.id, name: c.name, groupName: g.name })),
  );

  async function putAssignments(assignments: { categoryId: string; assigned: string }[]) {
    setError(null);
    try {
      const res = await apiFetch<MonthView>(`/budgets/${budgetId}/months/${month}/assignments`, {
        method: 'PUT',
        body: JSON.stringify({ assignments }),
      });
      setView(res);
      setDrafts(Object.fromEntries(Object.entries(res.categories).map(([id, c]) => [id, toDraft(c.assigned)])));
    } catch {
      setError('Could not save — check the amount and try again.');
      reload(); // drop the bad draft back to the last known-good server state
    }
  }

  function commitAssigned(categoryId: string) {
    const draft = drafts[categoryId] ?? '';
    const current = view?.categories[categoryId]?.assigned ?? 0;
    if (draft.trim() === toDraft(current)) return; // unchanged — nothing to save
    putAssignments([{ categoryId, assigned: draft.trim() === '' ? '0' : draft }]);
  }

  function toggleMove(categoryId: string) {
    if (moveOpenFor === categoryId) {
      setMoveOpenFor(null);
      return;
    }
    setMoveOpenFor(categoryId);
    setMoveAmount('');
    setMoveTargetId(assignable.find((c) => c.id !== categoryId)?.id ?? '');
  }

  async function submitMove(fromCategoryId: string) {
    if (!view || !moveTargetId || !moveAmount.trim()) return;
    const amountMinor = Math.round(parseFloat(moveAmount) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      setError('Move amount must be a positive number.');
      return;
    }
    const fromAssigned = view.categories[fromCategoryId]?.assigned ?? 0;
    const toAssigned = view.categories[moveTargetId]?.assigned ?? 0;
    await putAssignments([
      { categoryId: fromCategoryId, assigned: toDraft(fromAssigned - amountMinor) },
      { categoryId: moveTargetId, assigned: toDraft(toAssigned + amountMinor) },
    ]);
    setMoveOpenFor(null);
  }

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Previous month">
          ←
        </button>
        <h2 style={{ margin: 0 }}>{monthLabel(month)}</h2>
        <button onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="Next month">
          →
        </button>
      </div>

      <div
        style={{
          margin: '1rem 0',
          padding: '1rem',
          borderRadius: '0.5rem',
          background: '#f4f4f4',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <strong>Ready to Assign</strong>
        <strong style={{ color: amountColor(view?.readyToAssign ?? 0), fontSize: '1.25rem' }}>
          {formatMinor(view?.readyToAssign ?? 0)}
        </strong>
      </div>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Category</th>
            <th align="right">Assigned</th>
            <th align="right">Activity</th>
            <th align="right">Available</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {categoryGroups.map((group) => {
            const rows = group.categories.filter((c) => c.kind !== 'income' && !c.hiddenAt);
            if (rows.length === 0) return null;
            return (
              <Fragment key={group.id}>
                <tr>
                  <td colSpan={5} style={{ paddingTop: '1rem', fontWeight: 'bold', borderBottom: '1px solid #ccc' }}>
                    {group.name}
                  </td>
                </tr>
                {rows.map((c) => {
                  const amounts = view?.categories[c.id] ?? { assigned: 0, activity: 0, available: 0 };
                  return (
                    <Fragment key={c.id}>
                      <tr style={{ borderTop: '1px solid #eee' }}>
                        <td>{c.name}</td>
                        <td align="right">
                          <input
                            value={drafts[c.id] ?? ''}
                            onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                            onBlur={() => commitAssigned(c.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            }}
                            style={{ width: '6rem', textAlign: 'right' }}
                          />
                        </td>
                        <td align="right" style={{ color: amountColor(amounts.activity) }}>
                          {formatMinor(amounts.activity)}
                        </td>
                        <td align="right" style={{ color: amountColor(amounts.available), fontWeight: 'bold' }}>
                          {formatMinor(amounts.available)}
                        </td>
                        <td>
                          <button onClick={() => toggleMove(c.id)}>Move</button>
                        </td>
                      </tr>
                      {moveOpenFor === c.id && (
                        <tr>
                          <td colSpan={5} style={{ background: '#fafafa', padding: '0.5rem' }}>
                            Move{' '}
                            <input
                              value={moveAmount}
                              onChange={(e) => setMoveAmount(e.target.value)}
                              placeholder="0.00"
                              style={{ width: '5rem' }}
                            />{' '}
                            to{' '}
                            <select value={moveTargetId} onChange={(e) => setMoveTargetId(e.target.value)}>
                              {assignable
                                .filter((opt) => opt.id !== c.id)
                                .map((opt) => (
                                  <option key={opt.id} value={opt.id}>
                                    {opt.groupName}: {opt.name}
                                  </option>
                                ))}
                            </select>{' '}
                            <button onClick={() => submitMove(c.id)}>Confirm</button>{' '}
                            <button onClick={() => setMoveOpenFor(null)}>Cancel</button>
                            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85em', color: '#666' }}>
                              Moves budgeted money from this category to the one you pick — the same move covers
                              overspending: move it into whichever category is negative.
                            </p>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
