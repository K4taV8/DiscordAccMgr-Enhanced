import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt, autoConcurrency } from '../src/utils/serverTaskUtils.js';

test('autoConcurrency boundary values', () => {
  assert.equal(autoConcurrency(1), 1);
  assert.equal(autoConcurrency(2), 1);
  assert.equal(autoConcurrency(3), 3);
  assert.equal(autoConcurrency(7), 7);
  assert.equal(autoConcurrency(8), 8);
  assert.equal(autoConcurrency(200), 8);
});

test('fmt formats seconds and minutes', () => {
  assert.equal(fmt(0), '');
  assert.equal(fmt(1), '1s');
  assert.equal(fmt(59), '59s');
  assert.equal(fmt(60), '1m 0s');
  assert.equal(fmt(125), '2m 5s');
  assert.equal(fmt(NaN), '');
  assert.equal(fmt(undefined), '');
});
