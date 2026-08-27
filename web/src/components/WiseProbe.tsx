import { useState } from 'react';
import { apiFetch, ApiError } from '../api';

/**
 * A throwaway diagnostic panel, not a product feature.
 *
 * The first run against a real account already settled the two questions
 * it was built for, and neither answer was the expected one:
 *
 * - No SCA. Statement reads succeeded on a bearer token alone, so the RSA
 *   signing path does not need building for this profile.
 * - The API's `statement.csv` is NOT the file src/import/wise.ts parses.
 *   The web-UI export uses `ID`, `Direction`, `Source amount (after fees)`;
 *   the API uses `TransferWise ID`, `Amount`, `Running Balance`,
 *   `Transaction Type`. Same filename, different format — so reusing the
 *   existing CSV parser was never actually an option, and the JSON payload
 *   (explicit type field, per-row running balance) is the better target.
 *
 * What is left is the id question, and it is now a MIGRATION question
 * rather than a format one: the API reports `CARD-4145111585` where
 * already-imported history holds `CARD_TRANSACTION-4145111585`. Same
 * transaction, same number, different prefix — and since rows dedupe on the
 * (account_id, import_id) unique index, an overlapping fetch would double
 * every row until that is normalised. Hence the id table below, and the
 * type/field reporting: the normalisation has to cover every transaction
 * type, not just the card rows that happen to dominate a sample.
 *
 * The token is typed here, POSTed to our own Worker, used for the read,
 * and discarded — it is never stored, never logged, and never comes back
 * in the response. It is deliberately NOT kept in component state beyond
 * the request: real credential storage is a separate, encrypted-at-rest
 * design, and a diagnostic should not quietly become the thing that sets
 * that precedent.
 *
 * Reports schema only — field NAMES, type labels, ids and counts. No
 * amounts, no payees, no merchant names.
 */

interface DuplicateIdGroup {
  id: string;
  count: number;
  detailTypes: string[];
  signs: string[];
  separated: boolean;
}

interface StatementProbe {
  status: number;
  scaRequired: boolean;
  ids: string[];
  headerLine: string | null;
  fieldNames: string[];
  types: string[];
  detailTypes: string[];
  duplicates: DuplicateIdGroup[];
  error: string | null;
}

interface BalanceProbe {
  balanceId: number;
  currency: string;
  json: StatementProbe;
  csv: StatementProbe;
  idsMatch: boolean;
  rawJson?: string;
}

interface WiseProbeResult {
  profiles: { id: number; type: string }[];
  balances: BalanceProbe[];
}

function formatProbe(probe: StatementProbe): string {
  if (probe.error) return `HTTP ${probe.status}${probe.scaRequired ? ' (SCA challenge)' : ''} — ${probe.error}`;
  return `${probe.ids.length} rows`;
}

export function WiseProbe({ budgetId, onCancel }: { budgetId: string; onCancel: () => void }) {
  const [token, setToken] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [includeRaw, setIncludeRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<WiseProbeResult | null>(null);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await apiFetch<WiseProbeResult>(`/budgets/${budgetId}/imports/wise/probe`, {
          method: 'POST',
          body: JSON.stringify({ token: token.trim(), start, end, includeRaw }),
        }),
      );
      // Drop the token the moment it has been used. Re-running means
      // re-pasting, which is the correct trade for a diagnostic.
      setToken('');
    } catch (err) {
      const body = err instanceof ApiError ? JSON.stringify(err.body) : String(err);
      setError(body);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: '1px solid #ccc', padding: '0.75rem', marginTop: '0.5rem' }}>
      <h3 style={{ marginTop: 0 }}>Wise API probe</h3>
      <p style={{ fontSize: '0.85rem', color: '#555', marginTop: 0 }}>
        Reads a date range from Wise in both JSON and CSV and reports their transaction ids, field names and type
        labels — no amounts or payees. Nothing is imported and nothing is saved; the token is used for the read and
        discarded.
      </p>

      <form onSubmit={run}>
        <div>
          <label>
            Wise API token{' '}
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              size={40}
              required
            />
          </label>
        </div>
        <div style={{ marginTop: '0.5rem' }}>
          <label>
            From <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
          </label>{' '}
          <label>
            To <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </label>
        </div>
        <div style={{ marginTop: '0.5rem' }}>
          <label>
            <input type="checkbox" checked={includeRaw} onChange={(e) => setIncludeRaw(e.target.checked)} /> Include
            raw JSON for download (this one DOES contain amounts and merchants)
          </label>
        </div>
        <div style={{ marginTop: '0.5rem' }}>
          <button type="submit" disabled={busy || token.trim() === ''}>
            {busy ? 'Reading…' : 'Run probe'}
          </button>{' '}
          <button type="button" onClick={onCancel} disabled={busy}>
            Close
          </button>
        </div>
      </form>

      {error && (
        <p style={{ color: '#b00', fontSize: '0.85rem', wordBreak: 'break-all' }}>
          <strong>Failed:</strong> {error}
        </p>
      )}

      {result && (
        <div style={{ marginTop: '0.75rem', fontSize: '0.85rem' }}>
          <p>
            <strong>Profiles:</strong> {result.profiles.map((p) => `${p.id} (${p.type})`).join(', ') || 'none'}
          </p>
          {result.balances.length === 0 && <p>No balances returned.</p>}
          {result.balances.map((balance) => (
            <div key={balance.balanceId} style={{ marginBottom: '0.75rem' }}>
              <p style={{ margin: '0 0 0.15rem' }}>
                <strong>
                  {balance.currency} (balance {balance.balanceId})
                </strong>{' '}
                — ids match:{' '}
                <span style={{ color: balance.idsMatch ? '#161' : '#b00' }}>{balance.idsMatch ? 'YES' : 'NO'}</span>
              </p>
              <p style={{ margin: '0 0 0.15rem' }}>JSON: {formatProbe(balance.json)}</p>
              <p style={{ margin: '0 0 0.15rem' }}>CSV: {formatProbe(balance.csv)}</p>
              {balance.csv.headerLine && (
                <p style={{ margin: '0 0 0.15rem', wordBreak: 'break-all', color: '#555' }}>
                  CSV header: <code>{balance.csv.headerLine}</code>
                </p>
              )}
              {balance.json.fieldNames.length > 0 && (
                <p style={{ margin: '0 0 0.15rem', wordBreak: 'break-all', color: '#555' }}>
                  JSON fields: <code>{balance.json.fieldNames.join(', ')}</code>
                </p>
              )}
              {balance.json.types.length > 0 && (
                <p style={{ margin: '0 0 0.15rem', color: '#555' }}>
                  JSON types: <code>{balance.json.types.join(', ')}</code>
                </p>
              )}
              {balance.json.detailTypes.length > 0 && (
                <p style={{ margin: '0 0 0.15rem', color: '#555' }}>
                  JSON details.type: <code>{balance.json.detailTypes.join(', ')}</code>
                </p>
              )}
              {balance.json.duplicates.length > 0 && (
                <div style={{ margin: '0.25rem 0' }}>
                  <p style={{ margin: '0 0 0.15rem' }}>
                    <strong>Repeated ids in this balance: {balance.json.duplicates.length}</strong>
                  </p>
                  {balance.json.duplicates.slice(0, 10).map((group) => (
                    <p key={group.id} style={{ margin: 0, color: '#555' }}>
                      <code>{group.id}</code> ×{group.count} — details.type:{' '}
                      <code>{group.detailTypes.join(' | ') || '(none)'}</code>, signs:{' '}
                      <code>{group.signs.join(' ')}</code>
                      {group.separated ? ' (non-adjacent)' : ''}
                    </p>
                  ))}
                </div>
              )}
              {balance.rawJson && (
                <p style={{ margin: '0.25rem 0' }}>
                  <button
                    type="button"
                    onClick={() => {
                      const url = URL.createObjectURL(new Blob([balance.rawJson ?? ''], { type: 'application/json' }));
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = `wise-${balance.currency}-${balance.balanceId}.json`;
                      link.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    Download raw {balance.currency} JSON
                  </button>
                </p>
              )}
              {balance.csv.types.length > 0 && (
                <p style={{ margin: '0 0 0.15rem', color: '#555' }}>
                  CSV transaction types: <code>{balance.csv.types.join(', ')}</code>
                </p>
              )}
              {(balance.json.ids.length > 0 || balance.csv.ids.length > 0) && (
                <table style={{ borderCollapse: 'collapse', marginTop: '0.25rem' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', paddingRight: '1rem' }}>JSON referenceNumber</th>
                      <th style={{ textAlign: 'left' }}>CSV ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: Math.max(balance.json.ids.length, balance.csv.ids.length) })
                      .slice(0, 25)
                      .map((_, i) => {
                        const jsonId = balance.json.ids[i] ?? '—';
                        const csvId = balance.csv.ids[i] ?? '—';
                        return (
                          <tr key={i}>
                            <td style={{ paddingRight: '1rem' }}>
                              <code>{jsonId}</code>
                            </td>
                            <td style={{ color: jsonId === csvId ? undefined : '#b00' }}>
                              <code>{csvId}</code>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
