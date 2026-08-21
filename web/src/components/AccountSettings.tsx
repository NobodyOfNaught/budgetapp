import { useState } from 'react';
import { apiFetch } from '../api';
import { IMPORT_PROVIDER_OPTIONS } from '../providers';
import type { Account } from '../types';

/** Micros (accounts.fxRateMicros) back to a plain decimal string, e.g. 730000 -> "0.73". Mirrors ImportForm's formatFxRate. */
function formatFxRate(micros: number): string {
  return (micros / 1_000_000).toString();
}

/**
 * Editing an existing account — the caller for PATCH
 * /budgets/:id/accounts/:accountId, which until now the API supported and
 * nothing in the UI ever invoked. Two things live here:
 *
 * - **Rename.** Currency sub-accounts are auto-named after whatever the
 *   primary account was called at import time (`Wise (CAD)` — see
 *   resolveCurrencyAccount in src/routes/imports.ts), so a later rename of
 *   the primary leaves the pair mismatched with no way to fix it. Renaming
 *   a credit account also renames its payment category, server-side.
 * - **Which statement parser its files use.** Settable when creating the
 *   account (PR 7) but not afterwards until now — so an account set up
 *   before a provider existed, or pointed at the wrong one, was stuck.
 * - **Exchange rate**, for an account whose currency isn't the budget's.
 *   Previously settable only when CREATING an account or while running an
 *   import into it, which left an existing account like an auto-created
 *   currency sub-account with no path to a rate at all — and net worth
 *   can't value a foreign balance without one (see src/domain/reports.ts).
 *
 * Deliberately does NOT flip onBudget: the API never recomputes it on
 * PATCH (see src/routes/accounts.ts), so adding a rate to a tracking
 * account gives its balance a real value without silently dragging it into
 * category budgeting.
 */
export function AccountSettings({
  budgetId,
  account,
  budgetCurrencyCode,
  onSaved,
  onCancel,
}: {
  budgetId: string;
  account: Account;
  budgetCurrencyCode: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(account.name);
  const [fxRate, setFxRate] = useState(account.fxRateMicros != null ? formatFxRate(account.fxRateMicros) : '');
  const [importProvider, setImportProvider] = useState(account.importProvider ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isForeign = account.currencyCode !== budgetCurrencyCode;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/accounts/${account.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          // Empty means "no parser" — null, not omitted, so it can be cleared.
          importProvider: importProvider || null,
          // An emptied field means "forget the rate" — null, not omitted,
          // since omitting leaves the stored one untouched.
          ...(isForeign ? { fxRate: fxRate.trim() || null } : {}),
        }),
      });
      onSaved();
    } catch {
      setError('Could not save that — check the name and the exchange rate.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ border: '1px solid #ccc', padding: '1rem', marginBlock: '0.5rem' }}>
      <div>
        <label>
          Name <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
      </div>
      <div style={{ marginTop: '0.5rem' }}>
        <label>
          Statement files from{' '}
          <select value={importProvider} onChange={(e) => setImportProvider(e.target.value)}>
            <option value="">(none — manual entry)</option>
            {IMPORT_PROVIDER_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {isForeign && (
        <div style={{ marginTop: '0.5rem' }}>
          <label>
            Exchange rate (1 {account.currencyCode} = ? {budgetCurrencyCode}){' '}
            <input
              value={fxRate}
              onChange={(e) => setFxRate(e.target.value)}
              placeholder="e.g. 0.73"
              inputMode="decimal"
              style={{ width: '6rem' }}
            />
          </label>
          <p style={{ color: '#666', fontSize: '0.9em', margin: '0.25rem 0 0' }}>
            Used to value this account&apos;s balance in {budgetCurrencyCode} on the net worth report, and to convert
            anything imported or entered here from now on. Existing transactions keep the rate they were recorded at.
          </p>
        </div>
      )}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <p style={{ marginBottom: 0 }}>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save'}
        </button>{' '}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </form>
  );
}
