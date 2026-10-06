import test from 'node:test';
import assert from 'node:assert/strict';
import * as entry from '../worker/entry.mjs';

test('Worker deployment entry exposes only the default fetch handler', () => {
  assert.deepEqual(Object.keys(entry), ['default']);
  assert.equal(typeof entry.default.fetch, 'function');
});
