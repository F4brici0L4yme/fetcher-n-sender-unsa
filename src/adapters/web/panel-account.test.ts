import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCurrentAccount, currentAccount } from './panel-account';

test('personal account pins reject stale forms after switching accounts', () => {
  let selected = 'student-a';
  const account = { current: () => selected };
  assert.equal(currentAccount(account), 'student-a');
  assert.doesNotThrow(() => assertCurrentAccount(account, 'student-a'));
  selected = 'student-b';
  assert.equal(currentAccount(account), 'student-b');
  assert.throws(() => assertCurrentAccount(account, 'student-a'));
  assert.throws(() => assertCurrentAccount(account, undefined));
  assert.throws(() => assertCurrentAccount(account, ['student-b']));
});

test('fixed legacy account flows remain compatible without account form field', () => {
  assert.equal(currentAccount('demo-local'), 'demo-local');
  assert.doesNotThrow(() => assertCurrentAccount('demo-local', undefined));
});
