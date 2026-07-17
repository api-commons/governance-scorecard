# Governance Scorecard

A browser-first tool for the **longitudinal health trend of your API governance** — ingest a
series of Spectral snapshots over time, score each spec 0–100, and watch the trends and the
**growing problem lists** so you can act *before* a spec goes the wrong direction. No backend,
no accounts; runs entirely in your browser. Live at
**[scorecard.apicommons.org](https://scorecard.apicommons.org)**.

## Why this exists

The [State of Spectral](https://github.com/api-commons) research turned up more than a thousand
real governance pipelines, and a recurring gap: the tooling is **point-in-time**. Vacuum's
scorecard, a Spectral summary, a CI gate — each tells you *today's* errors, warnings, and score.
None of them tell you the **direction**. A spec sitting at a health of 60 that was 85 last month
is a problem; a spec at 55 climbing from 30 is a win. From a single snapshot you cannot tell them
apart.

As one Spectral maintainer framed it, the thing you actually want to catch is *a spec with a
growing list of problems* — so you can act before it becomes a crisis. That requires **history**,
and history is the piece nobody ships. This tool is that missing piece: a run series, a health
score, a trend, and a ranked "act now" list of the specs sliding the wrong way.

Part of the [API Commons](https://apicommons.org/tools/) tools, alongside
[Governance Coverage](https://github.com/api-commons/governance-coverage),
[Governance Waivers](https://github.com/api-commons/governance-waivers),
[API Validator](https://github.com/api-commons/api-validator),
[API Governance Graph](https://github.com/api-commons/api-governance-graph), and
[Spectral Ruleset Studio](https://github.com/api-commons/spectral-ruleset-studio).

## The run series

A history is a small, machine-readable list of dated governance snapshots, each snapshot a set
of per-spec violation counts (plus optional rule count and coverage):

```yaml
version: "0.1"
snapshots:
  - date: "2026-05-01"
    specs:
      - { name: payments-api, errors: 2, warnings: 6, infos: 3, ruleCount: 40, coverage: 0.78 }
      - { name: legacy-api,   errors: 7, warnings: 10, infos: 5, ruleCount: 30, coverage: 0.33 }
  - date: "2026-06-01"
    specs:
      - { name: payments-api, errors: 1, warnings: 4, infos: 2, ruleCount: 40, coverage: 0.82 }
      - { name: legacy-api,   errors: 9, warnings: 12, infos: 6, ruleCount: 30, coverage: 0.30 }
```

You can build the series incrementally: paste a raw `spectral lint -f json` result, tag it with a
date, and **Append run** turns it into a snapshot (grouping violations by `source`) and adds it to
the history. Keep the file in version control and append one snapshot per governance run.

## What it reports

- **Estate health** — the latest overall score and its trend arrow, with an estate-wide
  sparkline. The rollup is the mean across specs, which is *why* the per-spec view matters: an
  average hides the one spec that's sliding.
- **Per-spec health** — a card per spec with its current 0–100 score, an inline SVG sparkline of
  health over time (colored improving / degrading / flat), the latest error/warning/info
  breakdown, and the delta over the trend window.
- **Degrading — act now** — the growing problem list: specs whose health is trending down *or*
  whose violation count is climbing over the last N snapshots, ranked worst-first, each with the
  violation trend so you can see the problem list growing.

Everything runs client-side; the history and lint output you paste never leave the page.

## The health formula

Health is a 0–100 score, defined and documented in [`src/scorecard.ts`](src/scorecard.ts). It is
driven by a weighted violation penalty — errors count far more than warnings, and warnings more
than infos — and is scaled down when ruleset coverage is low, because a clean spec whose ruleset
checks little of the API is not as healthy as it looks:

```
penalty  = errors·6 + warnings·2 + infos·0.5
base     = clamp(100 − penalty, 0, 100)
health   = coverage present ? round(base · (0.6 + 0.4·coverage))   // coverage ∈ [0,1]
                            : round(base)
```

Weights (`ERROR_WEIGHT`, `WARNING_WEIGHT`, `INFO_WEIGHT`), the coverage floor, and the trend
window are exported constants — tune them to your program. **Trend** is the least-squares slope of
health over the last N snapshots; a slope past a small flat band reads as improving or degrading.
The **growing problem list** blends a falling health slope with a rising violation slope, so specs
whose problems are actively accumulating rank worst.

## Develop

```bash
npm install
npm run dev
npm run build     # → dist/
```

Pure client-side; no data build. The sample in `public/sample-history.yaml` is six monthly
snapshots across four specs showing both improving and degrading trends.

## Privacy

Everything runs client-side. The history and Spectral output you paste never leave the page —
there is no server.

---

**Governance guidance** — the human *why* behind measuring over time:
[Rules](https://guidance.apievangelist.com/store/rules/) and
[Accountability](https://guidance.apievangelist.com/store/accountability/) at
guidance.apievangelist.com.

A project of [API Evangelist](https://apievangelist.com), maintained openly under
[API Commons](https://apicommons.org). Free to fork; API Evangelist offers expert API governance
services — including standing up a health-trend program across your estate — when you want help.
Apache-2.0.
