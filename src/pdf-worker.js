'use strict';

/**
 * pdf-worker.js — runs inside a worker_thread.
 *
 * Receives analysis + metrics via workerData, renders a 3-page PDFKit
 * document (optionally embedding chartjs-node-canvas charts), and posts
 * the resulting Buffer back to the main thread.
 *
 * Isolation in a worker thread means:
 *  - PDFKit's synchronous stream construction never blocks the event loop.
 *  - Chart rendering (canvas) runs in a separate V8 isolate.
 *  - If the worker crashes, the host application is completely unaffected.
 */

const { parentPort, workerData } = require('node:worker_threads');
const PDFDocument = require('pdfkit');
const {
  generateLatencyChart,
  generateErrorChart,
  generateTrafficChart,
} = require('./charts');

// ─── Colour palette ──────────────────────────────────────────────────────────
const C = {
  navy:      '#1a1a2e',
  white:     '#ffffff',
  offwhite:  '#f8f9fa',
  border:    '#e0e0e0',
  text:      '#2c2c2c',
  muted:     '#666666',
  green:     '#27ae60',
  amber:     '#f39c12',
  red:       '#e74c3c',
  blue:      '#4C9BE8',
  rowAlt:    '#f2f6fb',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function scoreColor(score) {
  if (score >= 80) return C.green;
  if (score >= 60) return C.amber;
  return C.red;
}

function scoreLabel(score) {
  if (score >= 80) return 'HEALTHY';
  if (score >= 60) return 'DEGRADED';
  return 'CRITICAL';
}

/**
 * Draw a horizontal rule.
 * @param {PDFDocument} doc
 * @param {number} y
 */
function hRule(doc, y) {
  doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(C.border).lineWidth(0.5).stroke();
}

/**
 * Render footer with page number.
 * @param {PDFDocument} doc
 * @param {number} page
 */
function footer(doc, page) {
  const y = doc.page.height - 38;
  hRule(doc, y);
  doc
    .fillColor(C.muted)
    .fontSize(8)
    .font('Helvetica')
    .text('node-pulse  |  API Performance Intelligence', 50, y + 8, { lineBreak: false })
    .text(`Page ${page}`, 50, y + 8, { align: 'right', width: doc.page.width - 100 });
}

// ─── Page 1 — Executive Summary ──────────────────────────────────────────────

function renderPage1(doc, analysis) {
  const { summary, latencyPercentiles, statusGroups } = analysis;

  // ── Header banner ──
  doc.rect(0, 0, doc.page.width, 110).fill(C.navy);

  doc
    .fillColor(C.white)
    .fontSize(30)
    .font('Helvetica-Bold')
    .text('node-pulse', 50, 28, { lineBreak: false });

  doc
    .fontSize(11)
    .font('Helvetica')
    .text('API Performance Intelligence Report', 50, 68)
    .text(`Generated: ${new Date().toUTCString()}`, 50, 83);

  // ── Section title ──
  doc.y = 130;
  doc.fillColor(C.navy).fontSize(18).font('Helvetica-Bold').text('Executive Summary', 50);
  hRule(doc, doc.y + 4);
  doc.y += 14;

  // ── Health-score badge ──
  const sc = scoreColor(summary.healthScore);
  const badgeX = 50;
  const badgeY = doc.y;
  doc.rect(badgeX, badgeY, 180, 88).fill(sc);

  doc
    .fillColor(C.white)
    .fontSize(10)
    .font('Helvetica-Bold')
    .text('OVERALL HEALTH', badgeX, badgeY + 12, { width: 180, align: 'center' });

  doc
    .fontSize(44)
    .font('Helvetica-Bold')
    .text(String(summary.healthScore), badgeX, badgeY + 26, { width: 180, align: 'center' });

  doc
    .fontSize(11)
    .font('Helvetica')
    .text(`/ 100  —  ${scoreLabel(summary.healthScore)}`, badgeX, badgeY + 73, {
      width: 180,
      align: 'center',
    });

  // ── KPI grid (3 × 2) ──
  const kpis = [
    { label: 'Total Requests',  value: summary.totalRequests.toLocaleString() },
    { label: 'Avg Latency',     value: `${summary.avgLatencyMs} ms` },
    { label: 'Error Rate',      value: `${summary.errorRate} %` },
    { label: 'P50 Latency',     value: `${latencyPercentiles.p50} ms` },
    { label: 'P90 Latency',     value: `${latencyPercentiles.p90} ms` },
    { label: 'P99 Latency',     value: `${latencyPercentiles.p99} ms` },
  ];

  const gridX = 250;
  const gridY = badgeY;
  const cellW = 100;
  const cellH = 44;
  const cols  = 3;

  kpis.forEach((kpi, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx  = gridX + col * (cellW + 6);
    const cy  = gridY + row * (cellH + 6);

    doc.rect(cx, cy, cellW, cellH).fillAndStroke(C.offwhite, C.border);

    doc
      .fillColor(C.muted)
      .fontSize(8)
      .font('Helvetica')
      .text(kpi.label, cx + 6, cy + 7, { width: cellW - 12 });

    doc
      .fillColor(C.navy)
      .fontSize(15)
      .font('Helvetica-Bold')
      .text(kpi.value, cx + 6, cy + 22, { width: cellW - 12 });
  });

  // ── Time range ──
  doc.y = badgeY + 100;
  if (summary.timeRange.start) {
    doc
      .fillColor(C.muted)
      .fontSize(9)
      .font('Helvetica')
      .text(
        `Data window: ${new Date(summary.timeRange.start).toLocaleString()}  →  ${new Date(summary.timeRange.end).toLocaleString()}`,
        50
      );
  }

  // ── Status-code breakdown ──
  doc.moveDown(1.2);
  doc.fillColor(C.navy).fontSize(14).font('Helvetica-Bold').text('Status Code Breakdown', 50);
  hRule(doc, doc.y + 4);
  doc.y += 10;

  const statusColors = { '2xx': C.green, '3xx': C.blue, '4xx': C.amber, '5xx': C.red };
  const totalReqs = Object.values(statusGroups).reduce((a, b) => a + b, 0) || 1;
  const barMaxW = 280;

  for (const [code, count] of Object.entries(statusGroups)) {
    const pct = ((count / totalReqs) * 100).toFixed(1);
    const barW = Math.max(2, (count / totalReqs) * barMaxW);
    const rowY = doc.y;

    doc.rect(50, rowY, barW, 16).fill(statusColors[code] ?? C.muted);
    doc
      .fillColor(C.text)
      .fontSize(9)
      .font('Helvetica')
      .text(`${code}   ${count.toLocaleString()} requests  (${pct} %)`, 50 + barMaxW + 10, rowY + 2);

    doc.y += 22;
  }

  footer(doc, 1);
}

// ─── Page 2 — Visualizations ─────────────────────────────────────────────────

function renderPage2(doc, analysis, charts) {
  doc.fillColor(C.navy).fontSize(20).font('Helvetica-Bold').text('Performance Visualizations', 50, 50);
  hRule(doc, doc.y + 6);

  let y = doc.y + 18;

  // Latency chart — full width
  doc.fillColor(C.text).fontSize(12).font('Helvetica-Bold').text('Latency Percentiles', 50, y);
  y += 18;

  if (charts.latencyChart) {
    doc.image(charts.latencyChart, 50, y, { width: 490, height: 230 });
    y += 240;
  } else {
    const { p50, p90, p99 } = analysis.latencyPercentiles;
    doc
      .fillColor(C.muted)
      .fontSize(10)
      .font('Helvetica')
      .text(`P50: ${p50} ms   P90: ${p90} ms   P99: ${p99} ms`, 50, y);
    y += 24;
  }

  y += 12;

  // Error + Traffic — side by side
  const leftX  = 50;
  const rightX = 310;
  const chartH = 220;

  doc.fillColor(C.text).fontSize(12).font('Helvetica-Bold').text('Status Distribution', leftX, y);

  if (charts.errorChart) {
    doc.image(charts.errorChart, leftX, y + 18, { width: 240, height: chartH });
  } else {
    const entries = Object.entries(analysis.statusGroups).filter(([, v]) => v > 0);
    let ty = y + 18;
    for (const [k, v] of entries) {
      doc.fillColor(C.muted).fontSize(9).font('Helvetica').text(`${k}: ${v}`, leftX, ty);
      ty += 14;
    }
  }

  doc.fillColor(C.text).fontSize(12).font('Helvetica-Bold').text('Traffic Volume', rightX, y);

  if (charts.trafficChart) {
    doc.image(charts.trafficChart, rightX, y + 18, { width: 240, height: chartH });
  } else {
    const traffic = analysis.traffic.slice(-10);
    let ty = y + 18;
    for (const t of traffic) {
      doc
        .fillColor(C.muted)
        .fontSize(9)
        .font('Helvetica')
        .text(`${t.time}: ${t.count} req`, rightX, ty);
      ty += 14;
    }
  }

  footer(doc, 2);
}

// ─── Page 3 — Detailed Breakdown ─────────────────────────────────────────────

function renderPage3(doc, analysis) {
  const { slowest, anomalies } = analysis;

  doc.fillColor(C.navy).fontSize(20).font('Helvetica-Bold').text('Detailed Analysis', 50, 50);
  hRule(doc, doc.y + 6);

  // ── Slowest 10 % table ──
  doc.y += 16;
  doc.fillColor(C.navy).fontSize(14).font('Helvetica-Bold').text('Slowest 10% of Requests', 50);
  doc.y += 8;

  const cols = [
    { header: 'Timestamp',  w: 90  },
    { header: 'Method',     w: 45  },
    { header: 'URL',        w: 195 },
    { header: 'Status',     w: 45  },
    { header: 'Latency',    w: 68  },
  ];
  const tableW = cols.reduce((s, c) => s + c.w, 0);
  const rowH   = 17;

  // Header row
  const headerY = doc.y;
  doc.rect(50, headerY, tableW, rowH).fill(C.navy);
  let cx = 50;
  for (const col of cols) {
    doc
      .fillColor(C.white)
      .fontSize(8)
      .font('Helvetica-Bold')
      .text(col.header, cx + 4, headerY + 4, { width: col.w - 8, lineBreak: false });
    cx += col.w;
  }
  doc.y = headerY + rowH;

  // Data rows (cap to page height to avoid autoscaled extra pages)
  const remainingHeightBeforeAnomaly = doc.page.height - doc.y - 220;
  const maxRows = Math.max(0, Math.floor(remainingHeightBeforeAnomaly / rowH));
  const rowsToShow = slowest.slice(0, Math.min(20, maxRows));

  rowsToShow.forEach((row, i) => {
    const ry  = doc.y;
    const bg  = i % 2 === 0 ? C.offwhite : C.white;
    doc.rect(50, ry, tableW, rowH).fill(bg);

    const cells = [
      new Date(row.timestamp).toLocaleTimeString(),
      row.method ?? '',
      (row.url ?? '').slice(0, 38),
      String(row.statusCode ?? ''),
      `${(row.latencyMs ?? 0).toFixed(1)} ms`,
    ];

    cx = 50;
    cells.forEach((cell, ci) => {
      const color = ci === 3 && Number(row.statusCode) >= 500 ? C.red : C.text;
      doc
        .fillColor(color)
        .fontSize(7.5)
        .font('Helvetica')
        .text(cell, cx + 4, ry + 4, { width: cols[ci].w - 8, lineBreak: false });
      cx += cols[ci].w;
    });

    doc.y = ry + rowH;
  });

  if (rowsToShow.length === 0) {
    doc.fillColor(C.muted).fontSize(9).font('Helvetica').text('No data available.', 50);
  } else if (rowsToShow.length < Math.min(20, slowest.length)) {
    doc
      .fillColor(C.muted)
      .fontSize(8)
      .font('Helvetica')
      .text(`… and ${slowest.length - rowsToShow.length} more requests not shown.`, 50, doc.y + 8);
    doc.y += 16;
  }

  // ── Anomaly log ──
  doc.y += 18;
  if (doc.y > doc.page.height - 150) doc.addPage();

  doc.fillColor(C.navy).fontSize(14).font('Helvetica-Bold').text('Anomaly Log', 50);
  hRule(doc, doc.y + 4);
  doc.y += 10;

  const availableHeight = doc.page.height - doc.y - 70;
  const anomalyHeight = 34;
  const maxAnomalies = Math.max(0, Math.floor(availableHeight / anomalyHeight));
  const anomaliesToShow = anomalies.slice(0, maxAnomalies);

  if (anomalies.length === 0) {
    doc.rect(50, doc.y, tableW, 36).fill('#d5f4e6');
    doc
      .fillColor(C.green)
      .fontSize(11)
      .font('Helvetica-Bold')
      .text('No anomalies detected — system is operating within normal parameters.', 58, doc.y - 28, {
        width: tableW - 16,
      });
    doc.y += 12;
  } else if (anomaliesToShow.length === 0) {
    doc
      .fillColor(C.muted)
      .fontSize(9)
      .font('Helvetica')
      .text('Anomaly log truncated due to page constraints.', 50);
  } else {
    anomaliesToShow.forEach((a, i) => {
      const ay  = doc.y;
      const bg  = a.statusCode >= 500 ? '#fdecea' : '#fff8e1';
      doc.rect(50, ay, tableW, 30).fill(bg);

      const accent = a.statusCode >= 500 ? C.red : C.amber;
      doc
        .fillColor(accent)
        .fontSize(8.5)
        .font('Helvetica-Bold')
        .text(
          `[${new Date(a.timestamp).toLocaleTimeString()}]  ${a.method ?? ''}  ${a.url ?? ''}`,
          58,
          ay + 5,
          { width: tableW - 16, lineBreak: false }
        );

      doc
        .fillColor(C.muted)
        .fontSize(8)
        .font('Helvetica')
        .text(a.reason, 58, ay + 17, { width: tableW - 16, lineBreak: false });

      doc.y = ay + 34;
    });

    const remaining = anomalies.length - anomaliesToShow.length;
    if (remaining > 0) {
      doc
        .fillColor(C.muted)
        .fontSize(8)
        .font('Helvetica')
        .text(`… and ${remaining} more anomalies not shown.`, 50);
    }
  }

  footer(doc, 3);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const { analysis } = workerData;

  // Attempt chart generation; degrade gracefully if canvas is absent.
  let charts = {};
  try {
    const [latencyChart, errorChart, trafficChart] = await Promise.all([
      generateLatencyChart(analysis.latencyPercentiles),
      generateErrorChart(analysis.statusGroups),
      generateTrafficChart(analysis.traffic),
    ]);
    charts = { latencyChart, errorChart, trafficChart };
  } catch (err) {
    // Text-only fallback — PDF is still generated.
    process.stderr.write(`[node-pulse] Chart generation skipped: ${err.message}\n`);
  }

  // Build PDF
  const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: true });
  const chunks = [];

  doc.on('data', (c) => chunks.push(c));

  await new Promise((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);

    try {
      renderPage1(doc, analysis);
      doc.addPage();
      renderPage2(doc, analysis, charts);
      doc.addPage();
      renderPage3(doc, analysis);
    } catch (err) {
      reject(err);
      return;
    }

    doc.end();
  });

  const buf = Buffer.concat(chunks);
  // Transfer the underlying ArrayBuffer to avoid a copy across the thread boundary.
  parentPort.postMessage(buf.buffer, [buf.buffer]);
}

run().catch((err) => {
  process.stderr.write(`[node-pulse] pdf-worker fatal: ${err.stack}\n`);
  process.exit(1);
});
