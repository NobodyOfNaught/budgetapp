import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { Account, ImportBatch, ImportSummary } from '../types';

const PROVIDERS: { value: string; label: string }[] = [
  { value: 'wise', label: 'Wise' },
  { value: 'becu', label: 'BECU' },
];

function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Upload a statement file for one account. The file is read as text in the
 * browser and posted as a plain JSON string — statement exports are small
 * enough that this needs no multipart handling or object storage (see the
 * note at the top of src/routes/imports.ts).
 *
 * Also lists recent import runs with an Undo button (DELETE
 * .../imports/:batchId, built in PR 7 but never wired to anything in the
 * UI until now) — reachable any time this panel is open, not just in the
 * one-shot summary shown right after a successful import. That distinction
 * matters: picking the wrong account is a mistake usually noticed AFTER
 * navigating away from the summary, not during it.
 */
export function ImportForm({
  budgetId,
  accounts,
  onImported,
  onUndone,
  onCancel,
}: {
  budgetId: string;
  accounts: Account[];
  /** Called after a successful import so the caller can refresh accounts and the review queue. */
  onImported: (summary: ImportSummary) => void;
  /** Called after a successful undo, for the same reason. */
  onUndone: () => void;
  onCancel: () => void;
}) {
  const importable = accounts.filter((a) => !a.closedAt);
  const [accountId, setAccountId] = useState(importable[0]?.id ?? '');
  const [provider, setProvider] = useState('wise');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [history, setHistory] = useState<ImportBatch[] | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  function loadHistory() {
    apiFetch<{ batches: ImportBatch[] }>(`/budgets/${budgetId}/imports`).then((res) => setHistory(res.batches));
  }

  useEffect(loadHistory, [budgetId]);

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
      loadHistory();
    } catch {
      setError('Could not import that file — check it came from the provider you picked.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUndo(batchId: string) {
    if (!window.confirm('Undo this import? Every transaction it added will be removed.')) return;
    setUndoingId(batchId);
    try {
      await apiFetch(`/budgets/${budgetId}/imports/${batchId}`, { method: 'DELETE' });
      loadHistory();
      onUndone();
    } finally {
      setUndoingId(null);
    }
  }

  const historyPanel = history !== null && history.length > 0 && (
    <div style={{ marginTop: '1rem' }}>
      <h3 style={{ marginBottom: '0.5rem' }}>Recent imports</h3>
      <div className="table-scroll">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">When</th>
              <th align="left">Account</th>
              <th align="left">File</th>
              <th align="right">Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.map((b) => (
              <tr key={b.id} style={{ borderTop: '1px solid #eee' }}>
                <td>{formatWhen(b.createdAt)}</td>
                <td>{b.accountName}</td>
                <td>{b.filename}</td>
                <td align="right">{b.importedCount}</td>
                <td>
                  <button type="button" onClick={() => handleUndo(b.id)} disabled={undoingId === b.id}>
                    {undoingId === b.id ? 'Undoing…' : 'Undo'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

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
        <p>
          Wrong account, or the wrong file?{' '}
          <button type="button" onClick={() => handleUndo(summary.batchId)} disabled={undoingId === summary.batchId}>
            {undoingId === summary.batchId ? 'Undoing…' : 'Undo this import'}
          </button>
        </p>
        <button type="button" onClick={onCancel}>
          Done
        </button>
      </div>
    );
  }

  return (
    <div>
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
      {historyPanel}
    </div>
  );
}
