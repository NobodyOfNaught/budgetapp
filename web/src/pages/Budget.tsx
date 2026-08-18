import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { AccountForm } from '../components/AccountForm';
import { Register } from '../components/Register';
import type { Account, CategoryGroup } from '../types';

export function Budget({ budgetId }: { budgetId: string }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [showAccountForm, setShowAccountForm] = useState(false);

  function reloadAccounts() {
    apiFetch<{ accounts: Account[] }>(`/budgets/${budgetId}/accounts`).then((res) => {
      setAccounts(res.accounts);
      setSelectedAccountId((current) => current ?? res.accounts[0]?.id ?? null);
    });
  }

  function reloadCategories() {
    apiFetch<{ groups: CategoryGroup[] }>(`/budgets/${budgetId}/categories`).then((res) => setCategoryGroups(res.groups));
  }

  // reloadAccounts/reloadCategories close over budgetId and are recreated
  // every render, not memoized — deliberately depending on [budgetId] alone
  // so this only re-fetches when the budget actually changes.
  useEffect(() => {
    reloadAccounts();
    reloadCategories();
  }, [budgetId]);

  const selectedAccount = accounts?.find((a) => a.id === selectedAccountId) ?? null;
  const onBudgetAccounts = (accounts ?? []).filter((a) => a.onBudget && !a.closedAt);
  const trackingAccounts = (accounts ?? []).filter((a) => !a.onBudget && !a.closedAt);

  return (
    <div style={{ display: 'flex', gap: '2rem' }}>
      <nav style={{ minWidth: '12rem' }}>
        <h3>Accounts</h3>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {onBudgetAccounts.map((a) => (
            <li key={a.id}>
              <button
                onClick={() => setSelectedAccountId(a.id)}
                style={{ fontWeight: a.id === selectedAccountId ? 'bold' : 'normal' }}
              >
                {a.name}
              </button>
            </li>
          ))}
        </ul>
        {trackingAccounts.length > 0 && (
          <>
            <h3>Tracking</h3>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {trackingAccounts.map((a) => (
                <li key={a.id}>
                  <button
                    onClick={() => setSelectedAccountId(a.id)}
                    style={{ fontWeight: a.id === selectedAccountId ? 'bold' : 'normal' }}
                  >
                    {a.name}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <button onClick={() => setShowAccountForm((v) => !v)}>{showAccountForm ? 'Cancel' : '+ Add account'}</button>
        {showAccountForm && (
          <AccountForm
            budgetId={budgetId}
            onCreated={() => {
              setShowAccountForm(false);
              reloadAccounts();
              reloadCategories(); // a credit account auto-creates a payment category
            }}
            onCancel={() => setShowAccountForm(false)}
          />
        )}
      </nav>

      <div style={{ flex: 1 }}>
        {selectedAccount ? (
          <Register budgetId={budgetId} account={selectedAccount} accounts={accounts ?? []} categoryGroups={categoryGroups} />
        ) : (
          <p>Add an account to get started.</p>
        )}
      </div>
    </div>
  );
}
