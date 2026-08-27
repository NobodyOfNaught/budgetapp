import { useState } from 'react';
import { apiFetch, ApiError } from '../api';

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
 * The token is typed here, used for the one request, and dropped. It is
 * not stored — a Wise token identifies one person's account, and this app
 * is multi-user, so it cannot live in a Worker secret. Persisted
 * per-connection credentials are a separate piece of work.
 */

interface FetchedBalance {
  balanceId: number;
  currency: string;
  rowCount: number;
  balanceWarning: string | null;
  openingBalance: string | null;
}

interface FetchedStatement {
  statementJson: string;
  balances: FetchedBalance[];
  profileId: number;
}

export function WiseFetchPanel({
  budgetId,
  onFetched,
}: {
  budgetId: string;
  /** Hands back the statement as a file plus the provider that parses it. */
  onFetched: (file: File, provider: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FetchedStatement | null>(null);

  const canRun = token.trim() !== '' && start !== '' && end !== '' && start <= end;

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fetched = await apiFetch<FetchedStatement>(`/budgets/${budgetId}/imports/wise/fetch`, {
        method: 'POST',
        body: JSON.stringify({ token: token.trim(), start, end }),
      });
      setResult(fetched);
      setToken('');
      onFetched(
        new File([fetched.statementJson], `wise-${start}-to-${end}.json`, { type: 'application/json' }),
        'wise_json',
      );
    } catch (err) {
      setError(err instanceof ApiError ? JSON.stringify(err.body) : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <p style={{ margin: '0.5rem 0' }}>
        <button type="button" onClick={() => setOpen(true)}>
          Fetch from Wise API instead
        </button>
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
      <div>
        <div>
          <label>
            Wise API token{' '}
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
          <button type="button" onClick={() => void run()} disabled={busy || !canRun}>
            {busy ? 'Fetching…' : 'Fetch'}
          </button>{' '}
          <button type="button" onClick={() => setOpen(false)} disabled={busy}>
            Close
          </button>
          {!canRun && !busy && (
            <span style={{ marginLeft: '0.5rem', color: '#555' }}>Token and both dates are needed.</span>
          )}
        </div>
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
