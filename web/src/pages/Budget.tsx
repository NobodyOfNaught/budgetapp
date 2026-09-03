import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { AccountForm } from '../components/AccountForm';
import { BudgetMonth } from '../components/BudgetMonth';
import { ImportForm } from '../components/ImportForm';
import { WiseProbe } from '../components/WiseProbe';
import { PayeeRules } from '../components/PayeeRules';
import { Register } from '../components/Register';
import { Reports } from '../components/Reports';
import { ReviewImport } from '../components/ReviewImport';
import type { Account, CategoryGroup, ReviewTransaction } from '../types';

// 'budget' is the landing view (the month screen), matching YNAB itself;
// picking an account switches to 'account'. Local state, not a URL route —
// see App.tsx's comment on why there's no router here yet.
type View =
  | { kind: 'budget' }
  | { kind: 'account'; accountId: string }
  | { kind: 'review' }
  | { kind: 'reports' }
  | { kind: 'rules' };

/**
 * One account in the sidebar, with the date of its newest transaction
 * beside it — the thing that makes a stale account (an import you meant to
 * run and didn't) visible without opening it.
 *
 * The date is rendered as the stored 'YYYY-MM-DD' verbatim, deliberately
 * NOT run through toLocaleDateString. These are calendar dates, not
 * instants: converting one to a local date means parsing it as UTC
 * midnight, which renders as the previous day in every western timezone.
 * Printing the stored string is both correct and sortable by eye down the
 * column.
 *
 * Shared by the on-budget and tracking lists rather than written twice.
 * The two were identical before this, which is exactly how a change lands
 * in one list and not the other — the same trap web/src/providers.ts
 * documents for provider dropdowns.
 */
function AccountListItem({
  account,
  selected,
  onSelect,
}: {
  account: Account;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.15rem' }}>
      <button onClick={onSelect} style={{ fontWeight: selected ? 'bold' : 'normal' }}>
        {account.name}
      </button>
      <span style={{ fontSize: '0.75rem', color: '#666', whiteSpace: 'nowrap' }}>
        {account.lastTransactionDate ?? 'none'}
      </span>
    </li>
  );
}

export function Budget({ budgetId, budgetCurrencyCode }: { budgetId: string; budgetCurrencyCode: string }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[] | null>(null);
  const [view, setView] = useState<View>({ kind: 'budget' });
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [showImportForm, setShowImportForm] = useState(false);
  const [showWiseProbe, setShowWiseProbe] = useState(false);
  // Count of imported-but-unapproved rows, for the Review badge.
  const [unapprovedCount, setUnapprovedCount] = useState(0);
  // Bumped every time reloadUnapproved runs — passed to ReviewImport so it
  // refetches even when an import lands while its tab is already open
  // (view.kind staying 'review' means it doesn't remount on its own).
  const [reviewVersion, setReviewVersion] = useState(0);
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

  function reloadUnapproved() {
    apiFetch<{ transactions: ReviewTransaction[] }>(`/budgets/${budgetId}/imports/review`).then((res) => {
      setUnapprovedCount(res.transactions.length);
      setReviewVersion((v) => v + 1);
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
    reloadUnapproved();
  }, [budgetId]);

  // Both start `null` specifically so this can tell "still loading" apart
  // from "loaded and genuinely empty" — see docs/plan.md's PR 6 notes.
  if (accounts === null || categoryGroups === null) return <p>Loading…</p>;

  const selectedAccount = view.kind === 'account' ? (accounts.find((a) => a.id === view.accountId) ?? null) : null;
  const onBudgetAccounts = accounts.filter((a) => a.onBudget && !a.closedAt);
  const trackingAccounts = accounts.filter((a) => !a.onBudget && !a.closedAt);

  return (
    <div className="budget-layout">
      <nav className="budget-nav">
        <ul style={{ listStyle: 'none', padding: 0 }}>
          <li>
            <button onClick={() => setView({ kind: 'budget' })} style={{ fontWeight: view.kind === 'budget' ? 'bold' : 'normal' }}>
              Budget
            </button>
          </li>
          <li>
            <button onClick={() => setView({ kind: 'review' })} style={{ fontWeight: view.kind === 'review' ? 'bold' : 'normal' }}>
              Review{unapprovedCount > 0 ? ` (${unapprovedCount})` : ''}
            </button>
          </li>
          <li>
            <button onClick={() => setView({ kind: 'reports' })} style={{ fontWeight: view.kind === 'reports' ? 'bold' : 'normal' }}>
              Reports
            </button>
          </li>
          <li>
            <button onClick={() => setView({ kind: 'rules' })} style={{ fontWeight: view.kind === 'rules' ? 'bold' : 'normal' }}>
              Payee rules
            </button>
          </li>
        </ul>

        <h3>Accounts</h3>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {onBudgetAccounts.map((a) => (
            <AccountListItem
              key={a.id}
              account={a}
              selected={view.kind === 'account' && view.accountId === a.id}
              onSelect={() => setView({ kind: 'account', accountId: a.id })}
            />
          ))}
        </ul>
        {trackingAccounts.length > 0 && (
          <>
            <h3>Tracking</h3>
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {trackingAccounts.map((a) => (
                <AccountListItem
                  key={a.id}
                  account={a}
                  selected={view.kind === 'account' && view.accountId === a.id}
                  onSelect={() => setView({ kind: 'account', accountId: a.id })}
                />
              ))}
            </ul>
          </>
        )}
        <button onClick={() => setShowAccountForm((v) => !v)}>{showAccountForm ? 'Cancel' : '+ Add account'}</button>
        {showAccountForm && (
          <AccountForm
            budgetId={budgetId}
            budgetCurrencyCode={budgetCurrencyCode}
            onCreated={() => {
              setShowAccountForm(false);
              reloadAccounts();
              reloadCategories(); // a credit account auto-creates a payment category
            }}
            onCancel={() => setShowAccountForm(false)}
          />
        )}
        {accounts.length > 0 && (
          <button onClick={() => setShowImportForm((v) => !v)}>{showImportForm ? 'Cancel' : 'Import file'}</button>
        )}
        <button onClick={() => setShowWiseProbe((v) => !v)}>{showWiseProbe ? 'Cancel' : 'Wise API probe'}</button>
        {showWiseProbe && <WiseProbe budgetId={budgetId} onCancel={() => setShowWiseProbe(false)} />}
        {showImportForm && (
          <ImportForm
            budgetId={budgetId}
            accounts={accounts}
            budgetCurrencyCode={budgetCurrencyCode}
            onImported={() => {
              // An import can create a currency sub-account and always adds
              // unapproved rows, so refresh both before the user lands on
              // the review queue.
              reloadAccounts();
              reloadUnapproved();
            }}
            onUndone={() => {
              // Same two things change in reverse: an undo can leave an
              // auto-created currency account behind (empty, but still
              // there — see src/routes/imports.ts's DELETE handler) and
              // always removes rows from the review queue.
              reloadAccounts();
              reloadUnapproved();
            }}
            onCancel={() => {
              setShowImportForm(false);
              setView({ kind: 'review' });
            }}
          />
        )}
      </nav>

      <div style={{ flex: 1 }}>
        {view.kind === 'budget' && (
          <BudgetMonth
            budgetId={budgetId}
            categoryGroups={categoryGroups}
            refreshToken={accountsVersion}
            hasAccounts={accounts.length > 0}
            onCategoriesChanged={reloadCategories}
          />
        )}
        {view.kind === 'review' && (
          <ReviewImport
            budgetId={budgetId}
            accounts={accounts}
            categoryGroups={categoryGroups}
            refreshToken={reviewVersion}
            onChanged={() => {
              reloadUnapproved();
              setAccountsVersion((v) => v + 1); // approving changes category activity
            }}
          />
        )}
        {view.kind === 'reports' && (
          <Reports
            budgetId={budgetId}
            categoryGroups={categoryGroups}
            onOpenAccount={(accountId) => setView({ kind: 'account', accountId })}
          />
        )}
        {view.kind === 'rules' && <PayeeRules budgetId={budgetId} categoryGroups={categoryGroups} />}
        {view.kind === 'account' &&
          (selectedAccount ? (
            <Register
              budgetId={budgetId}
              account={selectedAccount}
              accounts={accounts}
              categoryGroups={categoryGroups}
              budgetCurrencyCode={budgetCurrencyCode}
              onAccountChanged={() => {
                reloadAccounts();
                reloadCategories(); // renaming a credit account renames its payment category
              }}
            />
          ) : (
            <p>Add an account to get started.</p>
          ))}
      </div>
    </div>
  );
}
