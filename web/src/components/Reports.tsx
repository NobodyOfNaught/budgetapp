import { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { NetWorthChart, type NetWorthChartPoint } from './NetWorthChart';
import type { CategoryGroup, IncomeExpenseReport, NetWorthDailyReport, NetWorthReport, SpendingReport } from '../types';

// Same formatMinor/amountColor duplication as every other screen
// (Register.tsx, BudgetMonth.tsx) — house style, not shared.
function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function amountColor(minor: number): string {
  if (minor > 0) return '#0a7a2f';
  if (minor < 0) return '#c0392b';
  return '#666';
}

function monthLabel(month: string): string {
  return new Date(`${month.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // 'YYYY-MM'
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y! * 12 + (m! - 1) + delta;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  return `${String(newYear).padStart(4, '0')}-${String(newMonth).padStart(2, '0')}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

/** `date` plus `days` (may be negative), 'YYYY-MM-DD' in and out — the
 * frontend's own tiny copy of src/lib/dates.ts's addDays. Same house
 * convention as formatMinor above: web/ duplicates rather than importing
 * across the Worker/SPA boundary, so this stays a few lines rather than a
 * shared package. Date.UTC is a calendar-arithmetic scratchpad only, same
 * as the backend original — never wall-clock/local time. */
function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

interface FlatCategory {
  id: string;
  name: string;
  groupName: string;
}

/**
 * Drops the leading run of all-zero points (no account existed yet, or
 * every one was empty) from a net-worth series — works on either the
 * monthly or the daily shape, both of which carry assetsMinor/
 * liabilitiesMinor. Without this, "All" — a generous fixed lookback
 * rather than a real earliest-data query, see ALL_TIME_MONTHS_BACK /
 * ALL_TIME_DAYS_BACK — buries a real few months of history under years of
 * flat $0 rows in both the chart and the table below it. Applied
 * unconditionally (not just for the "All" preset) since a hand-picked
 * custom start earlier than any data hits the same problem. A series
 * that's all zero (no accounts yet) is left alone — trimming it to
 * nothing would be worse than a flat line at $0.
 */
function trimLeadingZeros<T extends { assetsMinor: number; liabilitiesMinor: number }>(points: T[]): T[] {
  const firstActive = points.findIndex((p) => p.assetsMinor !== 0 || p.liabilitiesMinor !== 0);
  return firstActive <= 0 ? points : points.slice(firstActive);
}

/**
 * Trailing simple moving average — `out[i]` is the mean of
 * `values[i - windowDays + 1 .. i]`, or null before there's a full
 * window. No partial-window average is ever produced: a 3-day mean
 * standing in for a requested 7-day one would look identical to a real
 * one on the chart, which is worse than an honest gap.
 *
 * Rounded to the nearest whole minor unit (cent) — `values` are already
 * minor-unit integers, but a sum of them divided by an arbitrary window
 * size usually isn't. Every value this feeds (formatMinor, the y-scale)
 * assumes a plain integer; left unrounded, formatMinor's `% 100` split
 * garbles into something like "$14,345.72.857142857" instead of a
 * rounding error nobody would even notice at cent precision.
 */
function trailingMovingAverage(values: number[], windowDays: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= windowDays) sum -= values[i - windowDays]!;
    out.push(i >= windowDays - 1 ? Math.round(sum / windowDays) : null);
  }
  return out;
}

/**
 * Turns a daily report's raw days into what NetWorthChart actually draws:
 * the visible points plus, when a moving average is on, its values
 * aligned 1:1 with those points by index.
 *
 * `rawDays` may carry an invisible LEAD-IN before `displayStart` — see the
 * daily fetch effect below, which asks for `maWindowDays - 1` extra days
 * before the visible range specifically so the average has real history
 * to draw on from the very first displayed day, instead of a blank gap
 * the width of the window. That lead-in is dropped here, after it's
 * already done its job seeding the rolling sum. The leading-all-zero trim
 * runs on the VISIBLE portion only (a lead-in of zeros before the account
 * existed shouldn't stop the trim from doing its job on what's shown).
 */
function buildDailyChartData(
  rawDays: NetWorthDailyReport['days'],
  displayStart: string,
  maEnabled: boolean,
  maWindowDays: number,
): { points: NetWorthChartPoint[]; movingAverage?: { windowDays: number; values: (number | null)[] } } {
  const maFull = maEnabled ? trailingMovingAverage(rawDays.map((d) => d.netWorthMinor), maWindowDays) : null;

  let leadInEnd = rawDays.findIndex((d) => d.date >= displayStart);
  if (leadInEnd < 0) leadInEnd = 0;

  const visible = rawDays.slice(leadInEnd);
  const firstActive = visible.findIndex((d) => d.assetsMinor !== 0 || d.liabilitiesMinor !== 0);
  const startIndex = leadInEnd + (firstActive <= 0 ? 0 : firstActive);

  const points = rawDays.slice(startIndex).map((d) => ({
    key: d.date,
    assetsMinor: d.assetsMinor,
    liabilitiesMinor: d.liabilitiesMinor,
    netWorthMinor: d.netWorthMinor,
  }));
  const movingAverage = maFull ? { windowDays: maWindowDays, values: maFull.slice(startIndex) } : undefined;
  return { points, movingAverage };
}

type ReportTab = 'spending' | 'income-expense' | 'net-worth';

const TAB_LABELS: Record<ReportTab, string> = {
  spending: 'Spending by category',
  'income-expense': 'Income vs. expense',
  'net-worth': 'Net worth',
};

// Net worth is looked at over a very different horizon than the other two
// reports (often "all time" rather than "the last few months"), so it gets
// its own period control instead of sharing start/end with them. `months:
// null` is "All" — ALL_TIME_MONTHS_BACK years back is a generous ceiling,
// not a real earliest-data lookup (there's no endpoint for that); months
// before any transactions exist just render as a flat $0, which is the
// honest answer rather than a wrong one.
const ALL_TIME_MONTHS_BACK = 120; // 10 years
const NET_WORTH_PRESETS: { label: string; months: number | null }[] = [
  { label: '6M', months: 6 },
  { label: '1Y', months: 12 },
  { label: '2Y', months: 24 },
  { label: '5Y', months: 60 },
  { label: 'All', months: null },
];

// Same idea as the monthly presets, day granularity — and the same
// generous-ceiling "All" (src/routes/reports.ts's MAX_DAILY_RANGE_DAYS is
// far larger still, so this stays well clear of the server-side cap).
const ALL_TIME_DAYS_BACK = 3650; // 10 years, matching ALL_TIME_MONTHS_BACK
const NET_WORTH_DAILY_PRESETS: { label: string; days: number | null }[] = [
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '6M', days: 182 },
  { label: '1Y', days: 365 },
  { label: 'All', days: null },
];

// A day-by-day table over a multi-year range is hundreds of rows nobody
// reads — the chart is the point at that scale. Below this many visible
// rows the table renders as normal; above it, a note replaces it (the
// chart, and its hover tooltip, still carry every value).
const DAILY_TABLE_ROW_CAP = 200;

/**
 * Three reports named in docs/plan.md's Phase 2 roadmap — spending by
 * category, income vs. expense, and net worth — now tabbed rather than
 * stacked on one page. Spending and income-vs-expense keep the original
 * shared start/end range; net worth gets its own period control (presets +
 * custom) and a line-chart view (NetWorthChart) alongside its table. Still
 * no charting *library* — see docs/plan.md's original "no charting
 * dependency" note — NetWorthChart is hand-rolled inline SVG, so that
 * decision holds even though a graph now exists.
 */
export function Reports({
  budgetId,
  categoryGroups,
  onOpenAccount,
}: {
  budgetId: string;
  categoryGroups: CategoryGroup[];
  /** Jumps to an account's register, where its exchange rate can be set — see AccountSettings. */
  onOpenAccount: (accountId: string) => void;
}) {
  const [tab, setTab] = useState<ReportTab>('spending');

  const [start, setStart] = useState(() => shiftMonth(currentMonth(), -5));
  const [end, setEnd] = useState(() => currentMonth());
  const [spending, setSpending] = useState<SpendingReport | null>(null);
  const [incomeExpense, setIncomeExpense] = useState<IncomeExpenseReport | null>(null);

  const [nwStart, setNwStart] = useState(() => shiftMonth(currentMonth(), -11));
  const [nwEnd, setNwEnd] = useState(() => currentMonth());
  const [nwPreset, setNwPreset] = useState<string | null>('1Y');
  const [netWorth, setNetWorth] = useState<NetWorthReport | null>(null);

  // "Daily net worth" is a separate mode from the monthly view above, with
  // its own period (exact days rather than months) and an optional
  // trailing moving average — independent state so switching granularity
  // doesn't lose either side's range.
  const [nwGranularity, setNwGranularity] = useState<'monthly' | 'daily'>('monthly');
  const [nwDailyStart, setNwDailyStart] = useState(() => addDaysIso(todayIso(), -89));
  const [nwDailyEnd, setNwDailyEnd] = useState(() => todayIso());
  const [nwDailyPreset, setNwDailyPreset] = useState<string | null>('90D');
  const [netWorthDaily, setNetWorthDaily] = useState<NetWorthDailyReport | null>(null);
  const [maEnabled, setMaEnabled] = useState(false);
  const [maWindowDays, setMaWindowDays] = useState(7);

  useEffect(() => {
    setSpending(null);
    setIncomeExpense(null);
    const params = `start=${start}&end=${end}`;
    apiFetch<SpendingReport>(`/budgets/${budgetId}/reports/spending?${params}`).then(setSpending);
    apiFetch<IncomeExpenseReport>(`/budgets/${budgetId}/reports/income-expense?${params}`).then(setIncomeExpense);
  }, [budgetId, start, end]);

  useEffect(() => {
    setNetWorth(null);
    apiFetch<NetWorthReport>(`/budgets/${budgetId}/reports/net-worth?start=${nwStart}&end=${nwEnd}`).then(setNetWorth);
  }, [budgetId, nwStart, nwEnd]);

  // Only fetched once the Daily sub-view is actually opened — a year-plus
  // daily range is a real query, no reason to run it for a user who never
  // leaves Monthly. When the moving average is on, this asks for
  // `maWindowDays - 1` extra days BEFORE nwDailyStart too, so the average
  // has real history to draw on from the first visibly displayed day
  // instead of a blank gap the width of the window — see
  // buildDailyChartData, which drops that lead-in again before rendering.
  useEffect(() => {
    if (nwGranularity !== 'daily') return;
    setNetWorthDaily(null);
    const fetchStart = maEnabled ? addDaysIso(nwDailyStart, -(maWindowDays - 1)) : nwDailyStart;
    apiFetch<NetWorthDailyReport>(`/budgets/${budgetId}/reports/net-worth/daily?start=${fetchStart}&end=${nwDailyEnd}`).then(
      setNetWorthDaily,
    );
  }, [budgetId, nwGranularity, nwDailyStart, nwDailyEnd, maEnabled, maWindowDays]);

  function applyNetWorthPreset(label: string, months: number | null) {
    const end = currentMonth();
    const start = shiftMonth(end, -((months ?? ALL_TIME_MONTHS_BACK) - 1));
    setNwStart(start);
    setNwEnd(end);
    setNwPreset(label);
  }

  function applyNetWorthDailyPreset(label: string, days: number | null) {
    const end = todayIso();
    const start = addDaysIso(end, -((days ?? ALL_TIME_DAYS_BACK) - 1));
    setNwDailyStart(start);
    setNwDailyEnd(end);
    setNwDailyPreset(label);
  }

  const flatCategories: FlatCategory[] = categoryGroups.flatMap((g) =>
    g.categories.filter((c) => c.kind === 'spending').map((c) => ({ id: c.id, name: c.name, groupName: g.name })),
  );
  const categoryById = new Map(flatCategories.map((c) => [c.id, c]));

  const spendingRows = (spending?.categories ?? [])
    .map((row) => ({ ...row, category: categoryById.get(row.categoryId) }))
    .filter((row): row is typeof row & { category: FlatCategory } => row.category !== undefined)
    .sort((a, b) => a.spentMinor - b.spentMinor); // most spent (most negative) first

  return (
    <section>
      <h2>Reports</h2>

      <div role="tablist" style={{ display: 'flex', gap: '1.5rem', borderBottom: '1px solid #ddd', marginBottom: '1rem' }}>
        {(Object.keys(TAB_LABELS) as ReportTab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            style={{
              padding: '0.5rem 0',
              border: 'none',
              borderBottom: tab === t ? '2px solid #2a78d6' : '2px solid transparent',
              background: 'none',
              cursor: 'pointer',
              fontWeight: tab === t ? 'bold' : 'normal',
              fontSize: '1em',
            }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {(tab === 'spending' || tab === 'income-expense') && (
        <p>
          <label>
            From{' '}
            <input type="month" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>{' '}
          <label>
            Through{' '}
            <input type="month" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </p>
      )}

      {tab === 'spending' &&
        (spending === null ? (
          <p>Loading…</p>
        ) : spendingRows.length === 0 ? (
          <p>No spending in this range.</p>
        ) : (
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th align="left">Category</th>
                  <th align="left">Group</th>
                  <th align="right">Spent</th>
                </tr>
              </thead>
              <tbody>
                {spendingRows.map((row) => (
                  <tr key={row.categoryId} style={{ borderTop: '1px solid #ddd' }}>
                    <td>{row.category.name}</td>
                    <td>{row.category.groupName}</td>
                    <td align="right" style={{ color: amountColor(row.spentMinor) }}>
                      {formatMinor(row.spentMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'income-expense' &&
        (incomeExpense === null ? (
          <p>Loading…</p>
        ) : (
          <div className="table-scroll">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th align="left">Month</th>
                  <th align="right">Income</th>
                  <th align="right">Expense</th>
                  <th align="right">Net</th>
                </tr>
              </thead>
              <tbody>
                {incomeExpense.months.map((m) => (
                  <tr key={m.month} style={{ borderTop: '1px solid #ddd' }}>
                    <td>{monthLabel(m.month)}</td>
                    <td align="right" style={{ color: amountColor(m.incomeMinor) }}>
                      {formatMinor(m.incomeMinor)}
                    </td>
                    <td align="right" style={{ color: amountColor(-m.expenseMinor) }}>
                      {formatMinor(m.expenseMinor)}
                    </td>
                    <td align="right" style={{ color: amountColor(m.incomeMinor - m.expenseMinor) }}>
                      {formatMinor(m.incomeMinor - m.expenseMinor)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === 'net-worth' && (
        <>
          <p style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.75rem' }}>
            {(['monthly', 'daily'] as const).map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={nwGranularity === g}
                onClick={() => setNwGranularity(g)}
                style={{
                  padding: '0.25rem 0.75rem',
                  border: '1px solid #ccc',
                  borderRadius: 4,
                  background: nwGranularity === g ? '#333' : 'none',
                  color: nwGranularity === g ? '#fff' : 'inherit',
                  fontWeight: nwGranularity === g ? 'bold' : 'normal',
                  cursor: 'pointer',
                }}
              >
                {g === 'monthly' ? 'Monthly' : 'Daily'}
              </button>
            ))}
          </p>

          {nwGranularity === 'monthly' && (
            <>
              <p style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', gap: '0.25rem' }}>
                  {NET_WORTH_PRESETS.map(({ label, months }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => applyNetWorthPreset(label, months)}
                      aria-pressed={nwPreset === label}
                      style={{
                        padding: '0.25rem 0.6rem',
                        border: '1px solid #ccc',
                        borderRadius: 4,
                        background: nwPreset === label ? '#2a78d6' : 'none',
                        color: nwPreset === label ? '#fff' : 'inherit',
                        fontWeight: nwPreset === label ? 'bold' : 'normal',
                        cursor: 'pointer',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </span>
                <label>
                  From{' '}
                  <input
                    type="month"
                    value={nwStart}
                    onChange={(e) => {
                      setNwStart(e.target.value);
                      setNwPreset(null);
                    }}
                  />
                </label>
                <label>
                  Through{' '}
                  <input
                    type="month"
                    value={nwEnd}
                    onChange={(e) => {
                      setNwEnd(e.target.value);
                      setNwPreset(null);
                    }}
                  />
                </label>
              </p>

              {netWorth === null ? (
                <p>Loading…</p>
              ) : (
                <>
                  <UnvaluedNotice unvalued={netWorth.unvalued} onOpenAccount={onOpenAccount} />

                  <NetWorthChart
                    points={trimLeadingZeros(netWorth.months).map((m) => ({
                      key: m.month,
                      assetsMinor: m.assetsMinor,
                      liabilitiesMinor: m.liabilitiesMinor,
                      netWorthMinor: m.netWorthMinor,
                    }))}
                    formatLabel={monthLabel}
                  />

                  <div className="table-scroll" style={{ marginTop: '1rem' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th align="left">Month</th>
                          <th align="right">Assets</th>
                          <th align="right">Liabilities</th>
                          <th align="right">Net worth</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trimLeadingZeros(netWorth.months).map((m) => (
                          <tr key={m.month} style={{ borderTop: '1px solid #ddd' }}>
                            <td>{monthLabel(m.month)}</td>
                            <td align="right">{formatMinor(m.assetsMinor)}</td>
                            <td align="right" style={{ color: amountColor(m.liabilitiesMinor) }}>
                              {formatMinor(m.liabilitiesMinor)}
                            </td>
                            <td align="right" style={{ color: amountColor(m.netWorthMinor) }}>
                              {formatMinor(m.netWorthMinor)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}

          {nwGranularity === 'daily' && (
            <>
              <p style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', gap: '0.25rem' }}>
                  {NET_WORTH_DAILY_PRESETS.map(({ label, days }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => applyNetWorthDailyPreset(label, days)}
                      aria-pressed={nwDailyPreset === label}
                      style={{
                        padding: '0.25rem 0.6rem',
                        border: '1px solid #ccc',
                        borderRadius: 4,
                        background: nwDailyPreset === label ? '#2a78d6' : 'none',
                        color: nwDailyPreset === label ? '#fff' : 'inherit',
                        fontWeight: nwDailyPreset === label ? 'bold' : 'normal',
                        cursor: 'pointer',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </span>
                <label>
                  From{' '}
                  <input
                    type="date"
                    value={nwDailyStart}
                    max={nwDailyEnd}
                    onChange={(e) => {
                      setNwDailyStart(e.target.value);
                      setNwDailyPreset(null);
                    }}
                  />
                </label>
                <label>
                  Through{' '}
                  <input
                    type="date"
                    value={nwDailyEnd}
                    min={nwDailyStart}
                    max={todayIso()}
                    onChange={(e) => {
                      setNwDailyEnd(e.target.value);
                      setNwDailyPreset(null);
                    }}
                  />
                </label>
              </p>

              <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <input type="checkbox" checked={maEnabled} onChange={(e) => setMaEnabled(e.target.checked)} />
                  Show a
                </label>
                <input
                  type="number"
                  min={2}
                  max={365}
                  value={maWindowDays}
                  disabled={!maEnabled}
                  onChange={(e) => setMaWindowDays(Math.min(365, Math.max(2, Number(e.target.value) || 2)))}
                  style={{ width: '4rem' }}
                />
                -day running average
              </p>

              {netWorthDaily === null ? (
                <p>Loading…</p>
              ) : (
                (() => {
                  const { points, movingAverage } = buildDailyChartData(netWorthDaily.days, nwDailyStart, maEnabled, maWindowDays);
                  return (
                    <>
                      <UnvaluedNotice unvalued={netWorthDaily.unvalued} onOpenAccount={onOpenAccount} />

                      <NetWorthChart points={points} formatLabel={dayLabel} movingAverage={movingAverage} />

                      {points.length <= DAILY_TABLE_ROW_CAP ? (
                        <div className="table-scroll" style={{ marginTop: '1rem' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th align="left">Date</th>
                                <th align="right">Assets</th>
                                <th align="right">Liabilities</th>
                                <th align="right">Net worth</th>
                              </tr>
                            </thead>
                            <tbody>
                              {points.map((p) => (
                                <tr key={p.key} style={{ borderTop: '1px solid #ddd' }}>
                                  <td>{dayLabel(p.key)}</td>
                                  <td align="right">{formatMinor(p.assetsMinor)}</td>
                                  <td align="right" style={{ color: amountColor(p.liabilitiesMinor) }}>
                                    {formatMinor(p.liabilitiesMinor)}
                                  </td>
                                  <td align="right" style={{ color: amountColor(p.netWorthMinor) }}>
                                    {formatMinor(p.netWorthMinor)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p style={{ color: '#666', fontSize: '0.9em', marginTop: '1rem' }}>
                          This range spans {points.length} days — showing the graph only. Narrow the range (or hover the
                          chart) to see day-by-day figures.
                        </p>
                      )}
                    </>
                  );
                })()
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

/** The "no exchange rate on file" caveat — identical shape on both the
 * monthly and daily net-worth reports (see UnvaluedAccount in types.ts),
 * so it's one small component instead of two copies of the same JSX. */
function UnvaluedNotice({
  unvalued,
  onOpenAccount,
}: {
  unvalued: { accountId: string; name: string; currencyCode: string }[];
  onOpenAccount: (accountId: string) => void;
}) {
  if (unvalued.length === 0) return null;
  return (
    <div style={{ color: '#c0392b', fontSize: '0.9em', marginBlock: '0.5rem' }}>
      <p style={{ margin: 0 }}>
        {unvalued.length === 1 ? 'This account has' : 'These accounts have'} no exchange rate, so{' '}
        {unvalued.length === 1 ? 'its balance is an estimate' : 'their balances are estimates'} rather than a real
        conversion:
      </p>
      <ul style={{ margin: '0.25rem 0 0' }}>
        {unvalued.map((a) => (
          <li key={a.accountId}>
            {a.name} ({a.currencyCode}) —{' '}
            <button type="button" onClick={() => onOpenAccount(a.accountId)}>
              Set a rate
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
