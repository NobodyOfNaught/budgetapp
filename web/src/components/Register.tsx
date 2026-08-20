import { Fragment, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { AccountSettings } from './AccountSettings';
import type { Account, CategoryGroup, RegisterResponse, RegisterTransaction, TransferCandidate } from '../types';
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
  budgetCurrencyCode,
  onAccountChanged,
}: {
  budgetId: string;
  account: Account;
  accounts: Account[];
  categoryGroups: CategoryGroup[];
  budgetCurrencyCode: string;
  /** Renaming or re-rating an account changes the sidebar and the net worth report — see AccountSettings. */
  onAccountChanged: () => void;
}) {
  const [data, setData] = useState<RegisterResponse | null>(null);
  const [search, setSearch] = useState('');
  const [clearedOnly, setClearedOnly] = useState(false);
  const [form, setForm] = useState<FormState>(null);
  const [editingAccount, setEditingAccount] = useState(false);
  // Which row's "Link transfer" panel is open, and what the server offered
  // for it. `null` candidates means the fetch is still in flight — see
  // src/routes/transactions.ts's transfer-candidates endpoint.
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<TransferCandidate[] | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

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

  async function toggleLinkPanel(id: string) {
    setLinkError(null);
    if (linkingId === id) {
      setLinkingId(null);
      return;
    }
    setLinkingId(id);
    setCandidates(null);
    const res = await apiFetch<{ candidates: TransferCandidate[] }>(
      `/budgets/${budgetId}/transactions/${id}/transfer-candidates`,
    );
    setCandidates(res.candidates);
  }

  async function handleLink(id: string, otherTransactionId: string) {
    setLinkError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/transactions/${id}/link-transfer`, {
        method: 'POST',
        body: JSON.stringify({ otherTransactionId }),
      });
      setLinkingId(null);
      reload();
    } catch {
      setLinkError('Could not link those two — reload and try again.');
    }
  }

  async function handleUnlink(id: string) {
    // Worth spelling out: the two rows survive as ordinary transactions,
    // unlike Delete, which removes BOTH halves of a transfer at once.
    if (!window.confirm('Unlink this transfer? Both transactions stay, just no longer linked.')) return;
    await apiFetch(`/budgets/${budgetId}/transactions/${id}/unlink-transfer`, { method: 'POST' });
    reload();
  }

  const categoryNameById = new Map(
    categoryGroups.flatMap((g) => g.categories).map((c) => [c.id, c.name]),
  );

  return (
    <section>
      <h2>
        {account.name}{' '}
        <button type="button" onClick={() => setEditingAccount((v) => !v)} style={{ fontSize: '0.6em', fontWeight: 'normal', verticalAlign: 'middle' }}>
          {editingAccount ? 'Cancel' : 'Edit'}
        </button>
      </h2>
      <p>
        Balance: <strong>{formatMinor(data?.accountBalance ?? 0)}</strong> · Cleared:{' '}
        {formatMinor(data?.clearedBalance ?? 0)}
        {account.currencyCode !== budgetCurrencyCode && (
          <>
            {' '}· in {account.currencyCode}
            {account.fxRateMicros === null && (
              <span style={{ color: '#c0392b' }}> · no exchange rate — its value in {budgetCurrencyCode} is an estimate</span>
            )}
          </>
        )}
      </p>
      {editingAccount && (
        <AccountSettings
          budgetId={budgetId}
          account={account}
          budgetCurrencyCode={budgetCurrencyCode}
          onSaved={() => {
            setEditingAccount(false);
            onAccountChanged();
          }}
          onCancel={() => setEditingAccount(false)}
        />
      )}

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
                <Fragment key={t.id}>
                <tr style={{ borderTop: '1px solid #ddd' }}>
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
                    {/* Only an ordinary, uncategorized row can become half
                        of a transfer — the same rule the API enforces, so
                        the button never appears where it would 400. */}
                    {!t.isSplit && !t.transferAccountId && !t.categoryId && (
                      <>
                        <button onClick={() => toggleLinkPanel(t.id)}>
                          {linkingId === t.id ? 'Cancel link' : 'Link transfer'}
                        </button>{' '}
                      </>
                    )}
                    {t.transferAccountId && <button onClick={() => handleUnlink(t.id)}>Unlink</button>}{' '}
                    <button onClick={() => handleDelete(t.id)}>Delete</button>
                  </td>
                </tr>
                {linkingId === t.id && (
                  <tr>
                    <td colSpan={8} style={{ background: '#fafafa', padding: '0.5rem' }}>
                      {candidates === null ? (
                        <span style={{ color: '#666' }}>Looking for a matching transaction…</span>
                      ) : candidates.length === 0 ? (
                        <span style={{ color: '#666' }}>
                          No match found — nothing in another account has the opposite amount within a few days.
                        </span>
                      ) : (
                        <>
                          <p style={{ margin: '0 0 0.25rem' }}>Link this to:</p>
                          {candidates.map((cand) => (
                            <div key={cand.id} style={{ marginBottom: '0.25rem' }}>
                              <button onClick={() => handleLink(t.id, cand.id)}>Link</button>{' '}
                              <strong>{cand.accountName}</strong> · {cand.date} · {formatMinor(cand.amountMinor)}
                              {cand.importPayeeRaw && <span style={{ color: '#666' }}> · {cand.importPayeeRaw}</span>}
                            </div>
                          ))}
                        </>
                      )}
                      {linkError && <p style={{ color: '#c0392b', margin: '0.25rem 0 0' }}>{linkError}</p>}
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {data.transactions.length === 0 && <p>No transactions yet.</p>}
        </div>
      )}
    </section>
  );
}
