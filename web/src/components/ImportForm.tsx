import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../api';
import type { Account, ImportBatch, ImportSummary } from '../types';

const PROVIDERS: { value: string; label: string }[] = [
  { value: 'wise', label: 'Wise' },
  { value: 'becu', label: 'BECU' },
  { value: 'splitwise', label: 'Splitwise' },
  { value: 'aacu', label: 'AACU' },
  { value: 'neo', label: 'Neo Mastercard' },
];

/** The account's saved import_options.members, if any — see migrations/0006 and src/routes/imports.ts. */
function savedMembers(account: Account | undefined): string[] {
  if (!account?.importOptions) return [];
  try {
    const parsed = JSON.parse(account.importOptions) as { members?: string[] };
    return parsed.members ?? [];
  } catch {
    return [];
  }
}

function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Micros (accounts.fxRateMicros) back to a plain decimal string for the input field, e.g. 730000 -> "0.73". */
function formatFxRate(micros: number): string {
  return (micros / 1_000_000).toString();
}

// Every `{ error: '<code>' }` src/routes/imports.ts's POST handler can
// return. Previously ALL of these (plus a genuinely unparseable file) fell
// through to one generic "check it came from the provider you picked"
// message — actively misleading for e.g. invalid_fx_rate, which has
// nothing to do with the provider. A real Neo import failed on exactly
// this: a comma-decimal rate ("0,73") 400'd as invalid_fx_rate, and the
// generic message sent the search everywhere except the rate field.
const IMPORT_ERROR_MESSAGES: Record<string, string> = {
  unknown_provider: 'Unknown provider — try picking it again.',
  invalid_account: 'That account could not be found.',
  invalid_options: 'Pick at least one person before importing.',
  invalid_fx_rate: 'That exchange rate isn’t a valid number — e.g. 0.73.',
  missing_fx_rate: 'This account needs an exchange rate to import into — enter one above.',
  could_not_parse_file: 'Could not read that file — check it came from the provider you picked.',
};

function importErrorMessage(err: unknown): string {
  if (err instanceof ApiError && typeof err.body === 'object' && err.body !== null && 'error' in err.body) {
    const code = (err.body as { error: unknown }).error;
    if (typeof code === 'string' && code in IMPORT_ERROR_MESSAGES) return IMPORT_ERROR_MESSAGES[code]!;
  }
  return 'Could not import that file — try again.';
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
  budgetCurrencyCode,
  onImported,
  onUndone,
  onCancel,
}: {
  budgetId: string;
  accounts: Account[];
  budgetCurrencyCode: string;
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
  const [fxRate, setFxRate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [history, setHistory] = useState<ImportBatch[] | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  // Providers whose file has no fixed participant list of its own
  // (Splitwise) report who's in it via POST /imports/inspect, so the user
  // can pick which people's expenses belong to THIS budget before
  // committing to a real import — see src/import/splitwise.ts.
  // `participants === null` means "haven't inspected the current file yet"
  // (or the provider doesn't have this concept); `[]` means "inspected, no
  // per-person choice to make".
  const [participants, setParticipants] = useState<string[] | null>(null);
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [inspecting, setInspecting] = useState(false);

  function loadHistory() {
    apiFetch<{ batches: ImportBatch[] }>(`/budgets/${budgetId}/imports`).then((res) => setHistory(res.batches));
  }

  useEffect(loadHistory, [budgetId]);

  // Re-inspect whenever the file or provider changes — a wrong-provider
  // pick (or no file yet) just resets back to "nothing to choose".
  useEffect(() => {
    setParticipants(null);
    setSelectedMembers(new Set());
    if (!file) return;
    setInspecting(true);
    file
      .text()
      .then((csvText) => apiFetch<{ participants: string[] }>(`/budgets/${budgetId}/imports/inspect`, {
        method: 'POST',
        body: JSON.stringify({ provider, csv: csvText }),
      }))
      .then((res) => {
        setParticipants(res.participants);
        // Pre-fill from this account's last import, if any of those names
        // still appear in the file.
        const remembered = savedMembers(importable.find((a) => a.id === accountId));
        const stillPresent = remembered.filter((m) => res.participants.includes(m));
        setSelectedMembers(new Set(stillPresent));
      })
      .catch(() => setParticipants([])) // an unparseable file surfaces its real error on submit instead
      .finally(() => setInspecting(false));
    // accountId/importable deliberately excluded: switching the account
    // alone shouldn't re-run inspect, just re-read its saved options (the
    // account-change effect right below handles that).
  }, [file, provider, budgetId]);

  // Switching accounts (without changing the file) re-applies THAT
  // account's remembered selection, so picking through accounts to find
  // the right one doesn't require re-choosing people each time.
  useEffect(() => {
    if (participants === null) return;
    const remembered = savedMembers(importable.find((a) => a.id === accountId));
    setSelectedMembers(new Set(remembered.filter((m) => participants.includes(m))));
    // Only re-run on an explicit account switch — `participants` is read, not depended on, deliberately.
  }, [accountId]);

  // Pre-fill the exchange-rate field from whatever this account already
  // has on file (accounts.fxRateMicros — migrations/0007), so a repeat
  // import doesn't require retyping it. Runs on account switch — like the
  // members effect above, `importable` is deliberately not a dependency
  // (it's recreated every render; keying on accountId alone is enough).
  useEffect(() => {
    const account = importable.find((a) => a.id === accountId);
    setFxRate(account?.fxRateMicros != null ? formatFxRate(account.fxRateMicros) : '');
  }, [accountId]);

  function toggleMember(name: string) {
    setSelectedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const needsMembers = (participants?.length ?? 0) > 0;
  const selectedAccount = importable.find((a) => a.id === accountId);
  const isForeignAccount = !!selectedAccount && selectedAccount.currencyCode !== budgetCurrencyCode;
  // Only truly BLOCKS submit when the account is already on-budget and has
  // no rate anywhere (typed here or remembered) — the exact case the API
  // 400s on (missing_fx_rate). A foreign account that's still off-budget
  // can import without one; it just won't convert into categories.
  const fxRateRequired = isForeignAccount && selectedAccount!.onBudget && selectedAccount!.fxRateMicros === null;
  const canSubmit =
    !!file && !!accountId && !inspecting && (!needsMembers || selectedMembers.size > 0) && (!fxRateRequired || !!fxRate.trim());

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !accountId) return;
    setSubmitting(true);
    setError(null);
    try {
      const csv = await file.text();
      const result = await apiFetch<ImportSummary>(`/budgets/${budgetId}/imports`, {
        method: 'POST',
        body: JSON.stringify({
          accountId,
          provider,
          filename: file.name,
          csv,
          ...(needsMembers ? { options: { members: [...selectedMembers] } } : {}),
          ...(isForeignAccount && fxRate.trim() ? { fxRate: fxRate.trim() } : {}),
        }),
      });
      setSummary(result);
      onImported(result);
      loadHistory();
    } catch (err) {
      setError(importErrorMessage(err));
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
          {inspecting && <span style={{ color: '#666' }}> Checking file…</span>}
        </div>
        {isForeignAccount && (
          <div style={{ marginBlock: '0.5rem' }}>
            <label>
              Exchange rate (1 {selectedAccount!.currencyCode} = ? {budgetCurrencyCode}){' '}
              <input
                value={fxRate}
                onChange={(e) => setFxRate(e.target.value)}
                placeholder="e.g. 0.73"
                inputMode="decimal"
                style={{ width: '6rem' }}
              />
            </label>
            {fxRateRequired && !fxRate.trim() && (
              <p style={{ color: '#c0392b', fontSize: '0.9em', margin: '0.25rem 0 0' }}>
                This account is budgeted in {budgetCurrencyCode} — a rate is needed to convert these charges.
              </p>
            )}
          </div>
        )}
        {needsMembers && participants && (
          <div style={{ marginBlock: '0.5rem' }}>
            <p style={{ marginBottom: '0.25rem' }}>Whose expenses belong to this budget?</p>
            {participants.map((name) => (
              <label key={name} style={{ display: 'block' }}>
                <input type="checkbox" checked={selectedMembers.has(name)} onChange={() => toggleMember(name)} /> {name}
              </label>
            ))}
            {selectedMembers.size === 0 && <p style={{ color: '#c0392b', fontSize: '0.9em' }}>Pick at least one person.</p>}
          </div>
        )}
        {error && <p style={{ color: 'crimson' }}>{error}</p>}
        <button type="submit" disabled={!canSubmit || submitting}>
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
