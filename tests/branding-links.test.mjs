import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Sean credit uses the personal short link', () => {
  const html = readFileSync(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
  assert.equal(html.split('<a href="https://s.vectorindex.cloud/sean">Sean</a>').length - 1, 1);
  assert.ok(!html.includes('https://www.linkedin.com/in/yuxiaoli/'));
});
