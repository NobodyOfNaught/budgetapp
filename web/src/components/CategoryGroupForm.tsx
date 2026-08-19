import { useState } from 'react';
import { apiFetch } from '../api';

/**
 * Create a category group — mirrors AccountForm.tsx's toggle-a-form pattern
 * exactly (one field, POST, onCreated/onCancel). See BudgetMonth.tsx, which
 * toggles this from a "+ Add group" button below the category grid.
 */
export function CategoryGroupForm({
  budgetId,
  onCreated,
  onCancel,
}: {
  budgetId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/categories/groups`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      onCreated();
    } catch {
      setError('Could not create that group — check the name.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.5rem' }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name" required autoFocus />
      <button type="submit" disabled={submitting}>
        {submitting ? 'Creating…' : 'Create'}
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && <span style={{ color: '#c0392b' }}>{error}</span>}
    </form>
  );
}
