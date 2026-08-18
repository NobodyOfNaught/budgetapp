import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { Account, CategoryGroup, RegisterResponse, RegisterTransaction } from '../types';
import { TransactionForm } from './TransactionForm';

function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

type FormState = { mode: 'ordinary' | 'transfer' | 'split'; editing: RegisterTransaction | null } | null;

export function Register({
  budgetId,
  account,
  accounts,
  categoryGroups,
}: {
  budgetId: string;
  account: Account;
  accounts: Account[];
  categoryGroups: CategoryGroup[];
}) {
  const [data, setData] = useState<RegisterResponse | null>(null);
  const [search, setSearch] = useState('');
  const [clearedOnly, setClearedOnly] = useState(false);
  const [form, setForm] = useState<FormState>(null);

  function reload() {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (clearedOnly) params.set('cleared', 'cleared');
    apiFetch<RegisterResponse>(`/budgets/${budgetId}/accounts/${account.id}/transactions?${params}`).then(setData);
  }

  useEffect(reload, [budgetId, account.id, search, clearedOnly]);

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this transaction?')) return;
    await apiFetch(`/budgets/${budgetId}/transactions/${id}`, { method: 'DELETE' });
    reload();
  }

  const categoryNameById = new Map(
    categoryGroups.flatMap((g) => g.categories).map((c) => [c.id, c.name]),
  );

  return (
    <section>
      <h2>{account.name}</h2>
      <p>
        Balance: <strong>{formatMinor(data?.accountBalance ?? 0)}</strong> · Cleared:{' '}
        {formatMinor(data?.clearedBalance ?? 0)}
      </p>

      <div>
        <input placeholder="Search payee or memo…" value={search} onChange={(e) => setSearch(e.target.value)} />{' '}
        <label>
          <input type="checkbox" checked={clearedOnly} onChange={(e) => setClearedOnly(e.target.checked)} /> Cleared only
        </label>
      </div>

      <p>
        <button onClick={() => setForm({ mode: 'ordinary', editing: null })}>+ Transaction</button>{' '}
        <button onClick={() => setForm({ mode: 'transfer', editing: null })}>+ Transfer</button>{' '}
        <button onClick={() => setForm({ mode: 'split', editing: null })}>+ Split</button>
      </p>

      {form && (
        <TransactionForm
          budgetId={budgetId}
          accountId={account.id}
          accounts={accounts}
          categoryGroups={categoryGroups}
          mode={form.mode}
          editing={form.editing}
          onSaved={() => {
            setForm(null);
            reload();
          }}
          onCancel={() => setForm(null)}
        />
      )}

      {data === null ? (
        <p>Loading…</p>
      ) : (
        <div className="table-scroll">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th align="left">Date</th>
                <th align="left">Payee</th>
                <th align="left">Category</th>
                <th align="left">Memo</th>
                <th align="right">Amount</th>
                <th align="right">Balance</th>
                <th>Cleared</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((t) => (
                <tr key={t.id} style={{ borderTop: '1px solid #ddd' }}>
                  <td>
                    {t.date}
                    {!t.approved && (
                      <span title="Imported — waiting in Review" style={{ color: '#b8860b' }}>
                        {' '}
                        ●
                      </span>
                    )}
                  </td>
                  <td>{t.payeeName ?? ''}</td>
                  <td>{t.isSplit ? '(split)' : t.categoryId ? (categoryNameById.get(t.categoryId) ?? '') : ''}</td>
                  <td>{t.memo ?? ''}</td>
                  <td align="right">{formatMinor(t.amountMinor)}</td>
                  <td align="right">{formatMinor(t.balance)}</td>
                  <td align="center">{t.cleared !== 'uncleared' ? '✓' : ''}</td>
                  <td>
                    {!t.isSplit && !t.transferAccountId && (
                      <button onClick={() => setForm({ mode: 'ordinary', editing: t })}>Edit</button>
                    )}
                    {t.transferAccountId && <button onClick={() => setForm({ mode: 'transfer', editing: t })}>Edit</button>}
                    {t.isSplit && <button onClick={() => setForm({ mode: 'split', editing: t })}>Edit</button>}{' '}
                    <button onClick={() => handleDelete(t.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.transactions.length === 0 && <p>No transactions yet.</p>}
        </div>
      )}
    </section>
  );
}
