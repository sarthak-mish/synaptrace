'use strict';

/**
 * Charts — server-side chart rendering via chartjs-node-canvas.
 *
 * Each function returns a PNG Buffer (or null if the native canvas module
 * is unavailable).  The PDF worker catches null values and falls back to
 * text-only tables, so the report is always generated regardless of the
 * canvas build environment.
 *
 * NOTE: chartjs-node-canvas requires the `canvas` native add-on.
 * If it is not compiled for the current platform the functions resolve to
 * null and the PDF is rendered in text-only mode.
 */

// Lazy-load to avoid crashing at require-time in environments without canvas.
let ChartJSNodeCanvas;
try {
  ({ ChartJSNodeCanvas } = require('chartjs-node-canvas'));
} catch {
  ChartJSNodeCanvas = null;
}

const PALETTE = {
  blue:   '#4C9BE8',
  orange: '#F5A623',
  red:    '#E8505B',
  green:  '#27AE60',
  purple: '#9B59B6',
  grey:   '#95A5A6',
};

/**
 * @param {number} w
 * @param {number} h
 * @returns {import('chartjs-node-canvas').ChartJSNodeCanvas | null}
 */
function canvas(w, h) {
  if (!ChartJSNodeCanvas) return null;
  return new ChartJSNodeCanvas({ width: w, height: h, backgroundColour: 'white' });
}

// ─── Individual chart generators ────────────────────────────────────────────

/**
 * Bar chart — P50 / P90 / P99 latency.
 * @param {{ p50: number, p90: number, p99: number }} percentiles
 * @returns {Promise<Buffer|null>}
 */
async function generateLatencyChart(percentiles) {
  const c = canvas(680, 340);
  if (!c) return null;

  return c.renderToBuffer({
    type: 'bar',
    data: {
      labels: ['P50 (Median)', 'P90', 'P99'],
      datasets: [
        {
          label: 'Latency (ms)',
          data: [percentiles.p50, percentiles.p90, percentiles.p99],
          backgroundColor: [PALETTE.blue, PALETTE.orange, PALETTE.red],
          borderColor:     [PALETTE.blue, PALETTE.orange, PALETTE.red],
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: 'Latency Percentiles (ms)',
          font: { size: 15, weight: 'bold' },
          color: '#1a1a2e',
        },
        legend: { display: false },
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Milliseconds (ms)', color: '#555' },
          grid: { color: '#f0f0f0' },
        },
        x: { grid: { display: false } },
      },
    },
  });
}

/**
 * Doughnut chart — HTTP status-code distribution.
 * @param {{ '2xx': number, '3xx': number, '4xx': number, '5xx': number }} groups
 * @returns {Promise<Buffer|null>}
 */
async function generateErrorChart(groups) {
  const c = canvas(420, 340);
  if (!c) return null;

  const entries = Object.entries(groups).filter(([, v]) => v > 0);
  const colorMap = {
    '2xx': PALETTE.green,
    '3xx': PALETTE.blue,
    '4xx': PALETTE.orange,
    '5xx': PALETTE.red,
  };

  return c.renderToBuffer({
    type: 'doughnut',
    data: {
      labels: entries.map(([k]) => k),
      datasets: [
        {
          data: entries.map(([, v]) => v),
          backgroundColor: entries.map(([k]) => colorMap[k] ?? PALETTE.grey),
          borderWidth: 2,
          borderColor: '#ffffff',
          hoverOffset: 6,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: 'Status Code Distribution',
          font: { size: 15, weight: 'bold' },
          color: '#1a1a2e',
        },
        legend: {
          position: 'bottom',
          labels: { font: { size: 12 }, padding: 12 },
        },
      },
    },
  });
}

/**
 * Line chart — requests per minute over time.
 * @param {{ time: string, count: number }[]} traffic
 * @returns {Promise<Buffer|null>}
 */
async function generateTrafficChart(traffic) {
  const c = canvas(680, 340);
  if (!c) return null;

  const labels = traffic.map((t) => {
    const d = new Date(t.time);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });

  return c.renderToBuffer({
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Requests / min',
          data: traffic.map((t) => t.count),
          borderColor: PALETTE.blue,
          backgroundColor: 'rgba(76, 155, 232, 0.12)',
          fill: true,
          tension: 0.35,
          pointRadius: traffic.length > 30 ? 2 : 4,
          pointBackgroundColor: PALETTE.blue,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: 'Traffic Volume Over Time',
          font: { size: 15, weight: 'bold' },
          color: '#1a1a2e',
        },
        legend: { display: false },
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Requests per Minute', color: '#555' },
          grid: { color: '#f0f0f0' },
        },
        x: {
          ticks: {
            maxTicksLimit: 12,
            maxRotation: 45,
          },
          title: { display: true, text: 'Time (HH:MM)', color: '#555' },
        },
      },
    },
  });
}

module.exports = { generateLatencyChart, generateErrorChart, generateTrafficChart };
