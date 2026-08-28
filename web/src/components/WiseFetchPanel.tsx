import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../api';
import type { ImportSummary } from '../types';

/**
 * Downloads a Wise statement over the API and hands it to the import form
 * as if the user had picked a file.
 *
 * That "as if" is the whole design. The fetched JSON is wrapped in a real
 * `File` and passed to the existing file state, so the cutoff date, the FX
 * rate, per-currency account resolution, payee rules and the review queue
 * all apply exactly as they do to an upload, with no second code path to
 * keep in step. The server side stops at "here is the file" for the same
 * reason (see POST /imports/wise/fetch).
 *
 * A credential reaches the fetch one of two ways. Typed here, it is used
 * for the one request and dropped. Saved, it lives as an encrypted row
 * scoped to this budget (src/routes/import-connections.ts) — never in a
 * Worker secret, because those are one global value and a Wise token
 * identifies one person's bank account.
 *
 * A saved connection is what makes the one-click refresh possible: no
 * token to paste, and no dates either, since the server derives the range
 * from what has already been imported. The credential is write-only, so
 * this component can display that a connection exists but can never show
 * or recover the token behind it.
 */

interface FetchedBalance {
  balanceId: number;
  currency: string;
  rowCount: number;
  balanceWarning: string | null;
  openingBalance: string | null;
}

interface Connection {
  id: string;
  provider: string;
  label: string;
  lastUsedAt: number | null;
}

interface FetchedStatement {
  statementJson: string;
  balances: FetchedBalance[];
  profileId: number;
  /** The range the server actually used, which may have been derived rather than requested. */
  start: string;
  end: string;
}

export function WiseFetchPanel({
  budgetId,
  onFetched,
  onFetchedImport,
}: {
  budgetId: string;
  /** Hands back the statement as a file plus the provider that parses it, for the user to import. */
  onFetched: (file: File, provider: string) => void;
  /**
   * Fetch straight through to imported. Returns the summary, or null when
   * there is no account set up for this provider to import into — the
   * caller then falls back to loading the statement into the form.
   */
  onFetchedImport: (file: File, provider: string) => Promise<ImportSummary | null>;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FetchedStatement | null>(null);
  const [imported, setImported] = useState<ImportSummary | null>(null);
  const [needsAccount, setNeedsAccount] = useState(false);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [saveLabel, setSaveLabel] = useState('');

  const saved = connections?.find((connection) => connection.provider === 'wise_json') ?? null;

  async function loadConnections() {
    try {
      const listed = await apiFetch<{ connections: Connection[]; credentialsKeyConfigured: boolean }>(
        `/budgets/${budgetId}/import-connections`,
      );
      setConnections(listed.connections);
      setKeyConfigured(listed.credentialsKeyConfigured);
    } catch {
      // A viewer, or an environment without the table — either way the
      // panel still works with a typed token, so this is not an error to
      // put in front of the user.
      setConnections([]);
    }
  }

  useEffect(() => {
    void loadConnections();
    // Deliberately keyed on budgetId alone: the list is refreshed
    // explicitly after saving or forgetting a connection, so re-running on
    // every render of loadConnections would be churn, not correctness.
  }, [budgetId]);

  const canRun = token.trim() !== '' && start !== '' && end !== '' && start <= end;

  /**
   * `useSaved` runs against the stored connection and lets the server pick
   * the dates; otherwise the typed token and the typed range are used.
   * Dates are omitted rather than sent blank so the server can tell "no
   * preference" from "this exact day".
   */
  async function run(useSaved: boolean, thenImport = false) {
    setBusy(true);
    setError(null);
    setResult(null);
    setImported(null);
    setNeedsAccount(false);
    try {
      const body = useSaved
        ? { connectionId: saved?.id }
        : { token: token.trim(), start, end };
      const fetched = await apiFetch<FetchedStatement>(`/budgets/${budgetId}/imports/wise/fetch`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setResult(fetched);
      setToken('');
      if (useSaved) void loadConnections(); // refresh "last used"
      const statementFile = new File([fetched.statementJson], `wise-${fetched.start}-to-${fetched.end}.json`, {
        type: 'application/json',
      });

      if (thenImport) {
        const summary = await onFetchedImport(statementFile, 'wise_json');
        if (summary === null) {
          // No account set up for Wise, so there was nothing to import
          // into. Load the statement into the form anyway — the fetch
          // already happened and throwing it away would mean running it
          // again just to pick an account.
          onFetched(statementFile, 'wise_json');
          setNeedsAccount(true);
        } else {
          setImported(summary);
        }
        return;
      }

      onFetched(statementFile, 'wise_json');
    } catch (err) {
      setError(err instanceof ApiError ? JSON.stringify(err.body) : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveConnection() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/import-connections`, {
        method: 'POST',
        body: JSON.stringify({
          provider: 'wise_json',
          label: saveLabel.trim() || 'Wise',
          credential: token.trim(),
        }),
      });
      setToken('');
      setSaveLabel('');
      await loadConnections();
    } catch (err) {
      setError(err instanceof ApiError ? JSON.stringify(err.body) : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function forgetConnection(id: string) {
    if (!confirm('Forget this saved Wise token? Fetching will need it pasted again.')) return;
    setBusy(true);
    try {
      await apiFetch(`/budgets/${budgetId}/import-connections/${id}`, { method: 'DELETE' });
      await loadConnections();
    } catch (err) {
      setError(err instanceof ApiError ? JSON.stringify(err.body) : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <p style={{ margin: '0.5rem 0' }}>
        {saved && (
          <>
            <button type="button" onClick={() => void run(true, true)} disabled={busy}>
              {busy ? 'Fetching…' : 'Fetch new Wise transactions'}
            </button>{' '}
          </>
        )}
        <button type="button" onClick={() => setOpen(true)} disabled={busy}>
          {saved ? 'Wise options' : 'Fetch from Wise API instead'}
        </button>
        {error && (
          <span style={{ color: '#b00', marginLeft: '0.5rem', wordBreak: 'break-all' }}>{error}</span>
        )}
        {imported && result && (
          <span style={{ color: '#161', marginLeft: '0.5rem' }}>
            Imported {imported.imported} of {result.balances.reduce((sum, b) => sum + b.rowCount, 0)} fetched (
            {result.start} to {result.end})
            {imported.skipped.length > 0 && `, ${imported.skipped.length} skipped`}
            {imported.accountsCreated.length > 0 && `, created ${imported.accountsCreated.join(', ')}`} — review them
            below.
          </span>
        )}
        {needsAccount && (
          <span style={{ color: '#b00', marginLeft: '0.5rem' }}>
            Fetched, but no account is set up for Wise — pick one below and import.
          </span>
        )}
      </p>
    );
  }

  return (
    <div style={{ border: '1px solid #ccc', padding: '0.75rem', margin: '0.5rem 0' }}>
      <h4 style={{ marginTop: 0 }}>Fetch from Wise</h4>
      <p style={{ fontSize: '0.85rem', color: '#555', marginTop: 0 }}>
        Downloads every balance for the dates below and fills in the statement, ready to import. Nothing is written
        until you import it. The token is used for this one request and not saved.
      </p>

      {/* NOT a <form>. This panel renders inside ImportForm's own <form>,
          and HTML does not nest forms: a nested one made this button submit
          the OUTER form natively, reloading the page and never running the
          fetch. Hence a plain div, an explicit type="button", and the
          validation that `required` would otherwise have done. */}
      {saved && (
        <div style={{ marginBottom: '0.75rem' }}>
          <p style={{ margin: '0 0 0.25rem' }}>
            Saved token: <strong>{saved.label}</strong>{' '}
            <span style={{ color: '#555' }}>
              {saved.lastUsedAt
                ? `· last used ${new Date(saved.lastUsedAt).toLocaleString(undefined, { dateStyle: 'medium' })}`
                : '· never used'}
            </span>
          </p>
          <button type="button" onClick={() => void run(true, true)} disabled={busy}>
            {busy ? 'Working…' : 'Fetch and import new transactions'}
          </button>{' '}
          <button type="button" onClick={() => void forgetConnection(saved.id)} disabled={busy}>
            Forget it
          </button>
          <p style={{ margin: '0.25rem 0 0', color: '#555' }}>
            This fetches AND imports in one go, straight to the review queue — nothing is approved until you approve
            it. It picks its own dates: from the newest Wise transaction already imported, up to today. It overlaps
            that last day on purpose — re-importing a day already held changes nothing, while starting a day later
            would silently miss anything that posted after the last fetch ran.
          </p>
        </div>
      )}

      <div>
        <div>
          <label>
            {saved ? 'Replace token, or fetch a specific range' : 'Wise API token'}{' '}
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              size={40}
            />
          </label>
        </div>
        <div style={{ marginTop: '0.5rem' }}>
          <label>
            From <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>{' '}
          <label>
            To <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        <div style={{ marginTop: '0.5rem' }}>
          <button type="button" onClick={() => void run(false)} disabled={busy || !canRun}>
            {busy ? 'Fetching…' : 'Fetch this range'}
          </button>{' '}
          <button type="button" onClick={() => setOpen(false)} disabled={busy}>
            Close
          </button>
          {!canRun && !busy && (
            <span style={{ marginLeft: '0.5rem', color: '#555' }}>Token and both dates are needed.</span>
          )}
        </div>

        {!saved && keyConfigured && (
          <div style={{ marginTop: '0.75rem', borderTop: '1px solid #eee', paddingTop: '0.5rem' }}>
            <label>
              Save this token as{' '}
              <input
                value={saveLabel}
                onChange={(e) => setSaveLabel(e.target.value)}
                placeholder="Wise"
                size={16}
              />
            </label>{' '}
            <button type="button" onClick={() => void saveConnection()} disabled={busy || token.trim() === ''}>
              Save
            </button>
            <p style={{ margin: '0.25rem 0 0', color: '#555' }}>
              Stored encrypted against this budget, and write-only — it can be replaced or forgotten, but never shown
              again, including to you. Saving it turns Fetch into a single button with no dates to pick.
            </p>
          </div>
        )}
        {!keyConfigured && (
          <p style={{ marginTop: '0.5rem', color: '#555' }}>
            Saving tokens is unavailable here: this environment has no CREDENTIALS_KEY set, so there is nothing to
            encrypt them with.
          </p>
        )}
      </div>

      {error && (
        <p style={{ color: '#b00', fontSize: '0.85rem', wordBreak: 'break-all' }}>
          <strong>Fetch failed:</strong> {error}
        </p>
      )}

      {result && (
        <div style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
          <p style={{ margin: '0 0 0.25rem' }}>
            Fetched {result.balances.reduce((sum, b) => sum + b.rowCount, 0)} transactions from{' '}
            {result.balances.filter((b) => b.rowCount > 0).length} balance
            {result.balances.filter((b) => b.rowCount > 0).length === 1 ? '' : 's'} — pick the account below and
            import.
          </p>
          <ul style={{ margin: '0 0 0.25rem 1rem', padding: 0 }}>
            {result.balances.map((balance) => (
              <li key={balance.balanceId}>
                {balance.currency}: {balance.rowCount} row{balance.rowCount === 1 ? '' : 's'}
                {balance.rowCount > 0 && balance.openingBalance !== null && (
                  // The balance Wise held immediately before this range —
                  // i.e. what an opening-balance row for this account
                  // should say, if the import does not start at the
                  // account's own beginning.
                  <>
                    {' '}
                    · balance before {balance.openingBalance} {balance.currency}
                  </>
                )}
                {balance.balanceWarning && (
                  // Wise reports its own opening and closing balance per
                  // statement, so a mismatch means the rows do not add up
                  // to what Wise itself says happened. Worth stopping for.
                  <span style={{ color: '#b00' }}> — {balance.balanceWarning}</span>
                )}
              </li>
            ))}
          </ul>
          {result.balances.every((b) => b.balanceWarning === null) && (
            <p style={{ margin: 0, color: '#161' }}>Every balance reconciles against Wise&apos;s own figures.</p>
          )}
          <p style={{ margin: '0.25rem 0 0', color: '#555' }}>
            &ldquo;Balance before&rdquo; is what Wise held the moment before this range starts. If the account has no
            transactions older than that, its opening-balance row should equal it.
          </p>
        </div>
      )}
    </div>
  );
}
