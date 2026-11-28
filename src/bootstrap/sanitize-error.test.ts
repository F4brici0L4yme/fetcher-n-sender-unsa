import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeErrorDiagnostic } from './sanitize-error';

test('redacts non-Bearer Authorization headers completely', () => {
  const basic = sanitizeErrorDiagnostic(new Error('HTTP 401 Authorization: Basic dXNlcjpwYXNzMTIz on portal'));
  assert.doesNotMatch(basic, /dXNlcjpwYXNzMTIz/);
  assert.match(basic, /\[REDACTED\]/);

  const token = sanitizeErrorDiagnostic(new Error('Failed header Authorization: Token my-secret-token'));
  assert.doesNotMatch(token, /my-secret-token/);
  assert.match(token, /\[REDACTED\]/);

  const digest = sanitizeErrorDiagnostic(new Error('Authorization: Digest username="student", realm="moodle", response="deadbeef1234"'));
  assert.doesNotMatch(digest, /deadbeef1234/);
  assert.doesNotMatch(digest, /student/);
  assert.match(digest, /\[REDACTED\]/);
});

test('redacts JSON-formatted errors with quoted secret keys and values', () => {
  const jsonSecrets = sanitizeErrorDiagnostic(
    new Error('Upstream failed: {"password": "super-secret-123", "token": "tok_abc", "status": 401}'),
  );
  assert.doesNotMatch(jsonSecrets, /super-secret-123/);
  assert.doesNotMatch(jsonSecrets, /tok_abc/);
  assert.match(jsonSecrets, /"status": 401/);

  const jsonCookie = sanitizeErrorDiagnostic(
    new Error('{"cookie": "MoodleSession2026B=abc123def", "authorization": "Bearer xyz987"}'),
  );
  assert.doesNotMatch(jsonCookie, /abc123def/);
  assert.doesNotMatch(jsonCookie, /xyz987/);
});

test('redacts suffixed Moodle session cookies anywhere they appear', () => {
  const suffixed = sanitizeErrorDiagnostic(new Error('Session rejected for MoodleSession2026B=abc123def; path=/'));
  assert.doesNotMatch(suffixed, /abc123def/);
  assert.match(suffixed, /\[REDACTED\]/);

  const underscore = sanitizeErrorDiagnostic(new Error('MoodleSession_unsa-prod=topsecret999'));
  assert.doesNotMatch(underscore, /topsecret999/);
});

test('redacts embedded credentials for any URL scheme including ws, wss, http, https, postgres', () => {
  for (const rawUrl of [
    'wss://alice:ws-secret@stream.example.invalid/vnc',
    'ws://bob:plain-pass@127.0.0.1:6080',
    'postgres://dbuser:dbpass99@db.internal:5432/app',
    'postgresql://dbuser:dbpass99@db.internal:5432/app',
    'https://user:portalpass@aula.example.invalid/2026B/',
  ]) {
    const out = sanitizeErrorDiagnostic(new Error(`Connection failed to ${rawUrl}`));
    assert.doesNotMatch(out, /ws-secret|plain-pass|dbpass99|portalpass/);
    assert.match(out, /\[REDACTED\]/);
  }
});

test('sanitizes and bounds error.code and preserves safe error diagnostics', () => {
  const coded = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  assert.equal(sanitizeErrorDiagnostic(coded), 'Error [ECONNREFUSED]: connect ECONNREFUSED 127.0.0.1:5432');

  const leakyCode = Object.assign(new Error('safe message'), { code: `token=secret-code-value ${'x'.repeat(100)}` });
  const sanitized = sanitizeErrorDiagnostic(leakyCode);
  assert.doesNotMatch(sanitized, /secret-code-value/);
  assert.ok(sanitized.length < 160);

  const safeUrl = sanitizeErrorDiagnostic(new Error('Navigation timeout at https://aula.example.invalid/2026B/my/'));
  assert.equal(safeUrl, 'Error: Navigation timeout at https://aula.example.invalid/2026B/my/');

  const longMessage = sanitizeErrorDiagnostic(new Error('a'.repeat(350)));
  assert.equal(longMessage, `Error: ${'a'.repeat(200)}`);
});
