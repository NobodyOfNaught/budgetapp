import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { AccountForm } from '../components/AccountForm';
import { BudgetMonth } from '../components/BudgetMonth';
import { Register } from '../components/Register';
import type { Account, CategoryGroup } from '../types';

// 'budget' is the landing view (the month screen), matching YNAB itself;
// picking an account switches to 'account'. Local state, not a URL route —
// see App.tsx's comment on why there's no router here yet.
type View = { kind: 'budget' } | { kind: 'account'; accountId: string };

export function Budget({ budgetId }: { budgetId: string }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>([]);
  const [view, setView] = useState<View>({ kind: 'budget' });
  const [showAccountForm, setShowAccountForm] = useState(false);
  // Bumped whenever an account is created — a new account (starting balance
  // as income, or a fresh credit-card payment category) can change Ready to
  // Assign and category availability. BudgetMonth stays mounted while an
  // account is added from the nav sidebar (the view doesn't change), so its
  // own fetch-on-mount effect won't see this on its own; passing this token
  // in as a prop gives it a dependency to re-fetch on instead.
  const [accountsVersion, setAccountsVersion] = useState(0);

  function reloadAccounts() {
    apiFetch<{ accounts: Account[] }>(`/budgets/${budgetId}/accounts`).then((res) => {
      setAccounts(res.accounts);
      setAccountsVersion((v) => v + 1);
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

  const selectedAccount = view.kind === 'account' ? (accounts?.find((a) => a.id === view.accountId) ?? null) : null;
  const onBudgetAccounts = (accounts ?? []).filter((a) => a.onBudget && !a.closedAt);
  const trackingAccounts = (accounts ?? []).filter((a) => !a.onBudget && !a.closedAt);

  return (
    <div style={{ display: 'flex', gap: '2rem' }}>
      <nav style={{ minWidth: '12rem' }}>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          <li>
            <button onClick={() => setView({ kind: 'budget' })} style={{ fontWeight: view.kind === 'budget' ? 'bold' : 'normal' }}>
              Budget
            </button>
          </li>
        </ul>

        <h3>Accounts</h3>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {onBudgetAccounts.map((a) => (
            <li key={a.id}>
              <button
                onClick={() => setView({ kind: 'account', accountId: a.id })}
                style={{ fontWeight: view.kind === 'account' && view.accountId === a.id ? 'bold' : 'normal' }}
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
                    onClick={() => setView({ kind: 'account', accountId: a.id })}
                    style={{ fontWeight: view.kind === 'account' && view.accountId === a.id ? 'bold' : 'normal' }}
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
        {view.kind === 'budget' && (
          <BudgetMonth budgetId={budgetId} categoryGroups={categoryGroups} refreshToken={accountsVersion} />
        )}
        {view.kind === 'account' &&
          (selectedAccount ? (
            <Register budgetId={budgetId} account={selectedAccount} accounts={accounts ?? []} categoryGroups={categoryGroups} />
          ) : (
            <p>Add an account to get started.</p>
          ))}
      </div>
    </div>
  );
}
