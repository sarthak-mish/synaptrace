'use strict';

/**
 * Interceptor — zero-config HTTP traffic capture.
 *
 * Strategy:
 *  1. Monkey-patch `http.Server.prototype.emit` (and the https variant) to
 *     intercept every 'request' event, start a high-resolution timer, and
 *     open an AsyncLocalStorage context that propagates the trace state
 *     through the entire async lifecycle of that request.
 *
 *  2. Monkey-patch `http.ServerResponse.prototype.write` and `.end` so that
 *     any response chunk written anywhere in the codebase is accumulated in
 *     the ALS store for that request.
 *
 *  3. On `res.end()`, compute latency, run the redactor, and push the metric
 *     to the Collector via `setImmediate` so the host app's event loop is
 *     never blocked.
 */

const http = require('node:http');
const https = require('node:https');
const { AsyncLocalStorage } = require('node:async_hooks');
const { redact } = require('./redactor');

// Shared ALS instance — exported so that advanced consumers can read context.
const als = new AsyncLocalStorage();

class Interceptor {
  /**
   * @param {import('./collector').Collector} collector
   * @param {object} options
   * @param {string[]} [options.redact]        Extra keys to redact.
   * @param {number}  [options.sampleRate]     0–1 fraction of requests to record.
   */
  constructor(collector, options = {}) {
    this._collector = collector;
    this._options = options;
    this._enabled = false;

    // Saved originals — restored by disable().
    this._origServerEmit = null;
    this._origWrite = null;
    this._origEnd = null;
  }

  // ─── Public lifecycle ────────────────────────────────────────────────────

  enable() {
    if (this._enabled) return;
    this._enabled = true;
    this._patchServerEmit();
    this._patchResponseProto();
  }

  disable() {
    if (!this._enabled) return;
    this._enabled = false;

    if (this._origServerEmit) {
      http.Server.prototype.emit = this._origServerEmit;
      https.Server.prototype.emit = this._origServerEmit;
      this._origServerEmit = null;
    }
    if (this._origWrite) {
      http.ServerResponse.prototype.write = this._origWrite;
      this._origWrite = null;
    }
    if (this._origEnd) {
      http.ServerResponse.prototype.end = this._origEnd;
      this._origEnd = null;
    }
  }

  // ─── Private patching ────────────────────────────────────────────────────

  _patchServerEmit() {
    const self = this;
    const original = http.Server.prototype.emit;
    this._origServerEmit = original;

    const patched = function pulsePatchedEmit(event, req, res) {
      if (event !== 'request') {
        return original.apply(this, arguments);
      }

      // Honour sample rate — pass through untracked requests transparently.
      const { sampleRate = 1.0 } = self._options;
      if (sampleRate < 1.0 && Math.random() > sampleRate) {
        return original.apply(this, arguments);
      }

      const store = {
        traceId: crypto.randomUUID(),
        startTime: process.hrtime.bigint(),
        method: req.method,
        url: req.url,
        requestHeaders: { ...req.headers },
        reqChunks: [],
        resChunks: [],
      };

      // Accumulate request body non-destructively.
      // Adding our own 'data' listener does NOT prevent downstream listeners
      // from receiving the same chunks — Node.js streams fan-out to all
      // registered listeners.
      req.on('data', (chunk) => {
        store.reqChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });

      // Run the original emit inside the ALS context so every async
      // continuation triggered by this request inherits `store`.
      return als.run(store, () => original.call(this, event, req, res));
    };

    http.Server.prototype.emit = patched;
    https.Server.prototype.emit = patched;
  }

  _patchResponseProto() {
    const self = this;
    const origWrite = http.ServerResponse.prototype.write;
    const origEnd = http.ServerResponse.prototype.end;
    this._origWrite = origWrite;
    this._origEnd = origEnd;

    http.ServerResponse.prototype.write = function pulseWrite(chunk, ...rest) {
      const store = als.getStore();
      if (store && chunk) {
        store.resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return origWrite.call(this, chunk, ...rest);
    };

    http.ServerResponse.prototype.end = function pulseEnd(chunk, ...rest) {
      const store = als.getStore();
      if (store) {
        if (chunk) {
          store.resChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }

        const endTime = process.hrtime.bigint();
        const latencyMs = Number(endTime - store.startTime) / 1_000_000;
        const statusCode = this.statusCode;

        // Schedule metric recording off the hot path — the response is
        // flushed to the client before we do any telemetry work.
        setImmediate(() => {
          try {
            self._record(store, statusCode, latencyMs);
          } catch (err) {
            // FAIL-SAFE: telemetry must never crash the host application.
            process.emit('pulse:error', err);
          }
        });
      }

      return origEnd.call(this, chunk, ...rest);
    };
  }

  // ─── Metric assembly ─────────────────────────────────────────────────────

  _record(store, statusCode, latencyMs) {
    const extraRedactKeys = this._options.redact ?? [];

    const reqBody =
      store.reqChunks.length > 0
        ? Buffer.concat(store.reqChunks).toString('utf8')
        : '';

    const resBody =
      store.resChunks.length > 0
        ? Buffer.concat(store.resChunks).toString('utf8')
        : '';

    this._collector.record({
      traceId:         store.traceId,
      timestamp:       new Date(),
      method:          store.method,
      url:             store.url,
      statusCode,
      latencyMs,
      requestHeaders:  redact(store.requestHeaders, extraRedactKeys),
      requestBody:     redact(reqBody,              extraRedactKeys),
      responseBody:    redact(resBody,              extraRedactKeys),
    });
  }
}

module.exports = { Interceptor, als };
