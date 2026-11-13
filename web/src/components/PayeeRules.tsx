import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { CategoryGroup, PayeeRule } from '../types';

/**
 * The override half of statement import's heuristic-plus-override design
 * (see src/import/payee-name.ts and src/routes/imports.ts) — CRUD for
 * payee_rules, plus "Apply to review queue" to re-run them over whatever's
 * still sitting unapproved without deleting the batch and re-importing.
 * Applies to every import provider, not just the one that motivated it.
 */
/** 5000 -> "50", 5050 -> "50.50": a plain decimal for a form field, no currency symbol (the heading names the currency). */
function minorToField(minor: number | null): string {
  if (minor === null) return '';
  const whole = Math.floor(minor / 100);
  const cents = minor % 100;
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, '0')}`;
}

/** The band as a short phrase for the table: "up to 50", "over 50 ", "20 – 40", or "" when there is none. */
function describeBand(min: number | null, max: number | null): string {
  if (min === null && max === null) return 'any amount';
  if (min === null) return `up to ${minorToField(max)}`;
  if (max === null) return `${minorToField(min)} and over`;
  return `${minorToField(min)} – ${minorToField(max)}`;
}

export function PayeeRules({ budgetId, categoryGroups }: { budgetId: string; categoryGroups: CategoryGroup[] }) {
  const [rules, setRules] = useState<PayeeRule[] | null>(null);
  const [matchText, setMatchText] = useState('');
  const [payeeName, setPayeeName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    apiFetch<{ rules: PayeeRule[] }>(`/budgets/${budgetId}/payee-rules`).then((res) => setRules(res.rules));
  }

  useEffect(reload, [budgetId]);

  const assignable = categoryGroups.flatMap((g) =>
    g.categories.filter((c) => c.kind === 'spending').map((c) => ({ id: c.id, name: c.name, groupName: g.name })),
  );
  const categoryLabel = (id: string | null) => (id ? (assignable.find((c) => c.id === id)?.name ?? '(deleted category)') : '');

  function startEdit(rule: PayeeRule) {
    setEditingId(rule.id);
    setMatchText(rule.matchText);
    setPayeeName(rule.payeeName);
    setCategoryId(rule.categoryId ?? '');
    setAmountMin(minorToField(rule.amountMinMinor));
    setAmountMax(minorToField(rule.amountMaxMinor));
  }

  function resetForm() {
    setEditingId(null);
    setMatchText('');
    setPayeeName('');
    setCategoryId('');
    setAmountMin('');
    setAmountMax('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Empty means "no limit on that side" — null, not omitted, so that
      // clearing a field while editing actually clears the stored one.
      const body = JSON.stringify({
        matchText,
        payeeName,
        categoryId: categoryId || null,
        amountMin: amountMin.trim() || null,
        amountMax: amountMax.trim() || null,
      });
      if (editingId) {
        await apiFetch(`/budgets/${budgetId}/payee-rules/${editingId}`, { method: 'PATCH', body });
      } else {
        await apiFetch(`/budgets/${budgetId}/payee-rules`, { method: 'POST', body });
      }
      resetForm();
      reload();
    } catch {
      setError('Could not save that rule — check the fields, and that the low end of the amount range is not above the high end.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this rule?')) return;
    await apiFetch(`/budgets/${budgetId}/payee-rules/${id}`, { method: 'DELETE' });
    if (editingId === id) resetForm();
    reload();
  }

  async function handleApply() {
    setApplyResult(null);
    const res = await apiFetch<{ updated: number }>(`/budgets/${budgetId}/payee-rules/apply`, { method: 'POST' });
    setApplyResult(res.updated === 0 ? 'No unapproved rows matched.' : `Updated ${res.updated} unapproved row${res.updated === 1 ? '' : 's'}.`);
  }

  return (
    <section>
      <h2>Payee rules</h2>
      <p style={{ color: '#666' }}>
        When an import's automatic naming gets a merchant wrong, add a rule here: any statement row whose description contains the
        match text gets renamed (and optionally categorized) instead. Rules apply to every import, from any provider.
      </p>
      <p style={{ color: '#666' }}>
        A rule can also be limited to a price range, so one merchant can mean different things at different prices — for example a
        studio&apos;s $20–$40 weekly class versus its larger event charges. Give the small charges their own rule with a range, and
        add a plain rule with no range behind it for everything else: the rule with a range wins whenever the amount fits. Amounts
        are compared in your budget&apos;s currency, ignoring whether it is a charge or a refund.
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <label>
          If the description contains{' '}
          <input value={matchText} onChange={(e) => setMatchText(e.target.value)} placeholder="GIANT FOOD INC" required />
        </label>
        <label>
          call it{' '}
          <input value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="Giant Food" required />
        </label>
        <label>
          category{' '}
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">(leave as-is)</option>
            {assignable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.groupName}: {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          amount from{' '}
          <input value={amountMin} onChange={(e) => setAmountMin(e.target.value)} placeholder="any" inputMode="decimal" style={{ width: '5rem' }} />
        </label>
        <label>
          to{' '}
          <input value={amountMax} onChange={(e) => setAmountMax(e.target.value)} placeholder="any" inputMode="decimal" style={{ width: '5rem' }} />
        </label>
        <button type="submit" disabled={submitting}>
          {editingId ? 'Save rule' : 'Add rule'}
        </button>
        {editingId && (
          <button type="button" onClick={resetForm}>
            Cancel
          </button>
        )}
        {error && <span style={{ color: '#c0392b' }}>{error}</span>}
      </form>

      <p>
        <button onClick={handleApply}>Apply rules to review queue</button>{' '}
        {applyResult && <span style={{ color: '#666' }}>{applyResult}</span>}
      </p>

      {rules === null ? (
        <p>Loading…</p>
      ) : rules.length === 0 ? (
        <p>No rules yet.</p>
      ) : (
        <div className="table-scroll">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th align="left">Contains</th>
                <th align="left">Payee</th>
                <th align="left">Category</th>
                <th align="left">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} style={{ borderTop: '1px solid #ddd' }}>
                  <td>{rule.matchText}</td>
                  <td>{rule.payeeName}</td>
                  <td>{categoryLabel(rule.categoryId)}</td>
                  <td>{describeBand(rule.amountMinMinor, rule.amountMaxMinor)}</td>
                  <td>
                    <button onClick={() => startEdit(rule)}>Edit</button> <button onClick={() => handleDelete(rule.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
