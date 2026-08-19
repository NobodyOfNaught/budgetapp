import { useState } from 'react';
import { apiFetch } from '../api';

/**
 * Create an ordinary (spending) category inside one group — same pattern as
 * CategoryGroupForm.tsx, one field different (groupId, not settable by the
 * user — it's fixed to whichever group's "+ Add category" was clicked).
 * `kind` is never sent: the API always creates 'spending' categories through
 * this endpoint (see src/routes/categories.ts).
 */
export function CategoryForm({
  budgetId,
  groupId,
  onCreated,
  onCancel,
}: {
  budgetId: string;
  groupId: string;
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
      await apiFetch(`/budgets/${budgetId}/categories`, {
        method: 'POST',
        body: JSON.stringify({ name, groupId }),
      });
      onCreated();
    } catch {
      setError('Could not create that category — check the name.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Category name" required autoFocus />
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
