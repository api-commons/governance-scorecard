import './style.css';
import {
  parseHistory, serializeHistory, appendRun, buildSeries, trend, rankDegrading, estateRollup,
  type History, type Violation, type SpecSeries, type Direction, type EstateRollup, type DegradingSpec,
} from './scorecard';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const val = (s: string) => ($(s) as HTMLTextAreaElement | HTMLInputElement).value;
const setVal = (s: string, v: string) => { ($(s) as HTMLTextAreaElement | HTMLInputElement).value = v; };

let sampleHistory = '', sampleLint = '';

init();
async function init() {
  wire();
  try {
    [sampleHistory, sampleLint] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}sample-history.yaml`).then((r) => r.text()),
      fetch(`${import.meta.env.BASE_URL}sample-lint.json`).then((r) => r.text()),
    ]);
    setVal('#history-text', sampleHistory);
    setVal('#lint-text', sampleLint);
    setVal('#run-date', '2026-07-01');
    run();
  } catch (e) { $('#report').innerHTML = `<div class="cov-error">Couldn't load samples. ${esc((e as Error).message)}</div>`; }
}

function wire() {
  $('#score').addEventListener('click', run);
  $('#load-sample').addEventListener('click', () => { setVal('#history-text', sampleHistory); setVal('#lint-text', sampleLint); setVal('#run-date', '2026-07-01'); run(); });
  $('#up-history').addEventListener('click', () => $('#file-history').click());
  $('#up-lint').addEventListener('click', () => $('#file-lint').click());
  $('#file-history').addEventListener('change', (e) => readFile(e, '#history-text', true));
  $('#file-lint').addEventListener('change', (e) => readFile(e, '#lint-text', false));
  $('#dl-history').addEventListener('click', () => download('governance-history.yaml', val('#history-text'), 'text/yaml'));
  $('#append-run').addEventListener('click', () => { ($('#drawer') as HTMLDetailsElement).open = true; $('#lint-text').focus(); });
  $('#do-append').addEventListener('click', doAppend);
  $('#engage-ae').addEventListener('click', () => { location.href = 'mailto:info@apievangelist.com?subject=' + encodeURIComponent('API governance — health trends & scorecards'); });
  $('#nav-about').addEventListener('click', (e) => { e.preventDefault(); about(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('about-modal')?.remove(); });
}

function readFile(e: Event, target: string, rerun: boolean) {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => { setVal(target, String(r.result)); if (rerun) run(); }; r.readAsText(f);
}

function doAppend() {
  const date = val('#run-date').trim();
  if (!date) { alert('Pick a run date for this Spectral result.'); return; }
  let violations: Violation[];
  try { violations = JSON.parse(val('#lint-text') || '[]'); if (!Array.isArray(violations)) throw new Error('Expected a JSON array of Spectral results.'); }
  catch (e) { return err(`Couldn't parse the Spectral result: ${(e as Error).message}`); }
  let history: History;
  try { history = parseHistory(val('#history-text') || 'snapshots: []'); }
  catch { history = { version: '0.1', snapshots: [] }; }
  const updated = appendRun(history, date, violations);
  setVal('#history-text', serializeHistory(updated));
  run();
}

function run() {
  let history: History;
  try { history = parseHistory(val('#history-text')); }
  catch (e) { return err(`Couldn't parse history: ${(e as Error).message}`); }
  if (!history.snapshots.length) return err('No snapshots yet. Load the sample, or append a Spectral run with a date.');

  const seriesList = buildSeries(history).filter((s) => s.name !== 'Estate');
  const estate = estateRollup(history);
  const degrading = rankDegrading(seriesList);

  $('#status').innerHTML = `<b>${history.snapshots.length}</b> snapshots · <b>${seriesList.length}</b> specs · estate health <b style="color:${healthColor(estate.latestHealth)}">${estate.latestHealth}</b> · <b style="color:${degrading.length ? 'var(--down)' : 'var(--up)'}">${degrading.length}</b> degrading`;
  render(seriesList, estate, degrading, history);
}
function err(msg: string) { $('#report').innerHTML = `<div class="cov-error">${esc(msg)}</div>`; }

function render(seriesList: SpecSeries[], estate: EstateRollup, degrading: DegradingSpec[], history: History) {
  // rank cards worst-first by latest health
  const cards = [...seriesList].sort((a, b) => last(a).health - last(b).health);
  const et = estate.trend;

  $('#report').innerHTML = `
    <div class="hero">
      <div class="gauge">
        <div class="gauge-num" style="color:${healthColor(estate.latestHealth)}">${estate.latestHealth}</div>
        <div class="gauge-cap">estate health<br>(latest snapshot)</div>
        <div class="gauge-trend dir-${et.direction}">${arrow(et.direction)} ${dirLabel(et.direction)} ${deltaStr(et.delta)}</div>
      </div>
      <div class="hero-spark">${sparkline(estate.series.points.map((p) => p.health), et.direction, 200, 60)}</div>
      <div class="facts">
        <div class="fact"><b>${estate.specCount}</b><span>specs tracked</span></div>
        <div class="fact"><b>${history.snapshots.length}</b><span>snapshots in series</span></div>
        <div class="fact ${degrading.length ? 'errf' : 'okf'}"><b>${degrading.length}</b><span>specs degrading</span></div>
        <div class="fact"><b>${last(estate.series).violations}</b><span>total violations now</span></div>
      </div>
    </div>
    <p class="hint">A point-in-time scorecard tells you today's number; this tracks the <strong>trend</strong>. Estate health is the mean of every spec's <strong>0–100 health score</strong> — so one improving spec can hide another whose problem list is <strong>growing</strong>. Watch the per-spec sparklines, and act on the "degrading" list before a spec becomes a crisis.</p>

    ${degrading.length ? `
    <section class="panel alert">
      <h3>Degrading — act now <span class="badge degrading">${degrading.length}</span></h3>
      <p class="small">Specs whose health is trending down or whose violation count is climbing over the last ${et.windowLength} snapshots. Worst-degrading first.</p>
      <div class="dlist">${degrading.map(drow).join('')}</div>
    </section>` : `
    <section class="panel">
      <h3>Degrading — act now</h3>
      <p class="all-good">Nothing is trending the wrong way over the last ${et.windowLength} snapshots. Keep the series going.</p>
    </section>`}

    <h2 class="section-h">Per-spec health <span class="muted small">(${cards.length} specs · worst first)</span></h2>
    <div class="grid">${cards.map((s) => card(s)).join('')}</div>

    <div class="export-bar">
      <button class="ghost-btn" id="dl-history2" type="button">Download history.yaml ↓</button>
      <span class="muted small">Keep the series in version control and append one snapshot per governance run.</span>
    </div>`;
  $('#dl-history2').addEventListener('click', () => download('governance-history.yaml', val('#history-text'), 'text/yaml'));
}

function card(s: SpecSeries): string {
  const t = trend(s);
  const p = last(s);
  return `<div class="card ${t.direction}">
    <div class="card-top">
      <span class="card-name" title="${esc(s.name)}">${esc(s.name)}</span>
      <span class="card-score" style="color:${healthColor(p.health)}">${p.health}</span>
    </div>
    <div class="card-body">
      ${sparkline(s.points.map((x) => x.health), t.direction, 130, 38)}
      <div class="card-meta">
        <span class="delta dir-${t.direction}">${arrow(t.direction)} ${dirLabel(t.direction)} ${deltaStr(t.delta)}</span>
        <span class="vbreak">${p.errors}E · ${p.warnings}W · ${p.infos}I</span>
        <span>${p.violations} violations${p.coverage != null ? ` · ${Math.round(p.coverage * 100)}% coverage` : ''}</span>
      </div>
    </div>
  </div>`;
}

function drow(d: DegradingSpec, i: number): string {
  const vt = d.violationTrend, ht = d.healthTrend;
  const vnote = vt.delta > 0 ? `+${vt.delta} violations` : `${vt.delta} violations`;
  const hnote = `health ${deltaStr(ht.delta)}`;
  return `<div class="dr">
    <div class="dr-rank">${i + 1}</div>
    <div class="dr-main">
      <div class="dr-name">${esc(d.name)}</div>
      <div class="dr-note">${vnote} · ${hnote} over last ${vt.windowLength} snapshots — <b>growing problem list</b></div>
    </div>
    ${sparkline(d.series.points.map((p) => p.violations), 'degrading', 90, 30)}
    <div class="dr-figs"><div class="big" style="color:${healthColor(d.latestHealth)}">${d.latestHealth}</div>health now · ${d.latestViolations} viol.</div>
  </div>`;
}

// ---- inline SVG sparkline (no external libs) --------------------------------
// Maps a series of values to an SVG polyline, normalized to the value range,
// with a filled area under the line and a dot on the latest point.
function sparkline(values: number[], dir: Direction, w = 130, h = 38): string {
  if (!values.length) return '';
  const pad = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const n = values.length;
  const x = (i: number) => (n === 1 ? w / 2 : pad + (i * (w - 2 * pad)) / (n - 1));
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${pad},${h - pad} ${pts} ${(w - pad).toFixed(1)},${h - pad}`;
  const lx = x(n - 1).toFixed(1), ly = y(values[n - 1]).toFixed(1);
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="trend ${dir}">
    <polygon class="spark-area ${dir}" points="${area}"/>
    <polyline class="spark-line ${dir}" points="${pts}"/>
    <circle class="spark-dot ${dir}" cx="${lx}" cy="${ly}" r="2.6"/>
  </svg>`;
}

const last = (s: SpecSeries) => s.points[s.points.length - 1];
function healthColor(h: number): string { return h >= 70 ? 'var(--ok)' : h >= 40 ? 'var(--warn)' : 'var(--error)'; }
function arrow(dir: Direction): string { return dir === 'improving' ? '▲' : dir === 'degrading' ? '▼' : '▬'; }
function dirLabel(dir: Direction): string { return dir === 'improving' ? 'improving' : dir === 'degrading' ? 'degrading' : 'flat'; }
function deltaStr(d: number): string { const r = Math.round(d); return r > 0 ? `+${r}` : `${r}`; }

function download(name: string, content: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

function about() {
  const el = document.createElement('div');
  el.id = 'about-modal';
  el.innerHTML = `<div class="about-backdrop"></div><div class="about-card">
    <button class="detail-close" id="about-close">&times;</button>
    <h2>Governance has a time axis</h2>
    <p>Every governance scorecard on the market is <strong>point-in-time</strong>: it tells you today's errors, warnings, and score. But the number that matters is the <em>direction</em>. A spec sitting at a health of 60 that was 85 last month is a problem; a spec at 55 climbing from 30 is a success. You can't tell them apart from a single snapshot.</p>
    <p>This tool keeps the <strong>history</strong>. Feed it a series of governance snapshots — or append each <code>spectral lint -f json</code> run as you go — and it computes a <strong>0–100 health score</strong> per spec per snapshot, renders the trend as a sparkline, and flags the specs whose problem lists are <strong>growing</strong>. As one Spectral maintainer put it: a spec with a growing list of problems is one you want to act on <em>before</em> it goes the wrong direction.</p>
    <p><strong>Health</strong> weights errors far above warnings and infos, and scales down for low ruleset coverage — a clean spec that checks little of the API isn't as healthy as it looks. The estate rollup is the mean across specs, which is exactly why the per-spec view and the degrading list exist: an average can hide the one spec that's sliding.</p>
    <p class="muted small">Runs entirely in your browser. Nothing you paste leaves the page.</p>
  </div>`;
  document.body.appendChild(el);
  el.querySelector('#about-close')!.addEventListener('click', () => el.remove());
  el.querySelector('.about-backdrop')!.addEventListener('click', () => el.remove());
}
