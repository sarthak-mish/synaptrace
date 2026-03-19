'use strict';

/**
 * Collector — O(1) ring-buffer for telemetry records.
 *
 * Keeps at most `maxSize` entries in memory. When the buffer is full the
 * oldest entry is silently overwritten, preventing unbounded heap growth
 * in long-running processes.
 */
class Collector {
  /**
   * @param {number} maxSize  Maximum number of request records to retain.
   */
  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
    this._buf = new Array(maxSize);
    this._head = 0; // next write position
    this._size = 0; // current number of stored entries
  }

  /**
   * Append a metric record to the ring buffer.
   * @param {object} metric
   */
  record(metric) {
    this._buf[this._head] = metric;
    this._head = (this._head + 1) % this.maxSize;
    if (this._size < this.maxSize) this._size++;
  }

  /**
   * Return all stored records in chronological order (oldest → newest).
   * @returns {object[]}
   */
  getAll() {
    if (this._size === 0) return [];
    if (this._size < this.maxSize) {
      return this._buf.slice(0, this._size);
    }
    // Buffer has wrapped — reconstruct chronological order.
    return [...this._buf.slice(this._head), ...this._buf.slice(0, this._head)];
  }

  /** Remove all stored records. */
  clear() {
    this._buf = new Array(this.maxSize);
    this._head = 0;
    this._size = 0;
  }

  /** Number of records currently stored. */
  get count() {
    return this._size;
  }
}

module.exports = { Collector };
