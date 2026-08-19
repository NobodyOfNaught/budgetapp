import { useState } from 'react';
import { apiFetch } from '../api';
import type { Account, ImportSummary } from '../types';

const PROVIDERS: { value: string; label: string }[] = [
  { value: 'wise', label: 'Wise' },
  { value: 'becu', label: 'BECU' },
];

/**
 * Upload a statement file for one account. The file is read as text in the
 * browser and posted as a plain JSON string — statement exports are small
 * enough that this needs no multipart handling or object storage (see the
 * note at the top of src/routes/imports.ts).
 */
export function ImportForm({
  budgetId,
  accounts,
  onImported,
  onCancel,
}: {
  budgetId: string;
  accounts: Account[];
  /** Called after a successful import so the caller can refresh accounts and the review queue. */
  onImported: (summary: ImportSummary) => void;
  onCancel: () => void;
}) {
  const importable = accounts.filter((a) => !a.closedAt);
  const [accountId, setAccountId] = useState(importable[0]?.id ?? '');
  const [provider, setProvider] = useState('wise');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !accountId) return;
    setSubmitting(true);
    setError(null);
    try {
      const csv = await file.text();
      const result = await apiFetch<ImportSummary>(`/budgets/${budgetId}/imports`, {
        method: 'POST',
        body: JSON.stringify({ accountId, provider, filename: file.name, csv }),
      });
      setSummary(result);
      onImported(result);
    } catch {
      setError('Could not import that file — check it came from the provider you picked.');
    } finally {
      setSubmitting(false);
    }
  }

  if (summary) {
    return (
      <div style={{ border: '1px solid #ccc', padding: '1rem', marginBlock: '0.5rem' }}>
        <h3 style={{ marginTop: 0 }}>Imported</h3>
        <p>
          <strong>{summary.imported}</strong> added from {summary.rowCount} rows
          {summary.duplicates > 0 && <> · {summary.duplicates} already imported</>}
        </p>
        {summary.accountsCreated.length > 0 && (
          <p>
            Created {summary.accountsCreated.join(', ')} — the file used a currency this budget doesn&apos;t track, so it&apos;s
            held as a tracking account.
          </p>
        )}
        {summary.skipped.length > 0 && (
          <>
            <p style={{ marginBottom: '0.25rem' }}>Skipped {summary.skipped.length}:</p>
            <ul style={{ marginTop: 0 }}>
              {summary.skipped.map((s) => (
                <li key={s.reference} style={{ fontSize: '0.9em', color: '#666' }}>
                  {s.reference} — {s.reason}
                </li>
              ))}
            </ul>
          </>
        )}
        <p style={{ color: '#666' }}>Everything imported is waiting in Review until you approve it.</p>
        <button type="button" onClick={onCancel}>
          Done
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ border: '1px solid #ccc', padding: '1rem', marginBlock: '0.5rem' }}>
      <div>
        <label>
          Account{' '}
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
            {importable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currencyCode})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div>
        <label>
          From{' '}
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div>
        <label>
          File <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </label>
      </div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <button type="submit" disabled={submitting || !file}>
        {submitting ? 'Importing…' : 'Import'}
      </button>{' '}
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}
