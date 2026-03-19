'use strict';

/**
 * Analyzer — converts raw Collector records into actionable intelligence.
 *
 * Produces:
 *  - Latency percentiles  (P50 / P90 / P99 / min / max)
 *  - Status-code distribution  (2xx / 3xx / 4xx / 5xx)
 *  - Per-minute traffic volume
 *  - Slowest 10 % of requests
 *  - Anomaly log  (latency spikes and 5xx errors)
 *  - Composite Health Score  (0–100)
 */
class Analyzer {
  /** @param {object[]} metrics  Raw records from Collector.getAll() */
  constructor(metrics = []) {
    this.metrics = metrics;
  }

  analyze() {
    const { metrics } = this;
    if (metrics.length === 0) return this._empty();

    const sorted = [...metrics].map((m) => m.latencyMs).sort((a, b) => a - b);
    const statusGroups = this._statusGroups(metrics);
    const traffic = this._traffic(metrics);
    const slowest = this._slowest(metrics, 0.1);
    const anomalies = this._anomalies(metrics, sorted);
    const healthScore = this._healthScore(metrics, sorted, statusGroups);

    const total = metrics.length;
    const avgLatencyMs = (sorted.reduce((s, v) => s + v, 0) / total).toFixed(2);
    const errorCount = statusGroups['4xx'] + statusGroups['5xx'];

    return {
      summary: {
        totalRequests: total,
        timeRange: {
          start: metrics[0].timestamp,
          end:   metrics[total - 1].timestamp,
        },
        healthScore,
        errorRate:    ((errorCount / total) * 100).toFixed(2),
        avgLatencyMs,
      },
      latencyPercentiles: {
        p50: this._pct(sorted, 50),
        p90: this._pct(sorted, 90),
        p95: this._pct(sorted, 95),
        p99: this._pct(sorted, 99),
        min: parseFloat(sorted[0].toFixed(2)),
        max: parseFloat(sorted[sorted.length - 1].toFixed(2)),
      },
      statusGroups,
      traffic,
      slowest,
      anomalies,
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  _empty() {
    return {
      summary: {
        totalRequests: 0,
        timeRange: { start: null, end: null },
        healthScore: 100,
        errorRate: '0.00',
        avgLatencyMs: '0.00',
      },
      latencyPercentiles: { p50: 0, p90: 0, p99: 0, min: 0, max: 0 },
      statusGroups: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
      traffic: [],
      slowest: [],
      anomalies: [],
    };
  }

  /**
   * Nearest-rank percentile over a pre-sorted array.
   * @param {number[]} sorted
   * @param {number}   p       0–100
   * @returns {number}
   */
  _pct(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return parseFloat(sorted[Math.max(0, idx)].toFixed(2));
  }

  _statusGroups(metrics) {
    const g = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    for (const m of metrics) {
      const key = `${Math.floor(m.statusCode / 100)}xx`;
      if (key in g) g[key]++;
    }
    return g;
  }

  /** Bucket requests into per-minute intervals for the traffic chart. */
  _traffic(metrics) {
    const byMinute = new Map();
    for (const m of metrics) {
      const d = new Date(m.timestamp);
      d.setSeconds(0, 0);
      const key = d.toISOString();
      byMinute.set(key, (byMinute.get(key) ?? 0) + 1);
    }
    return [...byMinute.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([time, count]) => ({ time, count }));
  }

  /**
   * Returns the slowest `fraction` of requests, sorted descending by latency.
   * @param {object[]} metrics
   * @param {number}   fraction   0–1
   */
  _slowest(metrics, fraction) {
    const cutoff = Math.max(1, Math.ceil(metrics.length * fraction));
    return [...metrics]
      .sort((a, b) => b.latencyMs - a.latencyMs)
      .slice(0, cutoff)
      .map(({ traceId, timestamp, method, url, statusCode, latencyMs }) => ({
        traceId,
        timestamp,
        method,
        url,
        statusCode,
        latencyMs,
      }));
  }

  /**
   * Flag requests whose latency exceeds 2× P99, plus all 5xx responses.
   */
  _anomalies(metrics, sorted) {
    const p99 = this._pct(sorted, 99);
    const spikeThreshold = p99 * 2;

    return metrics
      .filter((m) => m.latencyMs > spikeThreshold || m.statusCode >= 500)
      .map((m) => {
        const isError = m.statusCode >= 500;
        const reason = isError
          ? `Server Error (HTTP ${m.statusCode})`
          : `Latency Spike — ${m.latencyMs.toFixed(0)} ms > ${spikeThreshold.toFixed(0)} ms (2× P99)`;

        return {
          traceId:    m.traceId,
          timestamp:  m.timestamp,
          method:     m.method,
          url:        m.url,
          statusCode: m.statusCode,
          latencyMs:  m.latencyMs,
          type:       isError ? 'Server Error' : 'Latency Spike',
          reason,
          description: reason,
        };
      });
  }

  /**
   * Composite health score (0–100).
   *
   * Deduction model:
   *   - Up to 40 pts for error rate   (4xx + 5xx)
   *   - Up to 30 pts for server errors (5xx only — more severe)
   *   - Up to 30 pts for P99 latency bracket
   */
  _healthScore(metrics, sorted, groups) {
    const total = metrics.length || 1;
    let score = 100;

    const errorRate = (groups['4xx'] + groups['5xx']) / total;
    const serverErrorRate = groups['5xx'] / total;
    const p99 = this._pct(sorted, 99);

    score -= Math.min(40, errorRate * 200);      // error rate penalty
    score -= Math.min(30, serverErrorRate * 300); // 5xx severity penalty

    // P99 latency brackets
    if      (p99 > 5_000) score -= 30;
    else if (p99 > 2_000) score -= 20;
    else if (p99 > 1_000) score -= 15;
    else if (p99 >   500) score -= 10;
    else if (p99 >   200) score -=  5;

    return Math.max(0, Math.round(score));
  }
}

module.exports = { Analyzer };
