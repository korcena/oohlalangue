'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// `public/lib/*.js` are browser-native ES modules. Load them dynamically from
// this CommonJS test file, caching the promise so they are evaluated once.
let modPromise = null;
function loadChart() {
  if (!modPromise) modPromise = import('../public/lib/chart.js');
  return modPromise;
}

const GEOMETRY = {
  width: 100,
  height: 100,
  padding: { top: 10, right: 10, bottom: 10, left: 10 }
};

function bucket(weekStart, average, count = 1) {
  return { weekStart, average, count, entries: [] };
}

function expectedPlot() {
  return { left: 10, top: 10, right: 90, bottom: 90, width: 80, height: 80 };
}

function assertInBounds(series) {
  for (const point of series.points) {
    assert.ok(point.x >= series.plot.left && point.x <= series.plot.right);
    assert.ok(point.y >= series.plot.top && point.y <= series.plot.bottom);
  }
}

// -- 1: empty input ---------------------------------------------------------

test('empty: undefined, [] and zero-count buckets return an empty series', async () => {
  const { buildScoreSeries } = await loadChart();
  for (const input of [undefined, [], [bucket(1000, 80, 0)]]) {
    let series;
    assert.doesNotThrow(() => {
      series = buildScoreSeries(input, GEOMETRY);
    });
    assert.equal(series.empty, true);
    assert.deepEqual(series.points, []);
    assert.equal(series.polyline, '');
    assert.equal(series.minWeekStart, null);
    assert.equal(series.maxWeekStart, null);
    assert.deepEqual(series.plot, expectedPlot());
  }
});

// -- 2: single point --------------------------------------------------------

test('single point: centered x, 0-100 y, no polyline', async () => {
  const { buildScoreSeries } = await loadChart();
  const series = buildScoreSeries([bucket(1000, 80)], GEOMETRY);
  assert.equal(series.empty, false);
  assert.equal(series.points.length, 1);
  assert.equal(series.points[0].x, 50);
  assert.equal(series.points[0].y, 26);
  assert.equal(series.polyline, '');
  assert.equal(series.minWeekStart, 1000);
  assert.equal(series.maxWeekStart, 1000);
  for (const value of [series.points[0].x, series.points[0].y]) {
    assert.ok(Number.isFinite(value));
  }
});

// -- 3: ordering ------------------------------------------------------------

test('ordering: newest-first input is sorted ascending and x increases', async () => {
  const { buildScoreSeries } = await loadChart();
  const weeks = [3000, 1000, 2000];
  const series = buildScoreSeries(weeks.map((w) => bucket(w, 50)), GEOMETRY);
  assert.deepEqual(
    series.points.map((p) => p.weekStart),
    [1000, 2000, 3000]
  );
  assert.ok(series.points[0].x < series.points[1].x);
  assert.ok(series.points[1].x < series.points[2].x);
  assert.equal(
    series.polyline,
    series.points.map((p) => `${p.x},${p.y}`).join(' ')
  );
});

// -- 4: 0 / 100 mapping -----------------------------------------------------

test('0 and 100 map to the plot bottom and top; all y stay in bounds', async () => {
  const { buildScoreSeries } = await loadChart();
  const series = buildScoreSeries([bucket(1000, 0), bucket(2000, 100)], GEOMETRY);
  assert.equal(series.points[0].y, series.plot.bottom);
  assert.equal(series.points[1].y, series.plot.top);
  assertInBounds(series);
});

// -- 5: equal scores --------------------------------------------------------

test('equal scores: flat finite line with identical y', async () => {
  const { buildScoreSeries } = await loadChart();
  const series = buildScoreSeries(
    [bucket(1000, 75), bucket(2000, 75), bucket(3000, 75)],
    GEOMETRY
  );
  const expectedY = series.plot.bottom - 0.75 * series.plot.height;
  const ys = series.points.map((p) => p.y);
  assert.deepEqual(ys, [expectedY, expectedY, expectedY]);
  const polylineYs = series.polyline.split(' ').map((pair) => Number(pair.split(',')[1]));
  assert.deepEqual(polylineYs, [expectedY, expectedY, expectedY]);
  assert.ok(Number.isFinite(expectedY));
  assertInBounds(series);
});

// -- 6: gap spacing ---------------------------------------------------------

test('gaps: a missing week doubles the x gap and is not filled with a zero', async () => {
  const { buildScoreSeries } = await loadChart();
  const week = 7 * 24 * 60 * 60 * 1000;
  const start = 1000000;
  const series = buildScoreSeries(
    [bucket(start, 50), bucket(start + week, 60), bucket(start + 3 * week, 70)],
    GEOMETRY
  );
  assert.equal(series.points.length, 3);
  const gap1 = series.points[1].x - series.points[0].x;
  const gap2 = series.points[2].x - series.points[1].x;
  assert.ok(Math.abs(gap2 - 2 * gap1) <= 0.02);
  assert.deepEqual(
    series.points.map((p) => p.weekStart),
    [start, start + week, start + 3 * week]
  );
});

// -- 7: duplicate weeks -----------------------------------------------------

test('duplicate weeks: last valid bucket wins and only one point is emitted', async () => {
  const { buildScoreSeries } = await loadChart();
  const series = buildScoreSeries(
    [bucket(1000, 40), bucket(1000, 90), bucket(2000, 60)],
    GEOMETRY
  );
  assert.equal(series.points.length, 2);
  const first = series.points.find((p) => p.weekStart === 1000);
  assert.equal(first.average, 90);
});

// -- 8: corrupt buckets -----------------------------------------------------

test('corrupt buckets are skipped, out-of-range averages clamp, never throws', async () => {
  const { buildScoreSeries } = await loadChart();
  const input = [
    null,
    {},
    { weekStart: NaN, average: 50, count: 1 },
    { weekStart: 1000, average: 'x', count: 1 },
    { weekStart: 1000, average: 50, count: 0 },
    bucket(2000, 150),
    bucket(3000, -20)
  ];
  let series;
  assert.doesNotThrow(() => {
    series = buildScoreSeries(input, GEOMETRY);
  });
  assert.equal(series.points.length, 2);
  assert.equal(series.points[0].average, 100);
  assert.equal(series.points[0].y, series.plot.top);
  assert.equal(series.points[1].average, 0);
  assert.equal(series.points[1].y, series.plot.bottom);
  assertInBounds(series);
});

// -- 9: 12-week bound -------------------------------------------------------

test('12-week bound: keeps the newest 12 and drops the oldest', async () => {
  const { buildScoreSeries } = await loadChart();
  const week = 7 * 24 * 60 * 60 * 1000;
  const start = 1000000;
  const input = [];
  for (let i = 0; i < 13; i += 1) input.push(bucket(start + i * week, 50 + i));
  const series = buildScoreSeries(input, GEOMETRY);
  assert.equal(series.points.length, 12);
  assert.equal(series.points[0].weekStart, start + week);
  assert.equal(series.points[11].weekStart, start + 12 * week);
  assert.equal(series.minWeekStart, start + week);
  assert.equal(series.maxWeekStart, start + 12 * week);
  for (let i = 1; i < series.points.length; i += 1) {
    assert.ok(series.points[i].weekStart > series.points[i - 1].weekStart);
  }
});

// -- 10: gridlines ----------------------------------------------------------

test('gridlines: 0/50/100 share the point y mapping, ordered top to bottom', async () => {
  const { buildScoreSeries } = await loadChart();
  const series = buildScoreSeries([bucket(1000, 0), bucket(2000, 100)], GEOMETRY);
  assert.deepEqual(
    series.gridlines.map((g) => g.value),
    [100, 50, 0]
  );
  assert.equal(series.gridlines[0].y, series.plot.top);
  assert.equal(series.gridlines[1].y, 50);
  assert.equal(series.gridlines[2].y, series.plot.bottom);
  assert.ok(series.gridlines[0].y < series.gridlines[1].y);
  assert.ok(series.gridlines[1].y < series.gridlines[2].y);
});

// -- 11: polyline format ----------------------------------------------------

test('polyline: space-joined rounded x,y pairs for 2+ points', async () => {
  const { buildScoreSeries } = await loadChart();
  const series = buildScoreSeries([bucket(1000, 30), bucket(2000, 70)], GEOMETRY);
  assert.equal(series.polyline, `${series.points[0].x},${series.points[0].y} ${series.points[1].x},${series.points[1].y}`);
  assert.match(series.polyline, /^\d+(\.\d+)?,\d+(\.\d+)? \d+(\.\d+)?,\d+(\.\d+)?$/);
});

// -- 12: coordinate invariant ----------------------------------------------

test('coordinate invariant: x and y stay within the plot in every non-empty case', async () => {
  const { buildScoreSeries } = await loadChart();
  const cases = [
    [bucket(1000, 80)],
    [bucket(1000, 0), bucket(2000, 100)],
    [bucket(1000, 75), bucket(2000, 75), bucket(3000, 75)],
    [bucket(1000, 25), bucket(1000, 90), bucket(3000, 55)]
  ];
  for (const input of cases) assertInBounds(buildScoreSeries(input, GEOMETRY));
});

// -- option validation ------------------------------------------------------

test('invalid geometry and maxWeeks fall back without throwing', async () => {
  const { buildScoreSeries } = await loadChart();
  const week = 7 * 24 * 60 * 60 * 1000;
  const start = 1000000;
  const input = [];
  for (let i = 0; i < 13; i += 1) input.push(bucket(start + i * week, 50 + i));
  let series;
  assert.doesNotThrow(() => {
    series = buildScoreSeries(input, {
      width: -1,
      height: 0,
      padding: { top: -2 },
      maxWeeks: 0
    });
  });
  assert.equal(series.width, 600);
  assert.equal(series.height, 180);
  assert.deepEqual(series.plot, { left: 36, top: 16, right: 584, bottom: 152, width: 548, height: 136 });
  assert.equal(series.points.length, 12);
  assert.equal(series.points[0].weekStart, start + week);
  assert.equal(series.points[11].weekStart, start + 12 * week);
  assertInBounds(series);
});

// -- extreme finite span ----------------------------------------------------

test('extreme finite week starts: span overflow keeps finite centered x', async () => {
  const { buildScoreSeries } = await loadChart();
  const series = buildScoreSeries(
    [bucket(-Number.MAX_VALUE, 40), bucket(Number.MAX_VALUE, 60)],
    GEOMETRY
  );
  assert.equal(series.points.length, 2);
  for (const point of series.points) {
    assert.ok(Number.isFinite(point.x));
    assert.equal(point.x, 50);
  }
  assertInBounds(series);
});
