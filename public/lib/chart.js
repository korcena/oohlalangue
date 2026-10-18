// Pure, DOM-free geometry for the weekly score line chart.
//
// Buckets come from `historyByWeek()` (newest first) but this module accepts
// them in ANY order: it normalizes, clamps, deduplicates, sorts ascending and
// keeps the newest `maxWeeks` points. The whole function is fail-open and
// returns an empty series rather than throwing, so corrupt stored data can
// never break the landing page. No DOM, no imports, no dependencies.

const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 180;
const DEFAULT_PADDING = { top: 16, right: 16, bottom: 28, left: 36 };
const DEFAULT_MAX_WEEKS = 12;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function buildPlot(width, height, padding) {
  const left = padding.left;
  const right = width - padding.right;
  const top = padding.top;
  const bottom = height - padding.bottom;
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

function buildGridlines(plot) {
  return [100, 50, 0].map((value) => ({
    value,
    y: round2(plot.bottom - (value / 100) * plot.height)
  }));
}

function emptySeries(width, height, plot) {
  return {
    width,
    height,
    plot,
    points: [],
    polyline: '',
    gridlines: buildGridlines(plot),
    minWeekStart: null,
    maxWeekStart: null,
    empty: true
  };
}

export function buildScoreSeries(buckets, options = {}) {
  try {
    const opts = isPlainObject(options) ? options : {};
    const width = positiveNumber(opts.width, DEFAULT_WIDTH);
    const height = positiveNumber(opts.height, DEFAULT_HEIGHT);
    const rawPadding = isPlainObject(opts.padding) ? opts.padding : {};
    const padding = {
      top: nonNegativeNumber(rawPadding.top, DEFAULT_PADDING.top),
      right: nonNegativeNumber(rawPadding.right, DEFAULT_PADDING.right),
      bottom: nonNegativeNumber(rawPadding.bottom, DEFAULT_PADDING.bottom),
      left: nonNegativeNumber(rawPadding.left, DEFAULT_PADDING.left)
    };
    const maxWeeks =
      Number.isFinite(opts.maxWeeks) && Number.isInteger(opts.maxWeeks) && opts.maxWeeks > 0
        ? opts.maxWeeks
        : DEFAULT_MAX_WEEKS;
    const plot = buildPlot(width, height, padding);

    if (!Array.isArray(buckets)) return emptySeries(width, height, plot);

    // Last valid bucket for a given weekStart wins (defensive only: real
    // buckets are already unique). Skips non-objects, non-finite values and
    // weeks without graded fiches.
    const byWeek = new Map();
    for (const bucket of buckets) {
      if (!isPlainObject(bucket)) continue;
      if (!Number.isFinite(bucket.weekStart)) continue;
      if (!Number.isFinite(bucket.count) || bucket.count <= 0) continue;
      if (!Number.isFinite(bucket.average)) continue;
      byWeek.set(bucket.weekStart, {
        weekStart: bucket.weekStart,
        count: bucket.count,
        average: Math.min(100, Math.max(0, bucket.average))
      });
    }

    const sorted = Array.from(byWeek.values())
      .sort((a, b) => a.weekStart - b.weekStart)
      .slice(-maxWeeks);
    if (!sorted.length) return emptySeries(width, height, plot);

    const minWeekStart = sorted[0].weekStart;
    const maxWeekStart = sorted[sorted.length - 1].weekStart;
    // Real epoch-ms span (not a fixed 7-day multiplier) so DST-shortened weeks
    // still map correctly and missing weeks leave proportionally larger gaps.
    const span = maxWeekStart - minWeekStart;

    const points = sorted.map((bucket) => {
      const x =
        sorted.length === 1 || span <= 0 || !Number.isFinite(span)
          ? plot.left + plot.width / 2
          : plot.left + ((bucket.weekStart - minWeekStart) / span) * plot.width;
      const y = plot.bottom - (bucket.average / 100) * plot.height;
      return {
        weekStart: bucket.weekStart,
        average: bucket.average,
        count: bucket.count,
        x: round2(x),
        y: round2(y)
      };
    });

    const polyline =
      points.length >= 2 ? points.map((point) => `${point.x},${point.y}`).join(' ') : '';

    return {
      width,
      height,
      plot,
      points,
      polyline,
      gridlines: buildGridlines(plot),
      minWeekStart,
      maxWeekStart,
      empty: false
    };
  } catch (_e) {
    const plot = buildPlot(DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_PADDING);
    return emptySeries(DEFAULT_WIDTH, DEFAULT_HEIGHT, plot);
  }
}
