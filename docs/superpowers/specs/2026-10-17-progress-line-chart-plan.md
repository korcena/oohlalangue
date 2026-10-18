# Progress Score Line Chart — Focused Implementation Plan

Date: 2026-10-17
Branch: `feature/chat-worksheet-lite`
Status: Ready for execution
Scope: Add a hand-rolled inline SVG line chart of weekly average scores to the existing
"Progrès" panel on the landing page. No new dependency, no charting library, no server or
storage change. The existing textual details remain unchanged.

This plan is Markdown only. It does not implement code. Each task is written so an independent
agent can execute it.

---

## 1. Objective

In `buildProgressPanel(history, now)` (`public/views/landing.js`), add an "Évolution" section
between "Cette semaine" and "12 dernières semaines" that plots **the weekly average score
(0–100)** as a line chart:

- One point per week that has graded fiches, within the existing 12-week window.
- Chronological order (oldest → newest), despite `historyByWeek()` returning most-recent-first.
- Gold line and dots, muted 0/50/100 grid labels, subtle gridlines, responsive `viewBox`.
- The existing "12 dernières semaines" list stays as the exact-value / accessible fallback.
- All SVG is created with `document.createElementNS` and `textContent`; never `innerHTML`.

---

## 2. Relevant Files

| File | Role | Change |
|---|---|---|
| `public/lib/scores.js` | `readHistory`, `historyByWeek`, `thisWeek`; buckets are `{ weekStart, entries, count, average }`, newest-first | Read only |
| `public/views/landing.js` | `buildProgressPanel`; current panel and 12-week list | Edit |
| `public/styles.css` | Tokens and `.summary-card` at ~1205 | Edit |
| `public/lib/chart.js` | New pure, DOM-free chart geometry | Create |
| `test/chart.test.js` | New `node:test` unit tests | Create |
| `test/scores.test.js` | Existing dynamic-import test convention to copy | Read only |
| `package.json` | `node --test`, `eslint .` | No change |

---

## 3. Data Mapping and Module Contract

### 3.1 Location and signature

Create `public/lib/chart.js` as a browser-native ES module. It must be pure and DOM-free, like
`public/lib/scores.js`.

```js
buildScoreSeries(buckets, {
  width = 600,
  height = 180,
  padding = { top: 16, right: 16, bottom: 28, left: 36 },
  maxWeeks = 12
} = {})
```

Return:

```js
{
  width,
  height,
  plot: { left, top, right, bottom, width, height },
  points: [{ weekStart, average, count, x, y }],
  polyline: '',
  gridlines: [{ value: 100, y }, { value: 50, y }, { value: 0, y }],
  minWeekStart: null,
  maxWeekStart: null,
  empty: true
}
```

- `plot.left = padding.left`, `plot.right = width - padding.right`,
  `plot.top = padding.top`, `plot.bottom = height - padding.bottom`,
  `plot.width = max(0, plot.right - plot.left)`,
  `plot.height = max(0, plot.bottom - plot.top)`.
- `width`/`height` are validated to finite positive numbers and `padding` values to finite
  non-negative numbers; invalid values fall back to the defaults. If padding consumes the whole
  area, `plot.width`/`plot.height` clamp to `0` rather than producing negative coordinates.
- `maxWeeks` must be a positive finite integer; any other value falls back to `12`.
- The whole function is wrapped in `try/catch` and returns an empty series rather than throwing.
- `points`, `x`, `y`, and `gridlines[].y` are rounded to 2 decimal places for deterministic
  markup and tests.
- `polyline` is `''` for 0 or 1 point; for 2+ points it is
  `points.map((p) => `${p.x},${p.y}`).join(' ')`.
- `gridlines` always uses the same y mapping as the points (100, 50, 0, in that order).
- `empty` is `true` when there are no valid points.

### 3.2 Bucket normalization

1. `buckets` must be an array; otherwise return the empty series.
2. Skip anything that is not a plain object.
3. Accept only finite `weekStart`, finite `count > 0`, and finite `average`.
4. Clamp `average` to `[0, 100]` so a corrupt 150 plots at the top, not outside the plot.
5. Deduplicate by `weekStart`; if duplicates exist, the **last valid bucket in input order wins**
   (deterministic, defensive only — real buckets are already unique).
6. Sort ascending by `weekStart`.
7. Apply the 12-week bound: if more than `maxWeeks` points remain, keep the newest
   `maxWeeks` (`slice(-maxWeeks)`). The landing page also passes an already-capped
   `historyByWeek()` result, so this is a harmless second guard and makes the module testable
   in isolation.
8. If no points remain, return the empty series.

A week with no graded fiches is simply absent from the input. One bucket per week is plotted,
using its `average`, which already aggregates multiple fiches.

### 3.3 X mapping (actual week spacing, gaps visible)

After sorting and capping:

```text
span = maxWeekStart - minWeekStart
if points.length === 1 || span <= 0:
  x = plot.left + plot.width / 2          // center the single dot
else:
  x = plot.left + ((weekStart - minWeekStart) / span) * plot.width
```

This uses the real epoch-ms week starts rather than a fixed 7-day multiplier, so DST-shortened/
lengthened weeks do not break the mapping. Missing weeks produce proportionally larger x gaps.
The chart's x range is the data range (`minWeekStart` → `maxWeekStart`), not a synthetic
12-calendar-week axis; the 12-week bound is enforced on the buckets.

### 3.4 Y mapping (0–100)

```text
y = plot.bottom - (average / 100) * plot.height
```

- `0` → `plot.bottom`.
- `100` → `plot.top`.
- Equal scores produce a flat horizontal line with no division.
- A single point has no line, so there is no divide-by-zero anywhere.

### 3.5 Gaps

Connect points with one continuous polyline even when intermediate weeks have no data. Rationale:
the 12-week window is short and sparse, one polyline is simpler, and the larger x gap plus the
exact list/aria description already make the missing weeks visible. Do not invent zero-score
points for empty weeks.

---

## 4. Rendering in `public/views/landing.js`

### 4.1 Placement and early return

- Keep the existing `if (!history.entries.length)` early return. It already skips the whole
  chart and shows the French empty-state note.
- Compute `const buckets = historyByWeek(history, now);` **once** after the "Cette semaine"
  block, then use it for both the chart and the existing 12-week list. Do not call
  `historyByWeek` a second time.
- Build `const series = buildScoreSeries(buckets);`.
- If `series.empty`, skip the "Évolution" heading and SVG; still render the existing list
  unchanged.
- Otherwise append, in order: an `h4` with `textContent = 'Évolution'`, then the SVG, then the
  existing "12 dernières semaines" heading and list.

### 4.2 SVG builder

Add a local helper such as `buildScoreChart(series)` in `landing.js`. Use
`const SVG_NS = 'http://www.w3.org/2000/svg';` and `document.createElementNS(SVG_NS, ...)` for
every SVG element. No `innerHTML`; labels and titles use `textContent`.

Structure:

```text
<svg class="score-chart" viewBox="0 0 600 180" role="img" aria-label="…">
  <g class="score-chart-grid" aria-hidden="true">
    <line class="score-chart-grid-line" x1=plot.left x2=plot.right y1=grid.y y2=grid.y />  (100, 50, 0)
  </g>
  <g class="score-chart-labels" aria-hidden="true">
    <text class="score-chart-label" x=plot.left-6 y=grid.y text-anchor="end"
          dominant-baseline="middle">100 / 50 / 0</text>
  </g>
  <polyline class="score-chart-line" points={series.polyline} fill="none" />  (only if non-empty)
  <g class="score-chart-dots">
    <circle class="score-chart-dot" cx={x} cy={y} r="3.5">
      <title>Semaine du … — 78 % (2 fiches)</title>
    </circle>
  </g>
</svg>
```

- Create the polyline only when `series.polyline` is non-empty, so a single point is a dot with
  no line.
- Each circle's `<title>` uses `weekLabel(point.weekStart)`, `point.average`, and
  `ficheCount(point.count)`; this is hover-only supplementary information and contains no
  learner/model text.
- Set `role="img"`, `aria-label`, and optionally `focusable="false"` on the `<svg>`. Use
  `series.width`/`series.height` in `viewBox`. Do not set fixed pixel width/height; CSS controls
  responsiveness.

### 4.3 French `aria-label`

Build the label in the view (it has `weekLabel` and `ficheCount`). Summarize the trend, not every
point:

- One point: `Score moyen de 80 % pour la semaine du 5 octobre.`
- Two or more: compare the first and last average with a ±2-point threshold:
  `Évolution du score moyen hebdomadaire, en progression : de 55 % (semaine du 5 octobre) à
  78 % (semaine du 12 novembre), sur 4 semaines avec des fiches.`
- Use `stable` when `|last.average - first.average| <= 2`, `en progression` when the delta is
  greater than 2, `en baisse` when less than -2.
- No topics, prompts, or other learner/model-derived strings are added to the chart. Only
  numbers, French dates, and fiche counts.

---

## 5. CSS

Insert after the `.summary-card ul` block (~line 1237), keeping the file's existing indentation
and dark/gold token language:

```css
.score-chart {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
  margin: 2px 0 6px;
}

.score-chart .score-chart-grid-line {
  stroke: var(--border);
  stroke-width: 1;
}

.score-chart .score-chart-label {
  fill: var(--muted);
  font-family: inherit;
  font-size: 10px;
}

.score-chart .score-chart-line {
  fill: none;
  stroke: var(--gold);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.score-chart .score-chart-dot {
  fill: var(--gold);
  stroke: var(--panel);
  stroke-width: 2;
}
```

`viewBox` plus `width: 100%; height: auto` makes the chart scale with the panel. The 600×180
viewBox fits the panel's 640px max width with its 20px padding. Do not add a chart library or
external font.

---

## 6. Tests: `test/chart.test.js`

Use the existing CommonJS + dynamic-import pattern from `test/scores.test.js`:

```js
let modPromise = null;
function loadChart() {
  if (!modPromise) modPromise = import('../public/lib/chart.js');
  return modPromise;
}
```

Use a tiny explicit geometry for exact assertions, for example
`{ width: 100, height: 100, padding: { top: 10, right: 10, bottom: 10, left: 10 } }`, giving
`plot = { left: 10, top: 10, right: 90, bottom: 90, width: 80, height: 80 }`.

Required cases:

1. **Empty input**: `undefined`, `[]`, and buckets with `count: 0` return `empty: true`,
   `points: []`, `polyline: ''`, `minWeekStart/maxWeekStart === null`, no throw.
2. **Single point**: one bucket at 80 % → one point, no NaN, `x = 50` (plot center), `y = 26`,
   `polyline === ''`, no line geometry.
3. **Ordering**: input in most-recent-first order → `points` sorted ascending by `weekStart`,
   x strictly increasing, and `polyline` built in that same order.
4. **0 / 100 mapping**: points with averages 0 and 100 → y is `plot.bottom` and `plot.top`
   respectively; all y values stay within `[plot.top, plot.bottom]`.
5. **Equal scores**: three points all at 75 % → identical y, finite, no division issues.
6. **Gap spacing**: weeks `W`, `W+7d`, `W+21d` → the second x gap is twice the first; missing
   week is not filled with a zero point.
7. **Duplicate weeks**: two buckets with the same `weekStart` → last valid one wins and only one
   point is emitted.
8. **Corrupt buckets**: `null`, `{}`, `NaN` week start, missing/non-finite average,
   `count: 0`, and an out-of-range average (e.g. 150) → invalid ones skipped, 150 clamped to
   the top; function never throws.
9. **12-week bound**: 13 consecutive weekly buckets → only the newest 12 remain; the oldest is
   dropped; points are still sorted.
10. **Gridlines**: 0/50/100 y values match the same mapping and are ordered top-to-bottom as
    returned.
11. **Polyline format**: for 2+ points it equals the space-joined `x,y` of the returned points.
12. **Coordinate invariant**: in every case with points, `x` is within
    `[plot.left, plot.right]` and `y` within `[plot.top, plot.bottom]`.

View-level verification limits: the repo has no DOM/jsdom harness (tests for views use pure
render models), so `buildScoreChart`, SVG element creation, tooltips, and the aria-label are not
unit-tested. Verify manually in a browser: empty state, one point (dot only), several points,
a gap, a flat line, narrow mobile width, hover tooltips, the accessible name in the browser
accessibility tree, and that the "12 dernières semaines" list is unchanged. The existing
`test/manual-qa.md` section H is the right place to perform this check; no manual-QA file edit is
required for this scope.

---

## 7. Implementation Tasks

### Task 1 — Create `public/lib/chart.js`

Implement the pure module exactly per sections 3.1–3.5. Include a file header comment explaining
that it is DOM-free, fail-open, and accepts buckets in any order. Export only
`buildScoreSeries` unless a small internal helper improves clarity. Do not import from
`landing.js` or touch `scores.js`.

### Task 2 — Edit `public/views/landing.js`

Import `buildScoreSeries`. In `buildProgressPanel`, compute the buckets once, build the series,
append the "Évolution" heading and SVG when non-empty, and keep the existing 12-week list.
Add the local `buildScoreChart(series)` and `chartAriaLabel(series)` helpers. Use only
`createElementNS`/`createElement`, `setAttribute`, and `textContent`; no `innerHTML`.

### Task 3 — Edit `public/styles.css`

Add the `.score-chart` rules from section 5 after `.summary-card ul`. Verify the SVG renders at
full panel width and that gold line/dots and muted labels use the existing variables.

### Task 4 — Create `test/chart.test.js`

Implement the cases in section 6 using `node:test` and `node:assert/strict`, following the
dynamic-import convention already used for `public/lib/*.js`.

### Task 5 — Verify

Run `npm test` and `npm run lint`. Then manually load `#/` with seeded score history and check the
visual/accessibility behavior listed at the end of section 6. No changes to `server.js`,
`package.json`, storage keys, or score-history semantics.

---

## 8. Files to Change, in Order

1. `public/lib/chart.js` (new) — pure chart geometry and normalization.
2. `public/views/landing.js` — build and insert the "Évolution" SVG, reuse one bucket list.
3. `public/styles.css` — `.score-chart` line/dot/grid/label rules.
4. `test/chart.test.js` (new) — geometry, ordering, edge cases, 12-week bound.

This plan document itself is `docs/superpowers/specs/2026-10-17-progress-line-chart-plan.md`.

---

## 9. Potential Risks

- **Sparse-data continuity:** connecting across missing weeks may imply data that does not
  exist. Accepted for simplicity; the x gap, exact list, and aria-label mitigate it.
- **DST:** using `(weekStart - minWeekStart) / span` avoids assuming every week is exactly
  604,800,000 ms. Do not replace it with a fixed 7-day divisor.
- **Single-point layout:** centering is a deliberate choice; a left-aligned dot would look like
  a truncated axis.
- **SVG scaling:** 10px axis labels shrink on narrow screens. This is acceptable for a compact
  panel; the list remains the exact fallback.
- **No view-level automated tests:** a typo in `createElementNS`/attribute names would only be
  caught manually. Follow the element/attribute structure in section 4.2 exactly.
- **Duplicate 12-week capping:** the landing page and the chart module both cap at 12. This is
  intentional defense in depth and produces the same newest-12 result.
- **Security rule:** no learner/model strings enter the chart. Even though only numbers and
  dates are used, still use `textContent`, never `innerHTML`, for SVG text and titles.
