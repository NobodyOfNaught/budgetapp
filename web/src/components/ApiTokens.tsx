import { useEffect, useState } from 'react';
import { apiFetch } from '../api';

interface ApiToken {
  id: string;
  label: string;
  lastUsedAt: number | null;
  createdAt: number;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Tokens for the import API — how statement files reach this site through
 * Claude instead of the upload form (migrations/0012).
 *
 * A new token is shown ONCE, here, right after it is created: only its hash
 * is stored, so there is no way to display it again. The note under it says
 * so and says where it goes — into Claude's secure credential prompt, never
 * pasted into a chat.
 */
export function ApiTokens() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [label, setLabel] = useState('Claude');
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await apiFetch<{ tokens: ApiToken[] }>('/api-tokens');
      setTokens(res.tokens);
    } catch {
      setError('Could not load API tokens.');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await apiFetch<{ secret: string }>('/api-tokens', {
        method: 'POST',
        body: JSON.stringify({ label: label.trim() }),
      });
      setJustCreated(res.secret);
      await load();
    } catch {
      setError('Could not create a token.');
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await apiFetch(`/api-tokens/${id}`, { method: 'DELETE' });
      await load();
    } catch {
      setError('Could not revoke that token.');
    }
  }

  return (
    <details style={{ marginBlock: '1rem' }}>
      <summary>API tokens ({tokens.length})</summary>
      <p style={{ color: '#666', fontSize: '0.9em' }}>
        A token lets Claude work on your budget on your behalf: import statements, and edit or delete accounts,
        transactions and categories. It cannot create or list tokens. Revoke it here at any time.
      </p>
      {tokens.length > 0 && (
        <ul>
          {tokens.map((t) => (
            <li key={t.id}>
              <strong>{t.label}</strong> — created {isoDate(t.createdAt)},{' '}
              {t.lastUsedAt ? `last used ${isoDate(t.lastUsedAt)}` : 'never used'}{' '}
              <button type="button" onClick={() => void revoke(t.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {justCreated && (
        <div style={{ border: '1px solid #c90', padding: '0.5rem', marginBlock: '0.5rem' }}>
          <p style={{ margin: 0 }}>
            <strong>Copy this now — it will not be shown again:</strong>
          </p>
          <input readOnly value={justCreated} onFocus={(e) => e.currentTarget.select()} style={{ width: '100%', fontFamily: 'monospace' }} />
          <p style={{ color: '#666', fontSize: '0.9em', marginBottom: 0 }}>
            Enter it in Claude&apos;s secure credential form when asked. Don&apos;t paste it into a chat message.{' '}
            <button type="button" onClick={() => setJustCreated(null)}>
              Done
            </button>
          </p>
        </div>
      )}
      <form onSubmit={create}>
        <label>
          New token label <input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={100} />
        </label>{' '}
        <button type="submit">Create token</button>
      </form>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </details>
  );
}
