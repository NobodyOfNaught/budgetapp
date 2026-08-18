import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { UpcomingOccurrence } from '../types';

function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * "Coming up" — every target's occurrences over the next N days, sorted on
 * a real calendar, entirely independent of which month is currently being
 * viewed on the budget screen. This is the direct answer to "why is month
 * end relevant when bills are due on their own schedule" — it isn't; this
 * panel is obligations on their OWN clock, deliberately not sliced by
 * month at all. See GET /budgets/:id/upcoming and src/domain/targets.ts's
 * doc comment on the two separate clocks.
 */
export function UpcomingPanel({ budgetId, refreshToken }: { budgetId: string; refreshToken?: number }) {
  const [occurrences, setOccurrences] = useState<UpcomingOccurrence[] | null>(null);

  useEffect(() => {
    apiFetch<{ occurrences: UpcomingOccurrence[] }>(`/budgets/${budgetId}/upcoming?days=60`).then((res) =>
      setOccurrences(res.occurrences),
    );
  }, [budgetId, refreshToken]);

  if (occurrences !== null && occurrences.length === 0) return null; // nothing due, nothing to show

  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h3 style={{ marginBottom: '0.5rem' }}>Coming up</h3>
      {occurrences === null ? (
        <p style={{ color: '#666' }}>Loading…</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          {occurrences.map((o, i) => (
            <li
              key={`${o.categoryId}-${o.dueDate}-${i}`}
              style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', fontSize: '0.95em' }}
            >
              <span style={{ width: '4rem', color: '#666', fontVariantNumeric: 'tabular-nums' }}>{formatDate(o.dueDate)}</span>
              <span style={{ flex: 1 }}>{o.categoryName}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatMinor(o.amountMinor)}</span>
              <span style={{ color: '#666', minWidth: '10rem' }}>
                {o.lastPaidDate ? `last paid ${formatDate(o.lastPaidDate)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
