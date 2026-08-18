import { useState } from 'react';
import { apiFetch } from '../api';

export function SignInForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // The endpoint always responds 200 for a well-formed address whether
      // or not an account exists — see docs/plan.md — so "sent" here just
      // means "the request was accepted", not "an email definitely went out".
      await apiFetch('/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }) });
      setSent(true);
    } catch {
      setError('That doesn’t look like a valid email address.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <p>
        If <strong>{email}</strong> has an account (or doesn’t yet — we’ll create one), a sign-in link is on its way.
        Check your email.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="email">Email</label>
      <br />
      <input
        id="email"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
      />
      <button type="submit" disabled={submitting} style={{ marginLeft: '0.5rem' }}>
        {submitting ? 'Sending…' : 'Send sign-in link'}
      </button>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </form>
  );
}
