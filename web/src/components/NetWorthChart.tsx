import { useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { NetWorthReport } from '../types';

// Same formatMinor duplication as every other screen (Reports.tsx,
// Register.tsx, BudgetMonth.tsx) — house style, not shared.
function formatMinor(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
}

function monthLabel(month: string): string {
  return new Date(`${month.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/**
 * A "nice" round step for an axis spanning `range`, per the standard
 * nice-number tick algorithm — 1/2/5 x a power of ten. `round` picks
 * whether the result rounds to the nearest nice value (for the final step)
 * or up to the next one (for the raw range itself).
 */
function niceNumber(range: number, round: boolean): number {
  if (range <= 0) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exponent;
  let niceFraction: number;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * 10 ** exponent;
}

/** Clean, evenly-spaced y-axis ticks covering [min, max] (always including 0). */
function niceTicks(min: number, max: number, targetCount: number): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (lo === hi) return [lo - 100, lo, hi + 100];
  const step = niceNumber(niceNumber(hi - lo, false) / (targetCount - 1), true);
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

const WIDTH = 760;
const HEIGHT = 320;
const MARGIN = { top: 20, right: 112, bottom: 36, left: 76 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

/**
 * Net worth over time as a single-series line chart — inline SVG, no
 * charting library (see this repo's existing "no charting dependency"
 * decision in docs/plan.md; a hand-rolled chart keeps that true while still
 * answering "show me a graph"). One series needs no legend box — the "Net
 * worth" tab label already names what's plotted — so this carries a
 * crosshair + tooltip (with the assets/liabilities breakdown that doesn't
 * fit as a second line) and a direct end-label instead.
 */
export function NetWorthChart({ points }: { points: NetWorthReport['months'] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  if (points.length === 0) return <p>No data in this range.</p>;

  const values = points.map((p) => p.netWorthMinor);
  const ticks = niceTicks(Math.min(...values), Math.max(...values), 5);
  const yMin = ticks[0]!;
  const yMax = ticks[ticks.length - 1]!;

  const xFor = (i: number) => (points.length === 1 ? MARGIN.left + PLOT_WIDTH / 2 : MARGIN.left + (i / (points.length - 1)) * PLOT_WIDTH);
  const yFor = (v: number) => MARGIN.top + PLOT_HEIGHT - ((v - yMin) / (yMax - yMin)) * PLOT_HEIGHT;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(p.netWorthMinor)}`).join(' ');
  const areaPath = `${linePath} L ${xFor(points.length - 1)} ${yFor(yMin)} L ${xFor(0)} ${yFor(yMin)} Z`;

  // Sparse x labels — evenly spaced across the plot (not "every Nth point"),
  // so the last two never land close enough to collide the way a plain
  // modulo selection can when the count doesn't divide evenly.
  const targetLabelCount = Math.min(6, points.length);
  const labelIndices = new Set(
    Array.from({ length: targetLabelCount }, (_, k) =>
      Math.round((k * (points.length - 1)) / Math.max(1, targetLabelCount - 1)),
    ),
  );

  function nearestIndex(clientX: number, svg: SVGSVGElement): number {
    const rect = svg.getBoundingClientRect();
    const localX = ((clientX - rect.left) / rect.width) * WIDTH;
    const ratio = (localX - MARGIN.left) / PLOT_WIDTH;
    return Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
  }

  function handlePointerMove(e: PointerEvent<SVGRectElement>) {
    const svg = e.currentTarget.ownerSVGElement;
    if (svg) setActiveIndex(nearestIndex(e.clientX, svg));
  }

  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') {
      setActiveIndex((i) => Math.min(points.length - 1, (i ?? -1) + 1));
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      setActiveIndex((i) => Math.max(0, (i ?? points.length) - 1));
      e.preventDefault();
    } else if (e.key === 'Escape') {
      setActiveIndex(null);
    }
  }

  const active = activeIndex !== null ? points[activeIndex]! : null;
  const endPoint = points[points.length - 1]!;
  const endLabelUp = endPoint.netWorthMinor >= (values.reduce((a, b) => a + b, 0) / values.length || 0);

  return (
    <div className="net-worth-chart" style={{ position: 'relative', maxWidth: WIDTH }}>
      {/* Scoped custom properties, not a fixed hex, so the line and grid
          follow the browser's dark-mode rendering the same way the rest of
          this page's UA-default colors already do (:root sets
          `color-scheme: light dark` in styles.css) — this is the first
          chart in the app, so it's also the first place that matters. */}
      <style>{`
        .net-worth-chart { --nwc-series: #2a78d6; --nwc-grid: #e1e0d9; --nwc-axis: #c3c2b7; --nwc-muted: #767570; }
        @media (prefers-color-scheme: dark) {
          .net-worth-chart { --nwc-series: #3987e5; --nwc-grid: #2c2c2a; --nwc-axis: #383835; --nwc-muted: #9a988f; }
        }
      `}</style>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        // `height: auto` is only valid as a CSS value, not a raw SVG
        // attribute (which requires a length) — width 100% + this is what
        // makes the chart scale proportionally with its container.
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label={`Net worth from ${monthLabel(points[0]!.month)} to ${monthLabel(endPoint.month)}, ending at ${formatMinor(endPoint.netWorthMinor)}`}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerLeave={() => setActiveIndex(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={yFor(t)}
              y2={yFor(t)}
              stroke={t === 0 && yMin < 0 ? 'var(--nwc-axis)' : 'var(--nwc-grid)'}
              strokeWidth={1}
            />
            <text x={MARGIN.left - 10} y={yFor(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--nwc-muted)">
              {formatMinor(t)}
            </text>
          </g>
        ))}

        {points.map(
          (p, i) =>
            labelIndices.has(i) && (
              <text key={p.month} x={xFor(i)} y={HEIGHT - MARGIN.bottom + 18} textAnchor="middle" fontSize={11} fill="var(--nwc-muted)">
                {monthLabel(p.month)}
              </text>
            ),
        )}

        <path d={areaPath} fill="var(--nwc-series)" opacity={0.1} stroke="none" />
        <path d={linePath} fill="none" stroke="var(--nwc-series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        <circle cx={xFor(points.length - 1)} cy={yFor(endPoint.netWorthMinor)} r={4} fill="var(--nwc-series)" stroke="Canvas" strokeWidth={2} />
        <text
          x={xFor(points.length - 1) + 10}
          y={yFor(endPoint.netWorthMinor) + (endLabelUp ? -4 : 14)}
          fontSize={12}
          fontWeight={600}
          fill="currentColor"
        >
          {formatMinor(endPoint.netWorthMinor)}
        </text>

        {active && (
          <>
            <line x1={xFor(activeIndex!)} x2={xFor(activeIndex!)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke="var(--nwc-axis)" strokeWidth={1} />
            <circle cx={xFor(activeIndex!)} cy={yFor(active.netWorthMinor)} r={4} fill="var(--nwc-series)" stroke="Canvas" strokeWidth={2} />
          </>
        )}

        {/* Hit area on top, covering the whole plot: the crosshair "finds
            the X" for the reader rather than requiring a precise hover on
            the 2px line — see the dataviz skill's interaction guidance. */}
        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={PLOT_WIDTH}
          height={PLOT_HEIGHT}
          fill="transparent"
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerMove}
        />
      </svg>

      {active && (
        <div
          style={{
            position: 'absolute',
            top: 4,
            left: 4,
            background: 'Canvas',
            color: 'CanvasText',
            border: '1px solid var(--nwc-grid)',
            borderRadius: 4,
            padding: '0.4rem 0.6rem',
            fontSize: '0.85em',
            pointerEvents: 'none',
            boxShadow: '0 1px 4px rgba(0,0,0,0.15)',
          }}
        >
          <div>{monthLabel(active.month)}</div>
          <div style={{ fontWeight: 600 }}>{formatMinor(active.netWorthMinor)}</div>
          <div style={{ color: 'var(--nwc-muted)' }}>
            Assets {formatMinor(active.assetsMinor)} · Liabilities {formatMinor(active.liabilitiesMinor)}
          </div>
        </div>
      )}
    </div>
  );
}
