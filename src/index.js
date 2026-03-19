'use strict';

/**
 * node-pulse — public API surface.
 *
 * Singleton usage:
 *
 *   const pulse = require('node-pulse').init({ ...options });
 *   app.use(pulse.middleware());
 *
 * The module MUST be initialised before any HTTP server starts listening so
 * that the prototype patches are in place when the first request arrives.
 */

const { Interceptor } = require('./interceptor');
const { Collector }   = require('./collector');
const { Analyzer }    = require('./analyzer');
const { generateReport } = require('./reporter');

/** Module-level singleton. */
let _instance = null;

// ─── Default options ─────────────────────────────────────────────────────────

const DEFAULTS = {
  /**
   * Additional header / body keys to redact on top of the built-in list.
   * @type {string[]}
   */
  redact: [],

  /**
   * Maximum number of request records kept in the ring buffer.
   * Older records are silently evicted when the limit is reached.
   * @type {number}
   */
  maxRequests: 10_000,

  /**
   * URL path at which the PDF report is served.
   * @type {string}
   */
  reportEndpoint: '/__pulse/report',

  /**
   * Optional shared secret.  When set, requests to the report endpoint must
   * supply a matching value in the `X-Pulse-Secret` header or `?secret=`
   * query-parameter.  Set to `null` to disable auth.
   * @type {string|null}
   */
  reportSecret: null,

  /**
   * Fraction of requests to record (0–1).
   * Useful for reducing overhead on extremely high-traffic services.
   * @type {number}
   */
  sampleRate: 1.0,
};

// ─── NodePulse class ─────────────────────────────────────────────────────────

class NodePulse {
  /** @param {Partial<typeof DEFAULTS>} options */
  constructor(options = {}) {
    this.options    = { ...DEFAULTS, ...options };
    this._collector = new Collector(this.options.maxRequests);
    this._interceptor = new Interceptor(this._collector, this.options);
    this._interceptor.enable();
  }

  // ─── Express / Connect middleware ─────────────────────────────────────────

  /**
   * Returns an Express-compatible middleware function that serves the PDF
   * report at `options.reportEndpoint`.
   *
   * Mount it as early as possible so the route is never accidentally
   * intercepted by other middleware:
   *
   *   app.use(pulse.middleware());
   *
   * @returns {function(req, res, next): void}
   */
  middleware() {
    return (req, res, next) => {
      const { reportEndpoint, reportSecret } = this.options;

      // Only handle the exact report path (ignore query-string for matching).
      const pathname = req.url.split('?')[0];
      if (pathname !== reportEndpoint) return next();

      // Optional shared-secret auth.
      if (reportSecret) {
        const fromHeader = req.headers['x-pulse-secret'];
        const fromQuery  = new URL(req.url, 'http://localhost').searchParams.get('secret');
        if (fromHeader !== reportSecret && fromQuery !== reportSecret) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Unauthorized — provide X-Pulse-Secret header or ?secret= param.' }));
          return;
        }
      }

      // Check for format query parameter
      const url = new URL(req.url, 'http://localhost');
      const format = url.searchParams.get('format');

      this._serveReport(res, format).catch((err) => {
        // FAIL-SAFE: report errors must never take down the host app.
        console.error('[node-pulse] Report generation error:', err.message);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Report generation failed.', detail: err.message }));
        }
      });
    };
  }

  // ─── Programmatic API ─────────────────────────────────────────────────────

  /**
   * Return all raw telemetry records currently in the buffer.
   * @returns {object[]}
   */
  getMetrics() {
    return this._collector.getAll();
  }

  /**
   * Run the Analyzer over the current buffer and return the analysis object.
   * @returns {object}
   */
  getAnalysis() {
    return new Analyzer(this._collector.getAll()).analyze();
  }

  /**
   * Generate a PDF Buffer programmatically (e.g. for scheduled exports).
   * @returns {Promise<Buffer>}
   */
  async generateReport() {
    const metrics  = this._collector.getAll();
    const analysis = new Analyzer(metrics).analyze();
    return generateReport(analysis, metrics);
  }

  /**
   * Clear all telemetry records from the ring buffer.
   */
  reset() {
    this._collector.clear();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  _generateDashboardHTML(analysis, metrics) {
    const { summary, latencyPercentiles, anomalies } = analysis;

    // Recent requests (last 10)
    const recentMetrics = metrics.slice(-10).reverse();

    const escapeHtml = (str) =>
      String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const truncate = (str, max = 2000) => {
      const s = String(str ?? '');
      return s.length <= max ? s : `${s.slice(0, max)}…`;
    };

    const requestRows = recentMetrics
      .map((m, idx) => {
        const headers = escapeHtml(JSON.stringify(m.requestHeaders ?? {}, null, 2));
        const reqBody = escapeHtml(truncate(m.requestBody, 2000));
        const resBody = escapeHtml(truncate(m.responseBody, 2000));

        const latency = typeof m.latencyMs === 'number' ? `${m.latencyMs.toFixed(2)} ms` : '—';
        const status = m.statusCode != null ? m.statusCode : '—';

        return `
          <tr class="request-row" data-idx="${idx}">
            <td>${new Date(m.timestamp).toLocaleTimeString()}</td>
            <td><code>${escapeHtml(m.method)}</code></td>
            <td>${escapeHtml(m.url)}</td>
            <td class="status-${Math.floor((status === '—' ? 0 : status) / 100)}xx">${escapeHtml(status)}</td>
            <td>${escapeHtml(latency)}</td>
          </tr>
          <tr class="request-details" data-idx="${idx}">
            <td colspan="5">
              <div class="details">
                <div><strong>Trace ID:</strong> ${escapeHtml(m.traceId)}</div>
                <div><strong>Request headers:</strong><pre>${headers}</pre></div>
                <div><strong>Request body:</strong><pre>${reqBody}</pre></div>
                <div><strong>Response body:</strong><pre>${resBody}</pre></div>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Node Pulse - API Performance Dashboard</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            min-height: 100vh;
            background: radial-gradient(circle at top left, #4d8cff 0%, #191b2f 65%);
            color: #1b2a47;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: rgba(255, 255, 255, 0.95);
            border-radius: 14px;
            box-shadow: 0 16px 40px rgba(0, 0, 0, 0.22);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%);
            color: white;
            padding: 34px 30px 28px;
            border-radius: 14px 14px 0 0;
        }
        .header h1 {
            margin: 0;
            font-size: 2.6em;
        }
        .header p {
            margin: 10px 0 0 0;
            opacity: 0.85;
        }
        .download-btn {
            background: linear-gradient(135deg, #22c55e 0%, #0d9488 100%);
            color: white;
            padding: 12px 26px;
            border: none;
            border-radius: 999px;
            font-size: 16px;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
            margin-top: 20px;
            box-shadow: 0 10px 20px rgba(17, 24, 39, 0.18);
            transition: transform 120ms ease, box-shadow 120ms ease;
        }
        .download-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 14px 22px rgba(17, 24, 39, 0.2);
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            padding: 30px;
        }
        .stat-card {
            background: rgba(255, 255, 255, 0.9);
            border: 1px solid rgba(99, 102, 241, 0.3);
            border-radius: 12px;
            padding: 22px;
            text-align: center;
            box-shadow: 0 12px 18px rgba(15, 23, 42, 0.06);
        }
        .stat-card h3 {
            margin: 0 0 10px 0;
            color: #4b5563;
            font-size: 0.9em;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .stat-card .value {
            font-size: 2.5em;
            font-weight: bold;
            color: #0f172a;
            margin: 0;
        }
        .stat-card .unit {
            font-size: 0.8em;
            color: #6b7280;
        }
        .recent-requests {
            padding: 30px;
            border-top: 1px solid rgba(99, 102, 241, 0.3);
        }
        .recent-requests h2 {
            margin-top: 0;
            color: #0f172a;
        }
        .requests-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
            table-layout: fixed;
        }
        .requests-table th,
        .requests-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid rgba(148, 163, 184, 0.35);
            word-break: break-word;
        }
        .requests-table th {
            background: rgba(99, 102, 241, 0.12);
            font-weight: 600;
            color: #1f2d3d;
        }
        .request-row {
            cursor: pointer;
        }
        .request-details {
            display: none;
            background: rgba(255, 255, 255, 0.9);
        }
        .details {
            padding: 15px;
            border: 1px solid rgba(59, 130, 246, 0.35);
            border-radius: 10px;
            background: rgba(59, 130, 246, 0.06);
            display: grid;
            gap: 12px;
        }
        .details pre {
            background: rgba(15, 23, 42, 0.05);
            padding: 10px;
            overflow-x: auto;
            border-radius: 6px;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .status-2xx {
            color: #16a34a;
        }
        .status-4xx {
            color: #ea580c;
        }
        .status-5xx {
            color: #dc2626;
        }
        .anomalies {
            padding: 30px;
            border-top: 1px solid rgba(99, 102, 241, 0.3);
        }
        .anomalies h2 {
            margin-top: 0;
            color: #0f172a;
        }
        .anomaly-item {
            background: rgba(254, 243, 199, 0.8);
            border: 1px solid rgba(251, 191, 36, 0.6);
            border-radius: 8px;
            padding: 15px;
            margin: 10px 0;
        }
        .anomaly-item .type {
            font-weight: bold;
            color: #92400e;
        }
        .anomaly-item .description {
            margin: 5px 0 0 0;
            color: #92400e;
        }
        .footer {
            text-align: center;
            padding: 20px;
            color: #475569;
            border-top: 1px solid rgba(148, 163, 184, 0.35);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 Node Pulse</h1>
            <p>Real-time API Performance Intelligence</p>
            <a href="?format=pdf" class="download-btn">📄 Download PDF Report</a>
        </div>

        <div class="stats-grid">
            <div class="stat-card">
                <h3>Total Requests</h3>
                <div class="value">${summary.totalRequests}</div>
            </div>
            <div class="stat-card">
                <h3>Avg Latency</h3>
                <div class="value">${summary.avgLatencyMs}</div>
                <div class="unit">ms</div>
            </div>
            <div class="stat-card">
                <h3>Error Rate</h3>
                <div class="value">${summary.errorRate}</div>
                <div class="unit">%</div>
            </div>
            <div class="stat-card">
                <h3>Health Score</h3>
                <div class="value">${summary.healthScore}</div>
                <div class="unit">/100</div>
            </div>
            <div class="stat-card">
                <h3>P50 Latency</h3>
                <div class="value">${latencyPercentiles.p50}</div>
                <div class="unit">ms</div>
            </div>
            <div class="stat-card">
                <h3>P90 Latency</h3>
                <div class="value">${latencyPercentiles.p90}</div>
                <div class="unit">ms</div>
            </div>
            <div class="stat-card">
                <h3>P99 Latency</h3>
                <div class="value">${latencyPercentiles.p99}</div>
                <div class="unit">ms</div>
            </div>
        </div>

        <div class="recent-requests">
            <h2>Recent Requests</h2>
            <p style="opacity: 0.8;">Click a row to expand request/response details.</p>
            <table class="requests-table">
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Method</th>
                        <th>URL</th>
                        <th>Status</th>
                        <th>Latency</th>
                    </tr>
                </thead>
                <tbody>
                    ${requestRows}
                </tbody>
            </table>
        </div>

        ${anomalies.length > 0 ? `
        <div class="anomalies">
            <h2>🚨 Anomalies Detected (${anomalies.length})</h2>
            ${anomalies.map(anomaly => `
                <div class="anomaly-item">
                    <div class="type">${anomaly.type}</div>
                    <div class="description">${anomaly.description}</div>
                </div>
            `).join('')}
        </div>
        ` : ''}

        <div class="footer">
            <p>Node Pulse - Zero-config API performance intelligence</p>
        </div>
    </div>

    <script>
        const EXPANDED_KEY = 'pulseExpandedRows';

        const getExpanded = () => {
            try {
                return JSON.parse(sessionStorage.getItem(EXPANDED_KEY) || '[]');
            } catch {
                return [];
            }
        };

        const setExpanded = (ids) => {
            sessionStorage.setItem(EXPANDED_KEY, JSON.stringify(ids));
        };

        const getDetailsRow = (idx) => document.querySelector('.request-details[data-idx="' + idx + '"]');

        const isExpanded = (idx) => {
            const details = getDetailsRow(idx);
            return details && details.style.display === 'table-row';
        };

        const setExpandedState = (idx, expanded) => {
            const details = getDetailsRow(idx);
            if (!details) return;
            details.style.display = expanded ? 'table-row' : 'none';

            const expandedIds = new Set(getExpanded());
            if (expanded) expandedIds.add(idx);
            else expandedIds.delete(idx);
            setExpanded([...expandedIds]);
        };

        const restoreExpanded = () => {
            getExpanded().forEach((idx) => setExpandedState(idx, true));
        };

        // Expand/collapse request details
        document.querySelectorAll('.request-row').forEach((row) => {
            row.addEventListener('click', () => {
                const idx = row.dataset.idx;
                const currentlyExpanded = isExpanded(idx);
                setExpandedState(idx, !currentlyExpanded);
            });
        });

        // Preserve expanded rows across reloads
        window.addEventListener('beforeunload', () => {
            const expanded = [];
            document.querySelectorAll('.request-details').forEach((details) => {
                if (details.style.display === 'table-row') {
                    expanded.push(details.dataset.idx);
                }
            });
            setExpanded(expanded);
        });

        restoreExpanded();

        // Auto-refresh every 5 seconds
        setTimeout(() => {
            window.location.reload();
        }, 5000);
    </script>
</body>
</html>`;
    return html;
  }

  async _serveReport(res, format) {
    const metrics  = this._collector.getAll();
    const analysis = new Analyzer(metrics).analyze();

    if (format === 'pdf') {
      const pdf = await generateReport(analysis, metrics);
      const filename = `pulse-report-${Date.now()}.pdf`;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', pdf.length);
      res.end(pdf);
    } else {
      // Serve HTML dashboard
      const html = this._generateDashboardHTML(analysis, metrics);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    }
  }
}

// ─── Module exports ───────────────────────────────────────────────────────────

module.exports = {
  /**
   * Initialise node-pulse (idempotent — repeated calls return the same instance).
   *
   * @param {Partial<typeof DEFAULTS>} [options]
   * @returns {NodePulse}
   */
  init(options = {}) {
    if (!_instance) {
      _instance = new NodePulse(options);
    }
    return _instance;
  },

  /**
   * Destroy the singleton.  Restores all monkey-patches.
   * Primarily intended for use in test teardown.
   */
  _reset() {
    if (_instance) {
      _instance._interceptor.disable();
      _instance = null;
    }
  },

  // Expose class for advanced/sub-classing scenarios.
  NodePulse,
};
