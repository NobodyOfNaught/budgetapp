import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api';
import type { ConsumeResponse } from '../types';

type State =
  | { kind: 'missing_token' }
  | { kind: 'checking' }
  | { kind: 'needs_confirmation' }
  | { kind: 'confirming' }
  | { kind: 'signed_in' }
  | { kind: 'invalid' }
  | { kind: 'expired' };

/**
 * Reached via the emailed magic link (GET /auth/confirm?token=...). Falls
 * through Workers Static Assets' SPA fallback like any other non-/api path
 * — see wrangler.jsonc's not_found_handling — so no server-side route for
 * this URL is needed.
 *
 * POSTs to consume rather than acting on the GET itself, so a link scanner
 * or prefetcher following the emailed URL can't burn the token before the
 * user gets to it — see docs/plan.md's auth flow section.
 */
export function ConfirmSignIn() {
  const [state, setState] = useState<State>({ kind: 'checking' });
  const token = new URLSearchParams(window.location.search).get('token');
  // Guards against StrictMode's dev-only double-invoke: the token is
  // single-use, so a second automatic attempt would see 'invalid' even
  // though the first one actually succeeded.
  const attempted = useRef(false);

  async function attempt(confirm: boolean) {
    if (!token) return;
    setState({ kind: confirm ? 'confirming' : 'checking' });
    const res = await apiFetch<ConsumeResponse>('/auth/consume', {
      method: 'POST',
      body: JSON.stringify({ token, confirm }),
    });
    setState({ kind: res.status });
    if (res.status === 'signed_in') {
      window.location.href = '/';
    }
  }

  useEffect(() => {
    if (!token) {
      setState({ kind: 'missing_token' });
      return;
    }
    if (attempted.current) return;
    attempted.current = true;
    void attempt(false);
  }, [token]);

  switch (state.kind) {
    case 'missing_token':
      return <p>This sign-in link is missing its token. Go back and request a new one.</p>;
    case 'checking':
    case 'confirming':
      return <p>Signing you in…</p>;
    case 'signed_in':
      return <p>Signed in — redirecting…</p>;
    case 'needs_confirmation':
      return (
        <>
          <p>This link was opened on a different device or browser than the one that requested it.</p>
          <button onClick={() => void attempt(true)}>Confirm sign-in on this device</button>
        </>
      );
    case 'expired':
      return <p>This sign-in link has expired. Request a new one from the home page.</p>;
    case 'invalid':
      return <p>This sign-in link isn’t valid — it may already have been used. Request a new one.</p>;
  }
}
