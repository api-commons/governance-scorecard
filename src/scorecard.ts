// The scorecard model: ingest a series of governance snapshots over time,
// compute a 0–100 health score per spec per snapshot, build per-spec time
// series, and detect trends — improving, flat, or a "growing problem list"
// that is degrading. Point-in-time scorecards already exist; the missing
// piece is HISTORY, so you can act before a spec goes the wrong direction.
// Pure data — no DOM in this module.
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ---- model ------------------------------------------------------------------
export interface SnapshotSpec {
  name: string;
  errors: number;
  warnings: number;
  infos: number;
  ruleCount?: number;   // rules evaluated (optional)
  coverage?: number;    // 0..1 share of the API the ruleset actually checks (optional)
}
export interface Snapshot { date: string; specs: SnapshotSpec[]; }
export interface History { version: string; snapshots: Snapshot[]; }

// A Spectral `lint -f json` result item (used when appending a raw run).
export interface Violation { code: string; message?: string; path?: (string | number)[]; severity?: number; source?: string; range?: any; }

export interface SeriesPoint {
  date: string;
  health: number;       // 0..100
  errors: number; warnings: number; infos: number;
  violations: number;   // errors + warnings + infos
  coverage?: number;
}
export interface SpecSeries { name: string; points: SeriesPoint[]; }

export type Direction = 'improving' | 'degrading' | 'flat';
export interface Trend {
  slope: number;        // health points per snapshot (least-squares, over the window)
  direction: Direction;
  degrading: boolean;
  delta: number;        // last − first, over the window
  first: number; last: number;
  windowLength: number;
}

export interface DegradingSpec {
  name: string;
  series: SpecSeries;
  healthTrend: Trend;       // trend of the 0..100 health score
  violationTrend: Trend;    // trend of the raw violation count
  latestHealth: number;
  latestViolations: number;
  violationDelta: number;   // change in violation count over the window
  score: number;            // ranking score — higher = worse-degrading
}

export interface EstateRollup {
  series: SpecSeries;       // estate-level series (name "Estate")
  trend: Trend;
  latestHealth: number;
  specCount: number;
}

// ---- health formula ---------------------------------------------------------
// Health is 0–100, driven by a weighted violation penalty where errors count
// far more than warnings, and warnings more than infos. Coverage, when known,
// scales the score down — a clean spec whose ruleset checks little of the API
// is not as healthy as it looks.
//
//   penalty  = errors·ERROR_WEIGHT + warnings·WARNING_WEIGHT + infos·INFO_WEIGHT
//   base     = clamp(100 − penalty, 0, 100)
//   coverage = present ? base · (COVERAGE_FLOOR + (1 − COVERAGE_FLOOR)·coverage)
//                      : base
//   health   = round(coverage)
export const ERROR_WEIGHT = 6;
export const WARNING_WEIGHT = 2;
export const INFO_WEIGHT = 0.5;
export const COVERAGE_FLOOR = 0.6;   // even 0% coverage keeps 60% of the base score
export const DEFAULT_WINDOW = 4;     // trend looks at the last N snapshots
export const FLAT_SLOPE = 0.75;      // |slope| below this (health pts / snapshot) reads as flat

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function healthScore(spec: Pick<SnapshotSpec, 'errors' | 'warnings' | 'infos' | 'coverage'>): number {
  const penalty = (spec.errors || 0) * ERROR_WEIGHT + (spec.warnings || 0) * WARNING_WEIGHT + (spec.infos || 0) * INFO_WEIGHT;
  let base = clamp(100 - penalty, 0, 100);
  if (spec.coverage != null && !isNaN(spec.coverage)) {
    const c = clamp(spec.coverage, 0, 1);
    base = base * (COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * c);
  }
  return Math.round(base);
}

// ---- parse / serialize ------------------------------------------------------
export function parseHistory(text: string): History {
  const t = text.trim();
  if (!t) return { version: '0.1', snapshots: [] };
  let doc: any;
  try { doc = JSON.parse(t); } catch { doc = parseYaml(t); }
  if (Array.isArray(doc)) doc = { version: '0.1', snapshots: doc };
  if (!doc || !Array.isArray(doc.snapshots)) throw new Error('Expected a `snapshots:` list.');
  return { version: String(doc.version ?? '0.1'), snapshots: doc.snapshots.map(normalizeSnapshot) };
}
function normalizeSnapshot(s: any, i: number): Snapshot {
  if (!s || !s.date) throw new Error(`Snapshot ${i + 1} is missing a "date".`);
  if (!Array.isArray(s.specs)) throw new Error(`Snapshot ${i + 1} (${s.date}) is missing a "specs" list.`);
  return { date: String(s.date), specs: s.specs.map(normalizeSpec) };
}
function normalizeSpec(sp: any, i: number): SnapshotSpec {
  if (!sp || !sp.name) throw new Error(`Spec ${i + 1} is missing a "name".`);
  const num = (v: any) => (v == null || isNaN(Number(v)) ? 0 : Number(v));
  const out: SnapshotSpec = { name: String(sp.name), errors: num(sp.errors), warnings: num(sp.warnings), infos: num(sp.infos) };
  if (sp.ruleCount != null && !isNaN(Number(sp.ruleCount))) out.ruleCount = Number(sp.ruleCount);
  if (sp.coverage != null && !isNaN(Number(sp.coverage))) out.coverage = Number(sp.coverage);
  return out;
}
export function serializeHistory(h: History): string {
  const snapshots = [...h.snapshots]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => ({
      date: s.date,
      specs: s.specs.map((sp) => ({
        name: sp.name, errors: sp.errors, warnings: sp.warnings, infos: sp.infos,
        ...(sp.ruleCount != null ? { ruleCount: sp.ruleCount } : {}),
        ...(sp.coverage != null ? { coverage: sp.coverage } : {}),
      })),
    }));
  return stringifyYaml({ version: h.version || '0.1', snapshots });
}

// ---- append a raw Spectral run ----------------------------------------------
// Turn `spectral lint -f json` output into a dated snapshot (grouping by
// `source`) and append it to the history. If a snapshot already exists for the
// date, it is replaced. Spectral severity: 0=error, 1=warn, 2=info, 3=hint.
export function lintToSnapshot(date: string, violations: Violation[]): Snapshot {
  const byName = new Map<string, SnapshotSpec>();
  for (const v of violations) {
    const name = v.source || '(no source)';
    let sp = byName.get(name);
    if (!sp) { sp = { name, errors: 0, warnings: 0, infos: 0 }; byName.set(name, sp); }
    const sev = v.severity ?? 0;
    if (sev === 0) sp.errors++;
    else if (sev === 1) sp.warnings++;
    else sp.infos++;   // info + hint
  }
  return { date, specs: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
export function appendRun(h: History, date: string, violations: Violation[]): History {
  const snap = lintToSnapshot(date, violations);
  const snapshots = h.snapshots.filter((s) => s.date !== date).concat(snap).sort((a, b) => a.date.localeCompare(b.date));
  return { version: h.version || '0.1', snapshots };
}

// ---- build per-spec series --------------------------------------------------
export function buildSeries(h: History): SpecSeries[] {
  const snaps = [...h.snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const names = new Set<string>();
  snaps.forEach((s) => s.specs.forEach((sp) => names.add(sp.name)));
  const out: SpecSeries[] = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const points: SeriesPoint[] = [];
    for (const s of snaps) {
      const sp = s.specs.find((x) => x.name === name);
      if (!sp) continue;   // spec absent from this snapshot — skip the point
      points.push({
        date: s.date, health: healthScore(sp),
        errors: sp.errors, warnings: sp.warnings, infos: sp.infos,
        violations: sp.errors + sp.warnings + sp.infos, coverage: sp.coverage,
      });
    }
    out.push({ name, points });
  }
  return out;
}

// ---- trend detection --------------------------------------------------------
// Least-squares slope of the values against their index (0,1,2,…).
export function linregSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += values[i]; sxx += i * i; sxy += i * values[i]; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

// Trend of a numeric array over its last `window` values. `flat` is the
// |slope| threshold below which the series is considered flat; `higherIsBetter`
// controls whether a rising slope counts as improving (health) or degrading
// (violation counts).
export function trendOf(values: number[], window = DEFAULT_WINDOW, flat = FLAT_SLOPE, higherIsBetter = true): Trend {
  const w = values.slice(-Math.max(2, window));
  const slope = linregSlope(w);
  const first = w[0] ?? 0, last = w[w.length - 1] ?? 0;
  let direction: Direction;
  if (Math.abs(slope) < flat) direction = 'flat';
  else if (slope > 0) direction = higherIsBetter ? 'improving' : 'degrading';
  else direction = higherIsBetter ? 'degrading' : 'improving';
  return { slope, direction, degrading: direction === 'degrading', delta: last - first, first, last, windowLength: w.length };
}

// Health trend of a per-spec series (higher health is better).
export function trend(series: SpecSeries, window = DEFAULT_WINDOW): Trend {
  return trendOf(series.points.map((p) => p.health), window, FLAT_SLOPE, true);
}

// ---- growing problem list ---------------------------------------------------
// Rank specs by how badly they are degrading. A spec is degrading if its health
// is trending down OR its raw violation count is trending up. The ranking score
// blends both, so specs whose problem list is actively growing rank worst.
export function rankDegrading(seriesList: SpecSeries[], window = DEFAULT_WINDOW): DegradingSpec[] {
  const out: DegradingSpec[] = [];
  for (const series of seriesList) {
    if (series.points.length < 2) continue;
    const healthTrend = trend(series, window);
    const violationTrend = trendOf(series.points.map((p) => p.violations), window, 0.25, false);
    const latest = series.points[series.points.length - 1];
    const isDegrading = healthTrend.degrading || violationTrend.degrading;
    if (!isDegrading) continue;
    // worse = health falling faster and violations rising faster
    const score = Math.max(0, -healthTrend.slope) + Math.max(0, violationTrend.slope) * 3;
    out.push({
      name: series.name, series, healthTrend, violationTrend,
      latestHealth: latest.health, latestViolations: latest.violations,
      violationDelta: violationTrend.delta, score,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ---- estate rollup ----------------------------------------------------------
// Estate health per snapshot is the equal-weight mean of the health of every
// spec present in that snapshot — so one improving spec can mask another that
// is degrading, which is exactly what the per-spec view and the growing-problem
// list exist to expose.
export function estateRollup(h: History, window = DEFAULT_WINDOW): EstateRollup {
  const snaps = [...h.snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const points: SeriesPoint[] = snaps.map((s) => {
    const healths = s.specs.map((sp) => healthScore(sp));
    const health = healths.length ? Math.round(healths.reduce((a, b) => a + b, 0) / healths.length) : 0;
    const errors = s.specs.reduce((a, sp) => a + sp.errors, 0);
    const warnings = s.specs.reduce((a, sp) => a + sp.warnings, 0);
    const infos = s.specs.reduce((a, sp) => a + sp.infos, 0);
    return { date: s.date, health, errors, warnings, infos, violations: errors + warnings + infos };
  });
  const series: SpecSeries = { name: 'Estate', points };
  const t = trendOf(points.map((p) => p.health), window, FLAT_SLOPE, true);
  const specNames = new Set<string>();
  snaps.forEach((s) => s.specs.forEach((sp) => specNames.add(sp.name)));
  return { series, trend: t, latestHealth: points.length ? points[points.length - 1].health : 0, specCount: specNames.size };
}
