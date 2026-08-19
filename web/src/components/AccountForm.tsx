import { useState } from 'react';
import { apiFetch } from '../api';
import type { AccountType } from '../types';

const ACCOUNT_TYPES: { value: AccountType; label: string }[] = [
  { value: 'checking', label: 'Checking' },
  { value: 'savings', label: 'Savings' },
  { value: 'cash', label: 'Cash' },
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'line_of_credit', label: 'Line of Credit' },
  { value: 'tracking_asset', label: 'Tracking — Asset' },
  { value: 'tracking_liability', label: 'Tracking — Liability' },
];

export function AccountForm({ budgetId, onCreated, onCancel }: { budgetId: string; onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('checking');
  const [startingBalance, setStartingBalance] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const [importProvider, setImportProvider] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/accounts`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          type,
          startingBalance: startingBalance.trim() || undefined,
          currencyCode: currencyCode.trim() || undefined,
          importProvider: importProvider || undefined,
        }),
      });
      onCreated();
    } catch {
      setError('Could not create that account — check the name and starting balance.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ border: '1px solid #ccc', padding: '1rem', marginBlock: '0.5rem' }}>
      <div>
        <label>
          Name{' '}
          <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Checking" />
        </label>
      </div>
      <div>
        <label>
          Type{' '}
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {ACCOUNT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div>
        <label>
          Starting balance{' '}
          <input
            value={startingBalance}
            onChange={(e) => setStartingBalance(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
          />
        </label>
      </div>
      <div>
        <label>
          Currency{' '}
          <input
            value={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())}
            placeholder="(budget's)"
            maxLength={3}
            style={{ width: '5rem' }}
          />
        </label>
        {currencyCode.length === 3 && (
          <span style={{ color: '#666', fontSize: '0.9em' }}>
            {' '}
            — a currency other than your budget&apos;s is tracked but stays out of category budgeting.
          </span>
        )}
      </div>
      <div>
        <label>
          Statement files from{' '}
          <select value={importProvider} onChange={(e) => setImportProvider(e.target.value)}>
            <option value="">(none — manual entry)</option>
            <option value="wise">Wise</option>
            <option value="becu">BECU</option>
            <option value="splitwise">Splitwise</option>
            <option value="aacu">AACU</option>
          </select>
        </label>
      </div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? 'Creating…' : 'Create account'}
      </button>{' '}
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
