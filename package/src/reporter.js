'use strict';

/**
 * Reporter — worker-thread orchestration layer.
 *
 * Spawns a dedicated worker_thread for each PDF generation request so that
 * PDFKit's synchronous document construction and canvas rendering never
 * execute on the host application's event loop.
 *
 * The caller receives a Promise<Buffer> and can await it or pipe it to an
 * HTTP response without any special ceremony.
 */

const { Worker } = require('node:worker_threads');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'pdf-worker.js');

/**
 * Generate a PDF report in a worker thread.
 *
 * @param {object} analysis   Output of Analyzer.analyze()
 * @param {object[]} _metrics Raw records (reserved for future per-request drill-down pages)
 * @returns {Promise<Buffer>}
 */
function generateReport(analysis, _metrics = []) {
  return new Promise((resolve, reject) => {
    // Deep-clone via JSON round-trip to safely transfer across the thread
    // boundary (Date objects become ISO strings — the worker handles them).
    let serialised;
    try {
      serialised = JSON.parse(JSON.stringify(analysis));
    } catch (err) {
      return reject(new Error(`[node-pulse] Failed to serialise analysis data: ${err.message}`));
    }

    const worker = new Worker(WORKER_PATH, {
      workerData: { analysis: serialised },
    });

    worker.on('message', (arrayBuffer) => {
      // Worker transfers an ArrayBuffer; wrap it in a Node Buffer.
      resolve(Buffer.from(arrayBuffer));
    });

    worker.on('error', (err) => {
      reject(new Error(`[node-pulse] PDF worker error: ${err.message}`));
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`[node-pulse] PDF worker exited with code ${code}`));
      }
    });
  });
}

module.exports = { generateReport };
