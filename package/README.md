# synaptrace

**Zero-config API performance intelligence for Node.js.**

synaptrace intercepts every HTTP request your server handles — without touching a single route — captures high-resolution telemetry, and produces a professional multi-page PDF report covering latency percentiles, traffic volume, error distribution, anomalies, and an overall health score.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration reference](#configuration-reference)
- [Downloading the PDF report](#downloading-the-pdf-report)
- [Programmatic API](#programmatic-api)
- [Report structure](#report-structure)
- [Security — PII redaction](#security--pii-redaction)
- [How it works](#how-it-works)
- [Testing](#testing)
- [Running the demo](#running-the-demo)
- [FAQ](#faq)

---

## Features

| Capability | Detail |
|---|---|
| **Zero-config interception** | Monkey-patches `http`/`https` prototypes — no route wrappers needed |
| **Async context propagation** | `AsyncLocalStorage` tracks trace state through the full async lifecycle |
| **Non-blocking telemetry** | Recording and PDF generation run via `setImmediate` / worker threads |
| **PII redaction** | Configurable + built-in scrubbing of passwords, tokens, cookies, etc. |
| **Ring-buffer collector** | Bounded memory usage regardless of traffic volume |
| **Latency percentiles** | P50 / P90 / P99 computed with nearest-rank method |
| **Health score** | Composite 0–100 score factoring error rate, 5xx severity, and P99 |
| **Anomaly detection** | Flags latency spikes (> 2× P99) and all 5xx responses |
| **PDF report** | 3-page professional report generated in a worker thread |
| **Charts** | Latency bars, status doughnut, traffic line chart (via chartjs-node-canvas) |
| **Fail-safe** | Telemetry errors are swallowed — the host app is never interrupted |

---

## Requirements

- **Node.js ≥ 20** (uses `AsyncLocalStorage`, `crypto.randomUUID()`, worker threads)
- **For charts** — the `canvas` native add-on must be compiled.  If it is unavailable the PDF is generated in text-only mode automatically.

```
node -e "require('canvas')" 2>/dev/null && echo "canvas OK" || echo "canvas not available — text-only PDF mode"
```

---

## Installation

```bash
npm install synaptrace
```

Chart support (optional but recommended):

```bash
# canvas requires build tools: Xcode CLI on macOS, build-essential on Linux
npm install canvas
```

---

## Quick start

**The `init()` call must come before any `require` that creates an HTTP server.**

```js
// app.js  ← entry point

// 1. Initialise pulse FIRST
const pulse = require('synaptrace').init({
  redact:         ['x-api-key'],   // extra keys to redact (password/cookie/token always redacted)
  maxRequests:    10_000,          // ring-buffer capacity
  reportEndpoint: '/__pulse/report',
  reportSecret:   process.env.PULSE_SECRET ?? null,  // null = no auth
  sampleRate:     1.0,             // record every request
});

// 2. Then build your app normally
const express = require('express');
const app = express();

// 3. Mount the report middleware (serves the PDF download endpoint)
app.use(pulse.middleware());

// 4. Your routes — no changes needed
app.get('/api/users', (req, res) => res.json({ users: [] }));

app.listen(3000, () => console.log('Server running'));
```

That's it. Every request is now captured automatically.

---

## Configuration reference

```js
require('synaptrace').init({
  /**
   * Additional header/body keys to scrub on top of the built-in list.
   * Built-in list: password, authorization, cookie, token, secret, api_key,
   *                x-api-key, ssn, credit_card, cvv, and more.
   * @default []
   */
  redact: ['x-custom-secret', 'myAppToken'],

  /**
   * Maximum request records in the ring buffer.
   * Older records are evicted when the limit is reached.
   * @default 10_000
   */
  maxRequests: 10_000,

  /**
   * URL path that serves the PDF report.
   * @default '/__pulse/report'
   */
  reportEndpoint: '/__pulse/report',

  /**
   * Shared secret for report access.
   * Callers must supply it via the `X-Pulse-Secret` header or `?secret=` param.
   * Set to null to disable authentication.
   * @default null
   */
  reportSecret: process.env.PULSE_SECRET,

  /**
   * Fraction of requests to record (0.0–1.0).
   * Useful for reducing overhead on extremely high-traffic services.
   * @default 1.0
   */
  sampleRate: 1.0,
});
```

---

## Downloading the PDF report

Once the server is running and has received some traffic, open the report URL in any browser:

```
http://localhost:3000/pulse/report
```

The browser will prompt you to save `pulse-report-<timestamp>.pdf`.

**With authentication:**

```
# Via query parameter
http://localhost:3000/pulse/report?secret=your-secret

# Via header (curl)
curl -H "X-Pulse-Secret: your-secret" http://localhost:3000/pulse/report -o report.pdf
```

---

## Programmatic API

```js
const pulse = require('synaptrace').init({ /* options */ });

// Raw telemetry records (redacted, bounded by maxRequests)
const metrics = pulse.getMetrics();   // object[]

// Computed analysis (percentiles, health score, anomalies, …)
const analysis = pulse.getAnalysis(); // object

// Generate a PDF buffer without an HTTP request
const pdfBuffer = await pulse.generateReport(); // Buffer
require('fs').writeFileSync('report.pdf', pdfBuffer);

// Clear the ring buffer (e.g. at the start of a test suite)
pulse.reset();
```

`init()` is idempotent — repeated calls return the same singleton instance.

---

## Report structure

### Page 1 — Executive Summary

- **Health Score** badge (0–100, colour-coded green / amber / red)
- KPI grid: Total Requests, Avg Latency, Error Rate, P50 / P90 / P99
- Data window timestamps
- Status-code breakdown with proportional bars (2xx / 3xx / 4xx / 5xx)

### Page 2 — Performance Visualizations

- **Latency Percentiles** bar chart (P50 / P90 / P99)
- **Status Distribution** doughnut chart
- **Traffic Volume** line chart (requests per minute over time)

### Page 3 — Detailed Analysis

- **Slowest 10 % table** — timestamp, method, URL, status, latency
- **Anomaly Log** — latency spikes (> 2× P99) and all 5xx events with reasons

---

## Security — PII redaction

Redaction runs automatically on every captured request/response before the
data is stored.  It applies to:

- **Request headers** (e.g. `Authorization`, `Cookie`)
- **Request bodies** (JSON and URL-encoded form formats)
- **Response bodies**

Built-in redacted keys (case-insensitive):

```
password  passwd  pwd  authorization  auth  cookie  set-cookie
token  access_token  refresh_token  id_token  secret  client_secret
api_key  apikey  x-api-key  x-auth-token  ssn  credit_card  cvv  cc_number
```

Add your own via `init({ redact: ['myField', 'anotherKey'] })`.

Redacted values appear as `[REDACTED]` in all logs and the PDF.

---

## How it works

```
HTTP request arrives
       │
       ▼
http.Server.prototype.emit  (patched)
  ├─ crypto.randomUUID()    → traceId
  ├─ process.hrtime.bigint() → startTime
  ├─ req.on('data', …)      → accumulate request body
  └─ als.run(store, …)      → propagate context via AsyncLocalStorage
                                           │
                               downstream async handlers run
                                           │
http.ServerResponse.prototype.write/end  (patched)
  ├─ accumulate response chunks          via als.getStore()
  └─ setImmediate(() => {
       compute latency = hrtime.bigint() - startTime  (nanosecond precision)
       redact(headers + bodies)
       collector.record(metric)           // O(1) ring buffer write
     })
                                           │
GET /__pulse/report
  └─ Analyzer.analyze()
       ├─ percentiles, health score, anomalies
       └─ new Worker('pdf-worker.js')      // isolated V8 thread
            ├─ generateLatencyChart()      // chartjs-node-canvas
            ├─ generateErrorChart()
            ├─ generateTrafficChart()
            └─ PDFDocument → Buffer → postMessage → res.end()
```

---

## Testing

```bash
# Install dependencies
npm install

# Run the test suite
npm test

# With coverage
npm run test:coverage
```

The test suite covers:

| Suite | What it tests |
|---|---|
| `redactor.test.js` | Object redaction, string redaction (JSON + URL-encoded), case-insensitivity, nested structures, edge cases |
| `analyzer.test.js` | Percentile accuracy, health score model, anomaly detection, status grouping, traffic bucketing, empty dataset |
| `reporter.test.js` | PDF `%PDF` signature, buffer size, empty-dataset resilience, concurrent generation, event-loop non-blocking, middleware auth |

---

## Running the demo

```bash
npm install
node example/server.js
```

The script:
1. Starts an Express server on port 3000
2. Automatically sends 40 synthetic requests across multiple endpoints
3. Prints a live telemetry snapshot to the console
4. Leaves the server running so you can download the report

```
http://localhost:3000/__pulse/report
```

---

## FAQ

**Does it work with Fastify / raw `http.createServer` / other frameworks?**
Yes. The patches apply to the Node.js `http` prototype, so any framework that builds on it is automatically covered.

**What happens if canvas isn't installed?**
Charts are skipped; the PDF is generated in text-only mode with metrics displayed as plain values. All three pages are still produced.

**Is it production-safe?**
The interceptor is fail-safe — any error in telemetry processing is caught and emitted as `pulse:error` on the process, never re-thrown into the host application.  The ring buffer has a configurable hard cap to prevent unbounded memory growth.

**Can I disable sampling to reduce overhead?**
Set `sampleRate` to a value between 0 and 1 (e.g. `0.1` records 10 % of traffic).

**Can I run multiple instances?**
`init()` is a singleton — the same instance is returned on every call.  For multiple isolated instances, import `NodePulse` directly: `const { NodePulse } = require('synaptrace')`.

---

## Licence

MIT
