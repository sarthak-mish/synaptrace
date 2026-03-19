'use strict';

/**
 * example/server.js — node-pulse integration demo
 *
 * Demonstrates zero-config setup with Express.  After startup the script
 * automatically sends 40 synthetic requests across multiple endpoints
 * (including slow and error-prone ones) so there is interesting telemetry
 * to visualise immediately.
 *
 * Usage:
 *   node example/server.js
 *
 * Then open:
 *   http://localhost:3000/pulse/report   → view live dashboard
 *   http://localhost:3000/pulse/report?format=pdf   → download the PDF report
 *
 * Security demo — protected endpoint:
 *   http://localhost:3000/pulse/report?secret=demo-secret
 */

// ── 1. Initialise node-pulse BEFORE any other require that creates an HTTP
//       server.  The prototype patches must be in place from the very first
//       request. ────────────────────────────────────────────────────────────
const pulse = require('..').init({
  // Redact these field names everywhere (headers, request bodies, response bodies).
  redact: ['x-custom-key', 'ssn'],

  // Keep the last 5 000 requests in the ring buffer.
  maxRequests: 5_000,

  // Serve the report at this path.
  reportEndpoint: '/pulse/report',

  // Uncomment to require authentication:
  // reportSecret: process.env.PULSE_SECRET ?? 'demo-secret',

  // Record every request (set < 1.0 to sample on high-traffic services).
  sampleRate: 1.0,
});

// ── 2. Build the Express app. ─────────────────────────────────────────────────
const express = require('express');
const http    = require('node:http');
const app     = express();

app.use(express.json());

// Mount the pulse middleware as early as possible.
app.use(pulse.middleware());

// ── 3. Application routes. ────────────────────────────────────────────────────

// Simulate realistic, variable-latency endpoint.
app.get('/api/users', (_req, res) => {
  const delay = 20 + Math.random() * 180;
  setTimeout(() => res.json({ users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] }), delay);
});

// POST with a body that contains PII — password will be redacted in the log.
app.post('/api/users', (req, res) => {
  const { name } = req.body ?? {};
  setTimeout(
    () => res.status(201).json({ id: Math.floor(Math.random() * 1_000), name }),
    50 + Math.random() * 100
  );
});

// Products — moderate latency.
app.get('/api/products', (_req, res) => {
  setTimeout(
    () => res.json({ products: [{ id: 10, name: 'Widget' }, { id: 11, name: 'Gadget' }] }),
    100 + Math.random() * 400
  );
});

// Intentionally slow — creates latency spike anomalies.
app.get('/api/slow', (_req, res) => {
  setTimeout(
    () => res.json({ message: 'This endpoint is deliberately slow.' }),
    1_500 + Math.random() * 1_000
  );
});

// Intentional 500 — creates server-error anomalies.
app.get('/api/error', (_req, res) => {
  res.status(500).json({ error: 'Simulated internal server error.' });
});

// Intentional 404.
app.get('/api/not-found', (_req, res) => {
  res.status(404).json({ error: 'Resource not found.' });
});

// Health-check — always fast.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── 4. Traffic simulator ──────────────────────────────────────────────────────

const ENDPOINTS = [
  { method: 'GET',  path: '/api/users',     body: null },
  { method: 'POST', path: '/api/users',     body: { name: 'Charlie', password: 'p@ssw0rd', token: 'tok-xyz' } },
  { method: 'GET',  path: '/api/products',  body: null },
  { method: 'GET',  path: '/api/slow',      body: null },
  { method: 'GET',  path: '/api/error',     body: null },
  { method: 'GET',  path: '/api/not-found', body: null },
  { method: 'GET',  path: '/health',        body: null },
];

async function simulateTraffic(port, count = 40) {
  console.log(`\n  Simulating ${count} requests across ${ENDPOINTS.length} endpoints…`);

  for (let i = 0; i < count; i++) {
    const ep   = ENDPOINTS[i % ENDPOINTS.length];
    const body = ep.body ? JSON.stringify(ep.body) : null;

    await new Promise((resolve) => {
      const options = {
        hostname: '127.0.0.1',
        port,
        path: ep.path,
        method: ep.method,
        headers: {
          'Content-Type': 'application/json',
          // Sensitive header — will be redacted in the telemetry log.
          Authorization: 'Bearer super-secret-jwt-token',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      };

      const req = http.request(options, (res) => {
        res.resume(); // drain the response
        res.on('end', resolve);
      });
      req.on('error', resolve); // don't abort the loop on connection errors
      if (body) req.write(body);
      req.end();
    });

    // Stagger requests to produce time-series variation in the traffic chart.
    await new Promise((r) => setTimeout(r, 60));

    if ((i + 1) % 10 === 0) {
      process.stdout.write(`  … ${i + 1}/${count} requests sent\n`);
    }
  }
}

// ── 5. Start server ───────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;

const server = app.listen(PORT, async () => {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  node-pulse  |  Integration Demo');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n  Server:  http://localhost:${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}/pulse/report`);
  console.log(`  PDF Report:  http://localhost:${PORT}/pulse/report?format=pdf`);

  await simulateTraffic(PORT, 40);

  const analysis = pulse.getAnalysis();
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Live telemetry snapshot');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Requests captured : ${analysis.summary.totalRequests}`);
  console.log(`  Health score      : ${analysis.summary.healthScore} / 100`);
  console.log(`  Avg latency       : ${analysis.summary.avgLatencyMs} ms`);
  console.log(`  Error rate        : ${analysis.summary.errorRate} %`);
  console.log(`  P50 / P90 / P99   : ${analysis.latencyPercentiles.p50} / ${analysis.latencyPercentiles.p90} / ${analysis.latencyPercentiles.p99} ms`);
  console.log(`  Anomalies         : ${analysis.anomalies.length}`);
  console.log('\n  View the live dashboard:');
  console.log(`  → http://localhost:${PORT}/pulse/report`);
  console.log('\n  Download the PDF report:');
  console.log(`  → http://localhost:${PORT}/pulse/report?format=pdf\n`);
  console.log('  Press Ctrl+C to stop.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
});

server.on('error', (err) => {
  console.error('[demo] Server error:', err.message);
  process.exit(1);
});
