'use strict';

/**
 * Redactor — configurable PII scrubbing engine.
 *
 * Works on plain objects (e.g. parsed headers / bodies) and raw strings
 * (JSON-serialised or URL-encoded bodies).  All comparisons are
 * case-insensitive so that `Authorization`, `authorization`, and
 * `AUTHORIZATION` are all caught.
 */

const REDACTED_VALUE = '[REDACTED]';

/** Keys that are always scrubbed regardless of user configuration. */
const DEFAULT_REDACT_KEYS = [
  'password',
  'passwd',
  'pwd',
  'authorization',
  'auth',
  'cookie',
  'set-cookie',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'secret',
  'client_secret',
  'api_key',
  'apikey',
  'x-api-key',
  'x-auth-token',
  'ssn',
  'credit_card',
  'cvv',
  'cc_number',
];

/**
 * Recursively redact sensitive keys from a plain object.
 *
 * @param {object} obj
 * @param {string[]} keys   Lower-cased keys to redact.
 * @returns {object}
 */
function redactObject(obj, keys) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, keys));
  }

  const normalized = new Set(keys.map((k) => k.toLowerCase()));
  const result = {};

  for (const [k, v] of Object.entries(obj)) {
    if (normalized.has(k.toLowerCase())) {
      result[k] = REDACTED_VALUE;
    } else if (typeof v === 'object' && v !== null) {
      result[k] = redactObject(v, keys);
    } else {
      result[k] = v;
    }
  }

  return result;
}

/**
 * Redact sensitive values from a raw string.
 * Handles both JSON (`"key": "value"`) and URL-encoded (`key=value`) formats.
 *
 * @param {string} str
 * @param {string[]} keys
 * @returns {string}
 */
function redactString(str, keys) {
  if (!str || typeof str !== 'string') return str;

  let result = str;

  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // JSON: "key": "value"  or  "key":"value"
    const jsonPattern = new RegExp(
      `("${escaped}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
      'gi'
    );
    result = result.replace(jsonPattern, `$1"${REDACTED_VALUE}"`);

    // URL-encoded: key=value  (value ends at & or end-of-string)
    const formPattern = new RegExp(
      `((?:^|&|\\?)${escaped}=)[^&]*`,
      'gi'
    );
    result = result.replace(formPattern, `$1${REDACTED_VALUE}`);
  }

  return result;
}

/**
 * Top-level redact function.
 * Dispatches to the appropriate handler based on the type of `data`.
 *
 * @param {string|object|*} data
 * @param {string[]} [customKeys=[]]   Additional keys to redact beyond defaults.
 * @returns {string|object|*}
 */
function redact(data, customKeys = []) {
  const keys = [...DEFAULT_REDACT_KEYS, ...customKeys];

  if (typeof data === 'string') {
    // Attempt JSON parse → object redaction → re-serialise.
    // Falls back to raw-string redaction if the body is not valid JSON.
    try {
      const parsed = JSON.parse(data);
      return JSON.stringify(redactObject(parsed, keys));
    } catch {
      return redactString(data, keys);
    }
  }

  if (typeof data === 'object' && data !== null) {
    return redactObject(data, keys);
  }

  return data; // primitives pass through unchanged
}

module.exports = {
  redact,
  redactObject,
  redactString,
  DEFAULT_REDACT_KEYS,
  REDACTED_VALUE,
};
