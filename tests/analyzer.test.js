'use strict';

const { Analyzer } = require('../src/analyzer');

// ─── Factory ──────────────────────────────────────────────────────────────────

let _seq = 0;
function metric(overrides = {}) {
  return {
    traceId:    `trace-${++_seq}`,
    timestamp:  new Date(),
    method:     'GET',
    url:        '/api/test',
    statusCode: 200,
    latencyMs:  100,
    ...overrides,
  };
}

function metrics(n, overrides = {}) {
  return Array.from({ length: n }, () => metric(overrides));
}

// ─── Empty dataset ───────────────────────────────────────────────────────────

describe('Analyzer — empty dataset', () => {
  test('returns zero totalRequests', () => {
    expect(new Analyzer([]).analyze().summary.totalRequests).toBe(0);
  });

  test('returns perfect health score', () => {
    expect(new Analyzer([]).analyze().summary.healthScore).toBe(100);
  });

  test('returns zero for all percentiles', () => {
    const { latencyPercentiles } = new Analyzer([]).analyze();
    expect(latencyPercentiles.p50).toBe(0);
    expect(latencyPercentiles.p90).toBe(0);
    expect(latencyPercentiles.p99).toBe(0);
  });

  test('returns empty arrays for traffic, slowest, anomalies', () => {
    const a = new Analyzer([]).analyze();
    expect(a.traffic).toEqual([]);
    expect(a.slowest).toEqual([]);
    expect(a.anomalies).toEqual([]);
  });
});

// ─── Latency percentiles ─────────────────────────────────────────────────────

describe('Analyzer — latency percentiles', () => {
  test('calculates P50 correctly for 100 requests (1..100 ms)', () => {
    const data = Array.from({ length: 100 }, (_, i) => metric({ latencyMs: i + 1 }));
    const { latencyPercentiles } = new Analyzer(data).analyze();
    expect(latencyPercentiles.p50).toBe(50);
  });

  test('calculates P90 correctly', () => {
    const data = Array.from({ length: 100 }, (_, i) => metric({ latencyMs: i + 1 }));
    const { latencyPercentiles } = new Analyzer(data).analyze();
    expect(latencyPercentiles.p90).toBe(90);
  });

  test('calculates P99 correctly', () => {
    const data = Array.from({ length: 100 }, (_, i) => metric({ latencyMs: i + 1 }));
    const { latencyPercentiles } = new Analyzer(data).analyze();
    expect(latencyPercentiles.p99).toBe(99);
  });

  test('single metric — all percentiles equal the sole value', () => {
    const { latencyPercentiles } = new Analyzer([metric({ latencyMs: 250 })]).analyze();
    expect(latencyPercentiles.p50).toBe(250);
    expect(latencyPercentiles.p90).toBe(250);
    expect(latencyPercentiles.p99).toBe(250);
    expect(latencyPercentiles.min).toBe(250);
    expect(latencyPercentiles.max).toBe(250);
  });

  test('min and max are correctly identified', () => {
    const data = [
      metric({ latencyMs: 5 }),
      metric({ latencyMs: 500 }),
      metric({ latencyMs: 150 }),
    ];
    const { latencyPercentiles } = new Analyzer(data).analyze();
    expect(latencyPercentiles.min).toBe(5);
    expect(latencyPercentiles.max).toBe(500);
  });

  test('average latency is computed correctly', () => {
    const data = [
      metric({ latencyMs: 100 }),
      metric({ latencyMs: 200 }),
      metric({ latencyMs: 300 }),
    ];
    const { summary } = new Analyzer(data).analyze();
    expect(parseFloat(summary.avgLatencyMs)).toBeCloseTo(200, 1);
  });
});

// ─── Status code grouping ────────────────────────────────────────────────────

describe('Analyzer — status code grouping', () => {
  test('correctly groups 2xx, 3xx, 4xx, 5xx', () => {
    const data = [
      metric({ statusCode: 200 }),
      metric({ statusCode: 201 }),
      metric({ statusCode: 301 }),
      metric({ statusCode: 404 }),
      metric({ statusCode: 422 }),
      metric({ statusCode: 500 }),
      metric({ statusCode: 503 }),
    ];
    const { statusGroups } = new Analyzer(data).analyze();
    expect(statusGroups['2xx']).toBe(2);
    expect(statusGroups['3xx']).toBe(1);
    expect(statusGroups['4xx']).toBe(2);
    expect(statusGroups['5xx']).toBe(2);
  });

  test('error rate reflects 4xx + 5xx count', () => {
    const data = [
      ...metrics(80, { statusCode: 200 }),
      ...metrics(10, { statusCode: 404 }),
      ...metrics(10, { statusCode: 500 }),
    ];
    const { summary } = new Analyzer(data).analyze();
    expect(parseFloat(summary.errorRate)).toBeCloseTo(20, 1);
  });

  test('zero error rate for all-2xx traffic', () => {
    const { summary } = new Analyzer(metrics(50, { statusCode: 200 })).analyze();
    expect(parseFloat(summary.errorRate)).toBe(0);
  });
});

// ─── Health score ─────────────────────────────────────────────────────────────

describe('Analyzer — health score', () => {
  test('is 100 for fast, error-free traffic', () => {
    const { summary } = new Analyzer(metrics(50, { statusCode: 200, latencyMs: 50 })).analyze();
    expect(summary.healthScore).toBe(100);
  });

  test('decreases with high 5xx rate', () => {
    const data = [
      ...metrics(50, { statusCode: 200, latencyMs: 50 }),
      ...metrics(50, { statusCode: 500, latencyMs: 50 }),
    ];
    const { summary } = new Analyzer(data).analyze();
    expect(summary.healthScore).toBeLessThan(80);
  });

  test('decreases with high P99 latency', () => {
    const { summary } = new Analyzer(
      metrics(50, { statusCode: 200, latencyMs: 3_000 })
    ).analyze();
    expect(summary.healthScore).toBeLessThan(100);
  });

  test('is never negative', () => {
    const data = [
      ...metrics(50, { statusCode: 500, latencyMs: 10_000 }),
    ];
    const { summary } = new Analyzer(data).analyze();
    expect(summary.healthScore).toBeGreaterThanOrEqual(0);
  });

  test('is never greater than 100', () => {
    const { summary } = new Analyzer(metrics(10, { statusCode: 200, latencyMs: 10 })).analyze();
    expect(summary.healthScore).toBeLessThanOrEqual(100);
  });
});

// ─── Anomaly detection ───────────────────────────────────────────────────────

describe('Analyzer — anomaly detection', () => {
  test('flags 5xx responses', () => {
    const data = [
      metric({ statusCode: 500, latencyMs: 100 }),
      metric({ statusCode: 200, latencyMs: 100 }),
    ];
    const { anomalies } = new Analyzer(data).analyze();
    expect(anomalies.some((a) => a.statusCode === 500)).toBe(true);
  });

  test('does NOT flag 4xx as an anomaly on its own', () => {
    // 4xx alone (no latency spike) should not appear in the anomaly log
    const data = [
      ...metrics(99, { statusCode: 200, latencyMs: 100 }),
      metric({ statusCode: 404, latencyMs: 100 }),
    ];
    const { anomalies } = new Analyzer(data).analyze();
    const fourHundredAnomaly = anomalies.find(
      (a) => a.statusCode === 404 && !a.reason.includes('Error')
    );
    expect(fourHundredAnomaly).toBeUndefined();
  });

  test('flags requests that exceed 2× P99 latency', () => {
    const data = [
      ...Array.from({ length: 99 }, () => metric({ latencyMs: 100 })),
      metric({ latencyMs: 50_000 }),
    ];
    const { anomalies } = new Analyzer(data).analyze();
    expect(anomalies.some((a) => a.latencyMs === 50_000)).toBe(true);
  });

  test('anomaly entries include required fields', () => {
    const data = [metric({ statusCode: 500 })];
    const { anomalies } = new Analyzer(data).analyze();
    const a = anomalies[0];
    expect(a).toHaveProperty('traceId');
    expect(a).toHaveProperty('timestamp');
    expect(a).toHaveProperty('method');
    expect(a).toHaveProperty('url');
    expect(a).toHaveProperty('statusCode');
    expect(a).toHaveProperty('latencyMs');
    expect(a).toHaveProperty('reason');
    expect(typeof a.reason).toBe('string');
  });
});

// ─── Slowest 10 % ────────────────────────────────────────────────────────────

describe('Analyzer — slowest 10%', () => {
  test('returns exactly 10% of total requests', () => {
    const data = Array.from({ length: 100 }, (_, i) => metric({ latencyMs: i + 1 }));
    const { slowest } = new Analyzer(data).analyze();
    expect(slowest.length).toBe(10);
  });

  test('slowest entries are ordered descending by latency', () => {
    const data = Array.from({ length: 100 }, (_, i) => metric({ latencyMs: i + 1 }));
    const { slowest } = new Analyzer(data).analyze();
    for (let i = 0; i < slowest.length - 1; i++) {
      expect(slowest[i].latencyMs).toBeGreaterThanOrEqual(slowest[i + 1].latencyMs);
    }
  });

  test('the slowest entry has the maximum latency', () => {
    const data = Array.from({ length: 100 }, (_, i) => metric({ latencyMs: i + 1 }));
    const { slowest, latencyPercentiles } = new Analyzer(data).analyze();
    expect(slowest[0].latencyMs).toBe(latencyPercentiles.max);
  });

  test('slowest entries expose required keys only (no body bloat)', () => {
    const data = metrics(20);
    const { slowest } = new Analyzer(data).analyze();
    const expectedKeys = ['traceId', 'timestamp', 'method', 'url', 'statusCode', 'latencyMs'];
    for (const entry of slowest) {
      for (const key of expectedKeys) {
        expect(entry).toHaveProperty(key);
      }
      // Ensure raw body is NOT leaked into the summary table
      expect(entry).not.toHaveProperty('requestBody');
      expect(entry).not.toHaveProperty('responseBody');
    }
  });
});

// ─── Traffic volume ───────────────────────────────────────────────────────────

describe('Analyzer — traffic volume', () => {
  test('returns one bucket per distinct minute', () => {
    const base = new Date('2024-01-01T10:00:00Z');
    const data = [
      metric({ timestamp: new Date(base.getTime() + 0)         }),
      metric({ timestamp: new Date(base.getTime() + 30_000)    }), // same minute
      metric({ timestamp: new Date(base.getTime() + 60_000)    }), // next minute
    ];
    const { traffic } = new Analyzer(data).analyze();
    expect(traffic.length).toBe(2);
    expect(traffic[0].count).toBe(2);
    expect(traffic[1].count).toBe(1);
  });

  test('traffic buckets are sorted chronologically', () => {
    const base = Date.now();
    const data = [
      metric({ timestamp: new Date(base + 120_000) }),
      metric({ timestamp: new Date(base) }),
      metric({ timestamp: new Date(base + 60_000) }),
    ];
    const { traffic } = new Analyzer(data).analyze();
    for (let i = 0; i < traffic.length - 1; i++) {
      expect(traffic[i].time <= traffic[i + 1].time).toBe(true);
    }
  });
});
