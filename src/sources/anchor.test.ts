/**
 * Credential values never stay in what is read into the assets (Spec §3.1: values do not enter excerpts, fact records,
 * notes, context packs or answers; only the fact that a credential is there stays visible). Every reader — files,
 * sessions, commits, version history, the owner's words — goes through `redactCredentials`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, redactCredentials } from './anchor.ts';

test('a token-shaped credential is replaced whole, a key=value keeps its name, plain text is left alone (Spec §3.1)', () => {
  const tokens = [
    'sk-abcdefghijklmnopqrstuv', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwx', 'AKIAABCDEFGHIJKLMNOP',
    'xoxb-1234567890-abcdefghij', 'AIzaabcdefghijklmnopqrstuvwxyz0123456', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
  ];
  for (const token of tokens) {
    const r = redactCredentials(`the value ${token} is here`);
    assert.equal(r.found, true, token);
    assert.ok(!r.text.includes(token), `${token} stayed in: ${r.text}`);
    assert.equal(r.text, `the value ${REDACTED} is here`);
  }
  assert.deepEqual(redactCredentials('api_key=abcdefghijklmnop end'), { text: `api_key=${REDACTED} end`, found: true });
  assert.deepEqual(redactCredentials('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), { text: `Authorization: Bearer ${REDACTED}`, found: true });
  assert.deepEqual(redactCredentials('Invoices are voided, never deleted.'), { text: 'Invoices are voided, never deleted.', found: false });
});
