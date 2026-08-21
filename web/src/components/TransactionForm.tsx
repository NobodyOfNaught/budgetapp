import { useEffect, useId, useState } from 'react';
import { apiFetch } from '../api';
import type { Account, CategoryGroup, EditableTransaction } from '../types';

type Mode = 'ordinary' | 'transfer' | 'split';

interface SplitRow {
  amount: string;
  categoryId: string;
}

export function TransactionForm({
  budgetId,
  accountId,
  accounts,
  categoryGroups,
  mode,
  editing,
  onSaved,
  onCancel,
}: {
  budgetId: string;
  accountId: string;
  accounts: Account[];
  categoryGroups: CategoryGroup[];
  /**
   * Which shape to create — the caller (Register's "+ Transaction" / "+
   * Transfer" / "+ Split" buttons) decides this up front, there's no
   * in-form switcher. When `editing` is set this is derived from the
   * existing transaction instead and can't be changed: the API itself
   * refuses to change shape via PATCH (see src/routes/transactions.ts).
   * Editing an existing split's breakdown isn't wired up in this form yet
   * (the register list doesn't carry child details) — delete and recreate
   * for that; everything else about a split is editable.
   */
  mode: Mode;
  editing?: EditableTransaction | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const payeeListId = useId();
  const isEditing = !!editing;

  const [date, setDate] = useState(editing?.date ?? new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(editing ? (editing.amountMinor / 100).toFixed(2) : '');
  const [payeeName, setPayeeName] = useState(editing?.payeeName ?? '');
  const [categoryId, setCategoryId] = useState(editing?.categoryId ?? '');
  const [memo, setMemo] = useState(editing?.memo ?? '');
  const [cleared, setCleared] = useState(editing?.cleared ?? 'uncleared');
  const [transferToAccountId, setTransferToAccountId] = useState('');
  const [splits, setSplits] = useState<SplitRow[]>([
    { amount: '', categoryId: '' },
    { amount: '', categoryId: '' },
  ]);
  const [payeeOptions, setPayeeOptions] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ payees: { name: string }[] }>(`/budgets/${budgetId}/payees`)
      .then((res) => setPayeeOptions(res.payees.map((p) => p.name)))
      .catch(() => setPayeeOptions([]));
  }, [budgetId]);

  const allCategories = categoryGroups.flatMap((g) => g.categories.filter((c) => c.kind === 'spending'));
  const otherAccounts = accounts.filter((a) => a.id !== accountId);

  function updateSplit(index: number, patch: Partial<SplitRow>) {
    setSplits((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (isEditing && editing) {
        await apiFetch(`/budgets/${budgetId}/transactions/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            date,
            memo: memo || null,
            cleared,
            ...(mode === 'ordinary' ? { amount, categoryId: categoryId || null, payeeName: payeeName || undefined } : {}),
            ...(mode === 'transfer' ? { categoryId: categoryId || null } : {}),
          }),
        });
      } else if (mode === 'transfer') {
        await apiFetch(`/budgets/${budgetId}/transactions`, {
          method: 'POST',
          body: JSON.stringify({
            kind: 'transfer',
            accountId,
            transferToAccountId,
            date,
            amount,
            categoryId: categoryId || undefined,
            memo: memo || null,
            cleared,
          }),
        });
      } else if (mode === 'split') {
        await apiFetch(`/budgets/${budgetId}/transactions`, {
          method: 'POST',
          body: JSON.stringify({
            kind: 'split',
            accountId,
            date,
            payeeName: payeeName || undefined,
            memo: memo || null,
            cleared,
            splits: splits
              .filter((s) => s.amount.trim() !== '')
              .map((s) => ({ amount: s.amount, categoryId: s.categoryId || null })),
          }),
        });
      } else {
        await apiFetch(`/budgets/${budgetId}/transactions`, {
          method: 'POST',
          body: JSON.stringify({
            kind: 'ordinary',
            accountId,
            date,
            amount,
            payeeName: payeeName || undefined,
            categoryId: categoryId || undefined,
            memo: memo || null,
            cleared,
          }),
        });
      }
      onSaved();
    } catch {
      setError('Could not save that transaction — check the amount and required fields.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
      style={{ border: '1px solid #ccc', padding: '1rem', marginBlock: '0.5rem' }}
    >
      <div>
        <label>
          Date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
      </div>

      {mode === 'transfer' ? (
        <div>
          <label>
            Transfer to{' '}
            <select value={transferToAccountId} onChange={(e) => setTransferToAccountId(e.target.value)} required={!isEditing} disabled={isEditing}>
              <option value="">Select account…</option>
              {otherAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <div>
          <label>
            Payee{' '}
            <input list={payeeListId} value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="Start typing…" />
          </label>
          <datalist id={payeeListId}>
            {payeeOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      )}

      {mode !== 'split' && (
        <div>
          <label>
            Amount{' '}
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={mode === 'transfer' ? '50.00' : '-12.34'}
              inputMode="decimal"
              required
              disabled={isEditing && mode !== 'ordinary'}
              autoFocus
            />
          </label>
          {mode === 'ordinary' && <span style={{ color: '#666' }}> (negative = outflow, positive = inflow)</span>}
        </div>
      )}

      {(mode === 'ordinary' || mode === 'transfer') && (
        <div>
          <label>
            Category{' '}
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">
                {mode === 'transfer' ? '(none — plain transfer)' : '(uncategorized)'}
              </option>
              {allCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {mode === 'split' &&
        splits.map((row, i) => (
          <div key={i}>
            <input
              value={row.amount}
              onChange={(e) => updateSplit(i, { amount: e.target.value })}
              placeholder="-10.00"
              inputMode="decimal"
              style={{ width: '6rem' }}
              autoFocus={i === 0}
            />{' '}
            <select value={row.categoryId} onChange={(e) => updateSplit(i, { categoryId: e.target.value })}>
              <option value="">(uncategorized)</option>
              {allCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      {mode === 'split' && (
        <button type="button" onClick={() => setSplits((rows) => [...rows, { amount: '', categoryId: '' }])}>
          + Another split
        </button>
      )}

      <div>
        <label>
          Memo <input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
      </div>
      <div>
        <label>
          <input type="checkbox" checked={cleared !== 'uncleared'} onChange={(e) => setCleared(e.target.checked ? 'cleared' : 'uncleared')} />{' '}
          Cleared
        </label>
      </div>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : isEditing ? 'Save changes' : 'Add transaction'}
      </button>{' '}
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
