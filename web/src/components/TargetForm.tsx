import { useState } from 'react';
import { apiFetch } from '../api';
import type { TargetIntervalUnit, TargetView } from '../types';

const UNIT_LABELS: Record<TargetIntervalUnit, string> = {
  week: 'week(s)',
  month: 'month(s)',
  year: 'year(s)',
  once: 'once',
};

/**
 * Inline editor for one category's target — rendered by BudgetMonth as an
 * extra table row, the same pattern as its per-row "Move" form. Handles
 * both creating a new target and editing/clearing an existing one (`PUT`
 * is an upsert either way — see src/routes/targets.ts).
 */
export function TargetForm({
  budgetId,
  categoryId,
  existing,
  onSaved,
  onCleared,
  onCancel,
}: {
  budgetId: string;
  categoryId: string;
  existing: TargetView | undefined;
  onSaved: () => void;
  onCleared: () => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState(existing?.amount ?? '');
  const [intervalUnit, setIntervalUnit] = useState<TargetIntervalUnit>(existing?.intervalUnit ?? 'month');
  const [intervalCount, setIntervalCount] = useState(String(existing?.intervalCount ?? 1));
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/targets/${categoryId}`, {
        method: 'PUT',
        body: JSON.stringify({
          amount,
          intervalUnit,
          intervalCount: intervalUnit === 'once' ? undefined : Number(intervalCount) || 1,
          dueDate: dueDate.trim() || null,
        }),
      });
      onSaved();
    } catch {
      setError('Could not save that target — check the amount and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleClear() {
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/budgets/${budgetId}/targets/${categoryId}`, { method: 'DELETE' });
      onCleared();
    } catch {
      setError('Could not remove that target.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
      <label>
        Target{' '}
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" style={{ width: '5rem' }} required />
      </label>
      <label>
        every{' '}
        <select value={intervalUnit} onChange={(e) => setIntervalUnit(e.target.value as TargetIntervalUnit)}>
          {(Object.keys(UNIT_LABELS) as TargetIntervalUnit[]).map((u) => (
            <option key={u} value={u}>
              {u === 'once' ? 'one time' : UNIT_LABELS[u]}
            </option>
          ))}
        </select>
      </label>
      {intervalUnit !== 'once' && (
        <input
          value={intervalCount}
          onChange={(e) => setIntervalCount(e.target.value)}
          type="number"
          min={1}
          style={{ width: '3.5rem' }}
          aria-label="every N"
        />
      )}
      <label>
        {intervalUnit === 'once' ? 'by' : 'due'}{' '}
        <input value={dueDate} onChange={(e) => setDueDate(e.target.value)} type="date" />
      </label>
      {intervalUnit === 'once' && !dueDate && <span style={{ fontSize: '0.85em', color: '#666' }}>(no date = open-ended savings goal)</span>}
      <button type="submit" disabled={submitting}>
        {submitting ? 'Saving…' : 'Save target'}
      </button>
      {existing && (
        <button type="button" onClick={handleClear} disabled={submitting}>
          Remove target
        </button>
      )}
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && <span style={{ color: '#c0392b' }}>{error}</span>}
    </form>
  );
}
