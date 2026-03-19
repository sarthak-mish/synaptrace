'use strict';

const {
  redact,
  redactObject,
  redactString,
  DEFAULT_REDACT_KEYS,
  REDACTED_VALUE,
} = require('../src/redactor');

// ─── redactObject ────────────────────────────────────────────────────────────

describe('redactObject', () => {
  test('redacts a known sensitive key', () => {
    const result = redactObject({ username: 'alice', password: 'hunter2' }, ['password']);
    expect(result.password).toBe(REDACTED_VALUE);
    expect(result.username).toBe('alice');
  });

  test('is case-insensitive on both key and redact list', () => {
    const result = redactObject(
      { PASSWORD: 'secret', Authorization: 'Bearer tok' },
      ['password', 'authorization']
    );
    expect(result.PASSWORD).toBe(REDACTED_VALUE);
    expect(result.Authorization).toBe(REDACTED_VALUE);
  });

  test('recursively redacts nested objects', () => {
    const result = redactObject({ user: { password: 'x', name: 'bob' } }, ['password']);
    expect(result.user.password).toBe(REDACTED_VALUE);
    expect(result.user.name).toBe('bob');
  });

  test('redacts inside arrays', () => {
    const result = redactObject(
      [{ token: 'abc' }, { token: 'def' }],
      ['token']
    );
    expect(result[0].token).toBe(REDACTED_VALUE);
    expect(result[1].token).toBe(REDACTED_VALUE);
  });

  test('passes through null', () => {
    expect(redactObject(null, ['password'])).toBeNull();
  });

  test('passes through undefined', () => {
    expect(redactObject(undefined, ['password'])).toBeUndefined();
  });

  test('passes through primitives unchanged', () => {
    expect(redactObject(42, [])).toBe(42);
  });

  test('does not mutate the original object', () => {
    const original = { password: 'secret' };
    redactObject(original, ['password']);
    expect(original.password).toBe('secret');
  });

  test('preserves non-sensitive keys exactly', () => {
    const result = redactObject({ a: 1, b: 'hello', c: true }, ['x']);
    expect(result).toEqual({ a: 1, b: 'hello', c: true });
  });
});

// ─── redactString ────────────────────────────────────────────────────────────

describe('redactString', () => {
  test('redacts JSON-format values', () => {
    const input = '{"password":"hunter2","user":"alice"}';
    const result = redactString(input, ['password']);
    expect(result).toContain(REDACTED_VALUE);
    expect(result).not.toContain('hunter2');
    expect(result).toContain('"user":"alice"');
  });

  test('redacts URL-encoded form values', () => {
    const input = 'username=alice&password=secret&token=abc123';
    const result = redactString(input, ['password', 'token']);
    expect(result).toContain('username=alice');
    expect(result).not.toContain('secret');
    expect(result).not.toContain('abc123');
  });

  test('handles JSON with spaces around colon', () => {
    const input = '{ "authorization" : "Bearer xyz" }';
    const result = redactString(input, ['authorization']);
    expect(result).not.toContain('xyz');
    expect(result).toContain(REDACTED_VALUE);
  });

  test('returns non-string input unchanged', () => {
    expect(redactString(null, [])).toBeNull();
    expect(redactString(undefined, [])).toBeUndefined();
  });

  test('is case-insensitive', () => {
    const input = '{"PASSWORD":"secret"}';
    const result = redactString(input, ['password']);
    expect(result).not.toContain('secret');
  });
});

// ─── redact (top-level) ───────────────────────────────────────────────────────

describe('redact', () => {
  test('redacts a plain JSON body string', () => {
    const body = JSON.stringify({ authorization: 'Bearer tok', payload: 'data' });
    const result = redact(body);
    const parsed = JSON.parse(result);
    expect(parsed.authorization).toBe(REDACTED_VALUE);
    expect(parsed.payload).toBe('data');
  });

  test('redacts a header object', () => {
    const headers = {
      cookie: 'session=abc',
      'content-type': 'application/json',
    };
    const result = redact(headers);
    expect(result.cookie).toBe(REDACTED_VALUE);
    expect(result['content-type']).toBe('application/json');
  });

  test('applies custom redact keys', () => {
    const obj = { mySecret: 'sensitive', public: 'visible' };
    const result = redact(obj, ['mySecret']);
    expect(result.mySecret).toBe(REDACTED_VALUE);
    expect(result.public).toBe('visible');
  });

  test('falls back to string redaction for non-JSON strings', () => {
    const formBody = 'username=alice&password=pw123';
    const result = redact(formBody);
    expect(result).not.toContain('pw123');
    expect(result).toContain('username=alice');
  });

  test('passes through primitives', () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBeNull();
  });

  test('DEFAULT_REDACT_KEYS covers common PII fields', () => {
    const sensitive = ['password', 'authorization', 'cookie', 'token', 'secret', 'api_key'];
    for (const key of sensitive) {
      expect(DEFAULT_REDACT_KEYS).toContain(key);
    }
  });

  test('redacts deeply nested custom keys', () => {
    const obj = { level1: { level2: { myToken: 'abc' } } };
    const result = redact(obj, ['myToken']);
    expect(result.level1.level2.myToken).toBe(REDACTED_VALUE);
  });

  test('handles empty string gracefully', () => {
    const result = redact('');
    expect(result).toBe('');
  });

  test('does not redact partial key matches', () => {
    // 'pass' should not trigger 'password'
    const obj = { pass: 'ok', password: 'secret' };
    const result = redact(obj);
    expect(result.pass).toBe('ok');
    expect(result.password).toBe(REDACTED_VALUE);
  });
});
