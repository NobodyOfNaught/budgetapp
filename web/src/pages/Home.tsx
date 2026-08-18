import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../api';
import type { MeResponse } from '../types';
import { SignInForm } from './SignInForm';

type State = { kind: 'loading' } | { kind: 'signed_out' } | { kind: 'signed_in'; me: MeResponse };

export function Home() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    apiFetch<MeResponse>('/auth/me')
      .then((me) => setState({ kind: 'signed_in', me }))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          setState({ kind: 'signed_out' });
        } else {
          throw err;
        }
      });
  }, []);

  async function signOut() {
    await apiFetch('/auth/logout', { method: 'POST' });
    setState({ kind: 'signed_out' });
  }

  if (state.kind === 'loading') return <p>Loading…</p>;

  if (state.kind === 'signed_out') {
    return (
      <>
        <h1>budgetapp</h1>
        <SignInForm />
      </>
    );
  }

  const { user, budgets } = state.me;
  const primaryBudget = budgets[0];

  return (
    <>
      <h1>budgetapp</h1>
      <p>
        Signed in as <strong>{user.displayName ?? user.email}</strong>.{' '}
        <button onClick={signOut}>Sign out</button>
      </p>
      {primaryBudget ? (
        <p>
          Budget: <strong>{primaryBudget.name}</strong> ({primaryBudget.currencyCode}) — role:{' '}
          {primaryBudget.role}
        </p>
      ) : (
        <p>No budget yet.</p>
      )}
      <p style={{ color: '#666' }}>Accounts, categories, and transactions land in a later PR.</p>
    </>
  );
}
