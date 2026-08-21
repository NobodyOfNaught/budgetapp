import { Fragment, useEffect, useState } from 'react';
import { ApiError, apiFetch } from '../api';
import type { CategoryGroup, MonthView, TargetStatus, TargetView } from '../types';
import { CategoryForm } from './CategoryForm';
import { CategoryGroupForm } from './CategoryGroupForm';
import { TargetForm } from './TargetForm';
import { UpcomingPanel } from './UpcomingPanel';

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

/** Unlike amountColor, a positive Needed is the thing to flag, not celebrate — zero is the good outcome here. */
function neededColor(status: TargetStatus): string {
  if (status === 'funded') return '#0a7a2f';
  if (status === 'building') return '#666';
  return '#c0392b';
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

/**
 * What actually backs Ready to Assign.
 *
 * Ready to Assign is "money not yet given a job", which is NOT the same as
 * "cash you have" the moment a credit card is involved — a card purchase
 * moves money twice (the spending category falls, the card's payment
 * category rises) while the card balance falls, so Ready to Assign can sit
 * well above the cash on hand with the difference being debt nobody has
 * budgeted for. That gap is invisible from the number alone, and it is
 * exactly the thing that makes the headline figure look healthier than the
 * budget is, so it is spelled out rather than left to be worked out.
 */
function Reconciliation({ view, categoryGroups }: { view: MonthView; categoryGroups: CategoryGroup[] }) {
  const paymentCategoryIds = new Set(
    categoryGroups.flatMap((g) => g.categories.filter((c) => c.kind === 'credit_card_payment').map((c) => c.id)),
  );

  let paymentShortfall = 0;
  let overspent = 0;
  for (const [id, amounts] of Object.entries(view.categories)) {
    if (amounts.available >= 0) continue;
    if (paymentCategoryIds.has(id)) paymentShortfall += amounts.available;
    else overspent += amounts.available;
  }

  const uncoveredByCash = view.readyToAssign - view.cashOnHandMinor;

  return (
    <div style={{ fontSize: '0.9em', color: '#666', margin: '0 0 0.75rem' }}>
      <span>Cash in budget accounts: {formatMinor(view.cashOnHandMinor)}</span>
      {view.creditDebtMinor !== 0 && <span> · Card balances: {formatMinor(view.creditDebtMinor)}</span>}
      {paymentShortfall < 0 && (
        <span style={{ color: '#c0392b' }}> · Card debt not yet budgeted for: {formatMinor(paymentShortfall)}</span>
      )}
      {overspent < 0 && (
        <span style={{ color: '#c0392b' }}> · Overspent this month: {formatMinor(overspent)}</span>
      )}
      {uncoveredByCash > 0 && (
        <div style={{ color: '#a56a00', marginTop: '0.25rem' }}>
          Ready to Assign is {formatMinor(uncoveredByCash)} more than the cash in your budget accounts — assigning all
          of it would spend money the accounts don&apos;t hold.
        </div>
      )}
    </div>
  );
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
  hasAccounts,
  onCategoriesChanged,
}: {
  budgetId: string;
  categoryGroups: CategoryGroup[];
  /** Bump this (from the parent) to force a re-fetch — see Budget.tsx's comment. */
  refreshToken?: number;
  /** Whether the budget has any accounts at all — drives the "add an account" empty-state hint below. */
  hasAccounts: boolean;
  /** Called after any category/group create, rename, hide, or delete — the parent's reloadCategories. */
  onCategoriesChanged: () => void;
}) {
  const [month, setMonth] = useState(currentMonth);
  const [view, setView] = useState<MonthView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [moveOpenFor, setMoveOpenFor] = useState<string | null>(null);
  const [moveAmount, setMoveAmount] = useState('');
  const [moveTargetId, setMoveTargetId] = useState('');
  const [rawTargets, setRawTargets] = useState<Record<string, TargetView>>({});
  const [targetOpenFor, setTargetOpenFor] = useState<string | null>(null);
  // Bumped after a target is saved/removed — passed to UpcomingPanel so its
  // own fetch (real-clock-anchored, not month-scoped — see that
  // component's doc comment) picks up the change too.
  const [targetsVersion, setTargetsVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Category/group CRUD — kept inline here rather than a separate nav tab,
  // since this grid is where categories are viewed constantly. See
  // docs/plan.md's PR 12 notes.
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [addCategoryForGroup, setAddCategoryForGroup] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  // Separate from `error` (assignment save failures) so a category-CRUD
  // error can't clobber, or get clobbered by, an unrelated one.
  const [categoryError, setCategoryError] = useState<string | null>(null);

  function reload() {
    apiFetch<MonthView>(`/budgets/${budgetId}/months/${month}`).then((res) => {
      setView(res);
      setDrafts(Object.fromEntries(Object.entries(res.categories).map(([id, c]) => [id, toDraft(c.assigned)])));
    });
  }

  function reloadTargets() {
    apiFetch<{ targets: TargetView[] }>(`/budgets/${budgetId}/targets`).then((res) =>
      setRawTargets(Object.fromEntries(res.targets.map((t) => [t.categoryId, t]))),
    );
  }

  useEffect(reload, [budgetId, month, refreshToken]);
  // Targets aren't month-scoped, so budgetId is the only real dependency —
  // month/refreshToken are listed anyway so a target set from elsewhere
  // (none currently, but cheap insurance) can't leave this stale.
  useEffect(reloadTargets, [budgetId, month, refreshToken]);

  function targetSaved() {
    setTargetOpenFor(null);
    setTargetsVersion((v) => v + 1);
    reloadTargets();
    reload(); // the month view's `targets` (Needed/status) also needs refreshing
  }

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

  /**
   * Assign exactly enough to bring an overspent category back to zero.
   *
   * `available` is negative here, so `assigned - available` ADDS its
   * magnitude — Boogie at assigned 0.00 / available -64.73 becomes
   * assigned 64.73. Computed from the server's own numbers rather than
   * the draft input, so a half-typed value sitting in the box can't be
   * folded into the total.
   *
   * Deliberately not a "cover everything" sweep: the money has to come
   * from Ready to Assign, and which overspending to cover first is a real
   * decision when there isn't enough to go round.
   */
  async function coverOverspending(categoryId: string) {
    const amounts = view?.categories[categoryId];
    if (!amounts || amounts.available >= 0) return;
    await putAssignments([{ categoryId, assigned: toDraft(amounts.assigned - amounts.available) }]);
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

  function toggleTarget(categoryId: string) {
    setTargetOpenFor((current) => (current === categoryId ? null : categoryId));
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

  function startEditGroup(group: CategoryGroup) {
    setEditingGroupId(group.id);
    setEditingGroupName(group.name);
  }

  async function renameGroup(groupId: string) {
    setCategoryError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/categories/groups/${groupId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editingGroupName }),
      });
      setEditingGroupId(null);
      onCategoriesChanged();
    } catch {
      setCategoryError('Could not rename that group.');
    }
  }

  async function toggleHideGroup(groupId: string, hide: boolean) {
    setCategoryError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/categories/groups/${groupId}`, {
        method: 'PATCH',
        body: JSON.stringify({ hidden: hide }),
      });
      onCategoriesChanged();
    } catch {
      setCategoryError('Could not update that group.');
    }
  }

  async function deleteGroup(groupId: string, name: string) {
    if (!window.confirm(`Delete "${name}"? This only works while it has no categories left.`)) return;
    setCategoryError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/categories/groups/${groupId}`, { method: 'DELETE' });
      onCategoriesChanged();
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { error?: string } | undefined)?.error : undefined;
      setCategoryError(
        code === 'group_not_empty'
          ? `"${name}" still has categories in it — move or delete them first.`
          : 'Could not delete that group.',
      );
    }
  }

  function startEditCategory(category: { id: string; name: string }) {
    setEditingCategoryId(category.id);
    setEditingCategoryName(category.name);
  }

  async function renameCategory(categoryId: string) {
    setCategoryError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/categories/${categoryId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editingCategoryName }),
      });
      setEditingCategoryId(null);
      onCategoriesChanged();
    } catch {
      setCategoryError('Could not rename that category.');
    }
  }

  async function toggleHideCategory(categoryId: string, hide: boolean) {
    setCategoryError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/categories/${categoryId}`, {
        method: 'PATCH',
        body: JSON.stringify({ hidden: hide }),
      });
      onCategoriesChanged();
    } catch {
      setCategoryError('Could not update that category.');
    }
  }

  async function deleteCategory(categoryId: string, name: string) {
    if (!window.confirm(`Delete "${name}"? History is kept, but it stops appearing anywhere new.`)) return;
    setCategoryError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/categories/${categoryId}`, { method: 'DELETE' });
      onCategoriesChanged();
    } catch {
      setCategoryError('Could not delete that category.');
    }
  }

  const hiddenCount = categoryGroups.flatMap((g) => g.categories).filter((c) => c.kind !== 'income' && c.hiddenAt).length;

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

      {view === null ? (
        <p>Loading…</p>
      ) : (
        <>
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

        {view && <Reconciliation view={view} categoryGroups={categoryGroups} />}

        {error && <p style={{ color: '#c0392b' }}>{error}</p>}

        {!hasAccounts && <p>Add an account to get started — categories won't show real activity until you do.</p>}

        <UpcomingPanel budgetId={budgetId} refreshToken={targetsVersion} />

        <div className="table-scroll">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th align="left">Category</th>
                <th align="right">Assigned</th>
                <th align="right">Activity</th>
                <th align="right">Available</th>
                <th align="right">Needed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {categoryGroups.map((group) => {
                const rows = group.categories.filter((c) => c.kind !== 'income' && (showHidden || !c.hiddenAt));
                const nonIncomeCount = group.categories.filter((c) => c.kind !== 'income').length;
                // A genuinely empty group (nonIncomeCount === 0 — e.g. just
                // created) always shows, so it can be used at all. A group
                // whose categories are all hidden collapses away when
                // showHidden is off, same as before this PR.
                if (rows.length === 0 && nonIncomeCount > 0) return null;
                return (
                  <Fragment key={group.id}>
                    <tr>
                      <td colSpan={6} style={{ paddingTop: '1rem', fontWeight: 'bold', borderBottom: '1px solid #ccc' }}>
                        {editingGroupId === group.id ? (
                          <>
                            <input value={editingGroupName} onChange={(e) => setEditingGroupName(e.target.value)} autoFocus />{' '}
                            <button onClick={() => renameGroup(group.id)} style={{ fontWeight: 'normal' }}>
                              Save
                            </button>{' '}
                            <button onClick={() => setEditingGroupId(null)} style={{ fontWeight: 'normal' }}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <span style={group.hiddenAt ? { color: '#999' } : undefined}>{group.name}</span>
                        )}
                        {!group.isSystem && editingGroupId !== group.id && (
                          <span style={{ fontWeight: 'normal', marginLeft: '0.75rem' }}>
                            <button onClick={() => startEditGroup(group)}>Rename</button>{' '}
                            <button onClick={() => toggleHideGroup(group.id, !group.hiddenAt)}>
                              {group.hiddenAt ? 'Unhide' : 'Hide'}
                            </button>{' '}
                            {rows.length === 0 && (
                              <button onClick={() => deleteGroup(group.id, group.name)}>Delete</button>
                            )}{' '}
                            <button onClick={() => setAddCategoryForGroup((g) => (g === group.id ? null : group.id))}>
                              + Add category
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                    {addCategoryForGroup === group.id && (
                      <tr>
                        <td colSpan={6} style={{ background: '#fafafa', padding: '0.5rem' }}>
                          <CategoryForm
                            budgetId={budgetId}
                            groupId={group.id}
                            onCreated={() => {
                              setAddCategoryForGroup(null);
                              onCategoriesChanged();
                            }}
                            onCancel={() => setAddCategoryForGroup(null)}
                          />
                        </td>
                      </tr>
                    )}
                    {rows.map((c) => {
                      const amounts = view?.categories[c.id] ?? { assigned: 0, activity: 0, available: 0 };
                      const target = view?.targets[c.id];
                      return (
                        <Fragment key={c.id}>
                          <tr style={{ borderTop: '1px solid #eee' }}>
                            <td>
                              {editingCategoryId === c.id ? (
                                <>
                                  <input
                                    value={editingCategoryName}
                                    onChange={(e) => setEditingCategoryName(e.target.value)}
                                    autoFocus
                                  />{' '}
                                  <button onClick={() => renameCategory(c.id)}>Save</button>{' '}
                                  <button onClick={() => setEditingCategoryId(null)}>Cancel</button>
                                </>
                              ) : (
                                <span style={c.hiddenAt ? { color: '#999' } : undefined}>{c.name}</span>
                              )}
                            </td>
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
                              {/* Only offered where it means something —
                                  an already-covered category has nothing
                                  to cover, so the button isn't there to
                                  be clicked by mistake. */}
                              {amounts.available < 0 && (
                                <>
                                  {' '}
                                  <button
                                    type="button"
                                    onClick={() => coverOverspending(c.id)}
                                    title={`Assign ${formatMinor(-amounts.available)} to bring this back to $0.00`}
                                    style={{ fontWeight: 'normal' }}
                                  >
                                    Cover
                                  </button>
                                </>
                              )}
                            </td>
                            <td align="right" style={{ color: target ? neededColor(target.status) : '#999' }}>
                              {target ? (
                                target.status === 'funded' ? '✓ funded' : target.status === 'building' ? 'building' : formatMinor(target.neededMinor)
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>
                              <button onClick={() => toggleTarget(c.id)}>{rawTargets[c.id] ? 'Edit target' : 'Set target'}</button>{' '}
                              <button onClick={() => toggleMove(c.id)}>Move</button>
                              {c.kind === 'spending' && editingCategoryId !== c.id && (
                                <>
                                  {' '}
                                  <button onClick={() => startEditCategory(c)}>Rename</button>{' '}
                                  <button onClick={() => toggleHideCategory(c.id, !c.hiddenAt)}>
                                    {c.hiddenAt ? 'Unhide' : 'Hide'}
                                  </button>{' '}
                                  <button onClick={() => deleteCategory(c.id, c.name)}>Delete</button>
                                </>
                              )}
                            </td>
                          </tr>
                          {moveOpenFor === c.id && (
                            <tr>
                              <td colSpan={6} style={{ background: '#fafafa', padding: '0.5rem' }}>
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
                          {targetOpenFor === c.id && (
                            <tr>
                              <td colSpan={6} style={{ background: '#fafafa', padding: '0.5rem' }}>
                                <TargetForm
                                  budgetId={budgetId}
                                  categoryId={c.id}
                                  existing={rawTargets[c.id]}
                                  onSaved={targetSaved}
                                  onCleared={targetSaved}
                                  onCancel={() => setTargetOpenFor(null)}
                                />
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
        </div>

        {categoryError && <p style={{ color: '#c0392b' }}>{categoryError}</p>}

        <p>
          <button onClick={() => setShowGroupForm((v) => !v)}>{showGroupForm ? 'Cancel' : '+ Add group'}</button>
          {showGroupForm && (
            <CategoryGroupForm
              budgetId={budgetId}
              onCreated={() => {
                setShowGroupForm(false);
                onCategoriesChanged();
              }}
              onCancel={() => setShowGroupForm(false)}
            />
          )}
          {hiddenCount > 0 && (
            <button onClick={() => setShowHidden((v) => !v)} style={{ marginLeft: '0.5rem' }}>
              {showHidden ? 'Hide hidden' : `Show hidden (${hiddenCount})`}
            </button>
          )}
        </p>
        </>
      )}
    </section>
  );
}
