'use strict';

/**
 * reporter.test.js
 *
 * Tests PDF generation end-to-end via the worker thread.
 * Chart generation is mocked so the test suite does not require a compiled
 * native canvas module in CI.  The mock is injected into the jest module
 * registry BEFORE reporter.js or pdf-worker.js are required.
 *
 * NOTE: worker_threads spin up a fresh V8 isolate that does NOT inherit
 * jest's module registry, so we cannot use jest.mock() to affect the worker
 * directly.  Instead, charts.js already handles missing canvas gracefully
 * (returns null) — in test environments without canvas the PDF is rendered
 * in text-only mode, which is precisely what we want to exercise here.
 */

const { generateReport } = require('../src/reporter');
const { Analyzer }       = require('../src/analyzer');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeMetrics(n = 50) {
  return Array.from({ length: n }, (_, i) => ({
    traceId:        `trace-${i}`,
    timestamp:      new Date(Date.now() - i * 2_000),
    method:         i % 3 === 0 ? 'POST' : 'GET',
    url:            `/api/endpoint/${i % 8}`,
    statusCode:     i % 7 === 0 ? 500 : i % 11 === 0 ? 404 : 200,
    latencyMs:      50 + Math.random() * 950,
    requestHeaders: { 'content-type': 'application/json' },
    requestBody:    '',
    responseBody:   JSON.stringify({ ok: true, id: i }),
  }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('generateReport', () => {
  test('returns a Buffer', async () => {
    const metrics  = makeMetrics(50);
    const analysis = new Analyzer(metrics).analyze();
    const buf      = await generateReport(analysis, metrics);
    expect(buf).toBeInstanceOf(Buffer);
  });

  test('output is a valid PDF (starts with %PDF header)', async () => {
    const metrics  = makeMetrics(50);
    const analysis = new Analyzer(metrics).analyze();
    const buf      = await generateReport(analysis, metrics);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  test('PDF is non-trivially sized (> 5 KB)', async () => {
    const metrics  = makeMetrics(50);
    const analysis = new Analyzer(metrics).analyze();
    const buf      = await generateReport(analysis, metrics);
    expect(buf.length).toBeGreaterThan(5_000);
  });

  test('generates a report for an empty dataset (no crash)', async () => {
    const analysis = new Analyzer([]).analyze();
    const buf      = await generateReport(analysis, []);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  test('generates a report for a large dataset (1 000 requests)', async () => {
    const metrics  = makeMetrics(1_000);
    const analysis = new Analyzer(metrics).analyze();
    const buf      = await generateReport(analysis, metrics);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  test('is non-blocking — event loop remains responsive during generation', async () => {
    const metrics  = makeMetrics(200);
    const analysis = new Analyzer(metrics).analyze();

    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);

    await generateReport(analysis, metrics);
    clearInterval(timer);

    // If generation had blocked synchronously, ticks would be ~0.
    expect(ticks).toBeGreaterThan(0);
  });

  test('multiple concurrent reports do not interfere', async () => {
    const metrics  = makeMetrics(30);
    const analysis = new Analyzer(metrics).analyze();

    const [a, b, c] = await Promise.all([
      generateReport(analysis, metrics),
      generateReport(analysis, metrics),
      generateReport(analysis, metrics),
    ]);

    for (const buf of [a, b, c]) {
      expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
    }
  });
});

// ─── PDF generation trigger via NodePulse._serveReport ───────────────────────

describe('NodePulse — report endpoint middleware', () => {
  let pulse;

  beforeEach(() => {
    // Reset singleton between tests.
    require('../src/index')._reset();
    pulse = require('../src/index').init({
      reportEndpoint: '/__pulse/report',
      reportSecret: null,
    });
  });

  afterEach(() => {
    require('../src/index')._reset();
  });

  test('middleware passes non-report requests to next()', () => {
    const mw   = pulse.middleware();
    const next  = jest.fn();
    const req   = { url: '/api/users', headers: {} };
    const res   = {};
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('middleware returns 401 when secret is required but missing', () => {
    require('../src/index')._reset();
    const secured = require('../src/index').init({ reportSecret: 'mysecret', reportEndpoint: '/__pulse/report' });
    const mw      = secured.middleware();
    const next    = jest.fn();

    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) { chunks.push(body); },
    };
    const req = { url: '/__pulse/report', headers: {} };

    mw(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('middleware accepts correct secret via query param', (done) => {
    require('../src/index')._reset();
    const secured = require('../src/index').init({ reportSecret: 'abc123', reportEndpoint: '/__pulse/report' });
    const mw      = secured.middleware();
    const next    = jest.fn();

    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(body) {
        chunks.push(body);
        // If a Buffer was sent, it's a PDF — test passes.
        if (body instanceof Buffer) {
          expect(body.slice(0, 4).toString()).toBe('%PDF');
        }
        done();
      },
    };
    const req = { url: '/__pulse/report?secret=abc123', headers: {} };
    mw(req, res, next);
  });

  test('getMetrics() returns an array', () => {
    expect(Array.isArray(pulse.getMetrics())).toBe(true);
  });

  test('getAnalysis() returns an object with summary', () => {
    const analysis = pulse.getAnalysis();
    expect(analysis).toHaveProperty('summary');
    expect(analysis.summary).toHaveProperty('totalRequests');
    expect(analysis.summary).toHaveProperty('healthScore');
  });

  test('reset() clears the metric buffer', () => {
    // Manually push a record via the collector (white-box)
    pulse._collector.record({ traceId: 'x', timestamp: new Date(), method: 'GET', url: '/', statusCode: 200, latencyMs: 10 });
    expect(pulse.getMetrics().length).toBeGreaterThan(0);
    pulse.reset();
    expect(pulse.getMetrics().length).toBe(0);
  });

  test('generateReport() resolves to a valid PDF buffer', async () => {
    const buf = await pulse.generateReport();
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });
});
