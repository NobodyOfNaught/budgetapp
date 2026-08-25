import { Fragment, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { Account, CategoryGroup, ReviewTransaction } from '../types';
import { TransactionForm } from './TransactionForm';

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
 *
 * With "Show approved too" ticked, the same screen also lists everything
 * ELSE in the budget — the mechanism for catching a mistake that already
 * slipped past approval (an uncategorized starting balance, a purchase
 * filed under the wrong category), rather than needing to hunt for it
 * account by account in the Register. Same table, same edit affordances;
 * only the `approved` filter widens.
 */
export function ReviewImport({
  budgetId,
  accounts,
  categoryGroups,
  refreshToken,
  onChanged,
}: {
  budgetId: string;
  /** Passed straight through to TransactionForm when editing a row — see Register.tsx's identical use. */
  accounts: Account[];
  categoryGroups: CategoryGroup[];
  /**
   * Bumped by the caller after an import lands. Needed because Budget.tsx
   * only mounts this component while its own view is 'review' — importing
   * a file while that tab is ALREADY open (not navigating to it fresh)
   * doesn't remount ReviewImport, so without this the table would keep
   * showing whatever it fetched on its last mount. See Budget.tsx's
   * reviewVersion.
   */
  refreshToken: number;
  /** Bumped after approvals so the caller can refresh its unapproved-count badge. */
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ReviewTransaction[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Off by default — the unapproved-only queue is what most visits are
  // for, and a whole-budget listing is heavier (see REVIEW_ROW_LIMIT on
  // the API side) and a different kind of task: an audit, not a queue.
  const [showApproved, setShowApproved] = useState(false);
  // The one row (if any) whose "Make rule" form is open — matched against
  // its importPayeeRaw, prefilled from the heuristic's own best-effort
  // name as a starting point to refine. See src/import/payee-name.ts and
  // src/import/rules.ts for why rules match the raw text, never the
  // heuristic's output.
  const [ruleDraftFor, setRuleDraftFor] = useState<string | null>(null);
  const [ruleMatchText, setRuleMatchText] = useState('');
  const [rulePayeeName, setRulePayeeName] = useState('');
  const [ruleCategoryId, setRuleCategoryId] = useState('');
  const [ruleBusy, setRuleBusy] = useState(false);
  // The row (if any) open in the full edit form — date/amount/payee/memo,
  // not just the category dropdown below. Mode mirrors Register.tsx's own
  // logic for picking one: a row is exactly one of split, transfer, or
  // ordinary, decided by its own shape rather than something the caller
  // chooses.
  const [editForm, setEditForm] = useState<{ mode: 'ordinary' | 'transfer' | 'split'; editing: ReviewTransaction } | null>(
    null,
  );

  function reload() {
    const qs = showApproved ? '?includeApproved=true' : '';
    apiFetch<{ transactions: ReviewTransaction[] }>(`/budgets/${budgetId}/imports/review${qs}`).then((res) => {
      setRows(res.transactions);
      setDrafts(Object.fromEntries(res.transactions.map((t) => [t.id, t.categoryId ?? ''])));
    });
  }

  useEffect(reload, [budgetId, refreshToken, showApproved]);

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

  function openRuleForm(row: ReviewTransaction) {
    setRuleDraftFor(row.id);
    setRuleMatchText(row.payeeName ?? row.importPayeeRaw ?? '');
    setRulePayeeName(row.payeeName ?? '');
    setRuleCategoryId(row.categoryId ?? '');
  }

  async function saveRule(e: React.FormEvent) {
    e.preventDefault();
    setRuleBusy(true);
    setError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/payee-rules`, {
        method: 'POST',
        body: JSON.stringify({ matchText: ruleMatchText, payeeName: rulePayeeName, categoryId: ruleCategoryId || null }),
      });
      // Immediately re-apply so the row that motivated the rule (and any
      // other unapproved row it also matches) reflects it right away,
      // rather than only affecting future imports.
      await apiFetch(`/budgets/${budgetId}/payee-rules/apply`, { method: 'POST' });
      setRuleDraftFor(null);
      reload();
    } catch {
      setError('Could not save that rule — check both fields are filled in.');
    } finally {
      setRuleBusy(false);
    }
  }

  if (rows === null) return <p>Loading…</p>;

  const unapprovedIds = rows.filter((r) => !r.approved).map((r) => r.id);

  return (
    <section>
      <h2>Review</h2>
      <p>
        <label>
          <input type="checkbox" checked={showApproved} onChange={(e) => setShowApproved(e.target.checked)} /> Show approved
          transactions too
        </label>{' '}
        <span style={{ color: '#666' }}>
          — for catching a mistake that already slipped past approval, not just what's waiting on one.
        </span>
      </p>

      {rows.length === 0 ? (
        <p>
          {showApproved
            ? 'No transactions found.'
            : 'Nothing waiting to be reviewed. Imported transactions show up here until you approve them.'}
        </p>
      ) : (
        <>
          <p style={{ color: '#666' }}>
            {showApproved ? (
              <>
                {rows.length} {rows.length === 1 ? 'transaction' : 'transactions'}
                {unapprovedIds.length > 0 && <> — {unapprovedIds.length} still awaiting approval</>}.
              </>
            ) : (
              <>
                {rows.length} imported {rows.length === 1 ? 'transaction' : 'transactions'}. These already affect your
                balances — approving just confirms the category.
              </>
            )}
          </p>
          {error && <p style={{ color: '#c0392b' }}>{error}</p>}

          {unapprovedIds.length > 0 && (
            <p>
              <button onClick={() => approve(unapprovedIds)} disabled={busy}>
                {busy ? 'Saving…' : `Approve all (${unapprovedIds.length})`}
              </button>
            </p>
          )}

          {editForm && (
            <TransactionForm
              budgetId={budgetId}
              accountId={editForm.editing.accountId}
              accounts={accounts}
              categoryGroups={categoryGroups}
              mode={editForm.mode}
              editing={editForm.editing}
              onSaved={() => {
                setEditForm(null);
                reload();
                onChanged();
              }}
              onCancel={() => setEditForm(null)}
            />
          )}

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
            {rows.map((row) => {
              const displayName = row.payeeName ?? row.importPayeeRaw ?? '';
              // Only show the raw text separately when it actually adds
              // information — most non-BECU rows have nothing to show
              // beyond what's already displayed.
              const showRaw = row.importPayeeRaw && row.importPayeeRaw !== displayName;
              return (
                <Fragment key={row.id}>
                  <tr style={{ borderTop: '1px solid #eee' }}>
                    <td>
                      {row.date}
                      {!row.approved && (
                        <span title="Not yet approved" style={{ color: '#b8860b' }}>
                          {' '}
                          ●
                        </span>
                      )}
                    </td>
                    <td>{row.accountName}</td>
                    <td>
                      {displayName}
                      {showRaw && (
                        <div style={{ fontSize: '0.85em', color: '#666' }}>{row.importPayeeRaw}</div>
                      )}
                      {/* The other leg, spelled out. Its amount is shown
                          rather than left implied because the two legs
                          need not mirror each other — a conversion or a
                          fee makes them genuinely different numbers. */}
                      {row.transferAccountName && row.transferAmountMinor !== null && (
                        <div style={{ fontSize: '0.85em', color: '#666' }}>
                          ↔ {row.transferAccountName} · {row.transferDate} ·{' '}
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {formatMinor(row.transferAmountMinor, row.transferCurrencyCode ?? row.currencyCode)}
                          </span>
                        </div>
                      )}
                      {row.feeForAccountName && row.feeForAmountMinor !== null && (
                        <div style={{ fontSize: '0.85em', color: '#666' }}>
                          fee on the transfer from {row.feeForAccountName} · {row.feeForDate} ·{' '}
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {formatMinor(row.feeForAmountMinor, row.feeForCurrencyCode ?? row.currencyCode)}
                          </span>
                        </div>
                      )}
                    </td>
                    <td align="right" style={{ color: amountColor(row.amountMinor), fontVariantNumeric: 'tabular-nums' }}>
                      {formatMinor(row.amountMinor, row.currencyCode)}
                    </td>
                    <td>
                      {row.isSplit ? (
                        // The category lives on its (unlisted) children, same as Register's own column — nothing to pick here.
                        <span style={{ color: '#666' }}>(split)</span>
                      ) : row.transferAccountId ? (
                        <span style={{ color: '#666' }}>
                          {row.transferAccountName ? `Transfer : ${row.transferAccountName}` : '(transfer)'}
                        </span>
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
                      {/* Not for a split parent — its categoryId is null by
                          construction (the category lives on its unlisted
                          children) and a manually-created split is always
                          already approved; imports never produce one, so
                          this case is dead in practice, not just skipped.
                          A transfer leg has no category either, but IS
                          commonly unapproved straight out of import — the
                          PATCH endpoint and "Approve all" both handle it
                          like any other row (drafts[row.id] is simply
                          empty, so this sends categoryId: null), so hiding
                          the per-row button here would only take away a
                          working path, not guard a broken one. */}
                      {!row.isSplit && (
                        <>
                          <button onClick={() => approve([row.id])} disabled={busy}>
                            {row.approved ? 'Save' : 'Approve'}
                          </button>{' '}
                        </>
                      )}
                      {row.isSplit ? (
                        <button type="button" onClick={() => setEditForm({ mode: 'split', editing: row })}>
                          Edit
                        </button>
                      ) : row.transferAccountId ? (
                        <button type="button" onClick={() => setEditForm({ mode: 'transfer', editing: row })}>
                          Edit
                        </button>
                      ) : (
                        <button type="button" onClick={() => setEditForm({ mode: 'ordinary', editing: row })}>
                          Edit
                        </button>
                      )}{' '}
                      {row.importPayeeRaw && (
                        <button type="button" onClick={() => (ruleDraftFor === row.id ? setRuleDraftFor(null) : openRuleForm(row))}>
                          {ruleDraftFor === row.id ? 'Cancel' : 'Make rule'}
                        </button>
                      )}
                    </td>
                  </tr>
                  {ruleDraftFor === row.id && (
                    <tr style={{ borderTop: '1px solid #eee', background: '#fafafa' }}>
                      <td colSpan={6}>
                        <form onSubmit={saveRule} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', padding: '0.5rem 0' }}>
                          <span style={{ color: '#666' }}>Raw text: “{row.importPayeeRaw}”</span>
                          <label>
                            If it contains{' '}
                            <input value={ruleMatchText} onChange={(e) => setRuleMatchText(e.target.value)} required />
                          </label>
                          <label>
                            call it{' '}
                            <input value={rulePayeeName} onChange={(e) => setRulePayeeName(e.target.value)} required />
                          </label>
                          <label>
                            category{' '}
                            <select value={ruleCategoryId} onChange={(e) => setRuleCategoryId(e.target.value)}>
                              <option value="">(leave as-is)</option>
                              {assignable
                                .filter((c) => c.groupName !== 'Credit Card Payments')
                                .map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.groupName}: {c.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <button type="submit" disabled={ruleBusy}>
                            {ruleBusy ? 'Saving…' : 'Save rule'}
                          </button>
                        </form>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
          </div>
        </>
      )}
    </section>
  );
}
