import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  createLiveClient, describeSnapshot, validateApiBase, validateSnapshot, sourceQuality,
  POLL_INTERVAL_MS, STALE_AFTER_MS,
} from '../dashboard/public/live-client.mjs';

function snapshot(timestamp = '2026-10-06T08:00:00.000Z') {
  return {
    meta: { timestamp, quality: { counts: { data: 10, no_data: 2, unavailable: 3, error: 1 }, partial: true } },
    air: [], thermal: [], chokepoints: [], nuke: [], who: [], fred: [], bls: [], health: [], tSignals: [],
    tg: { urgent: [], topPosts: [] }, sdr: { zones: [] }, energy: {}, treasury: {},
  };
}
function harness(overrides = {}) {
  const timers = new Map();
  const listeners = new Map();
  const states = [];
  let nextTimer = 0;
  const doc = {
    hidden: false,
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const client = createLiveClient({
    apiBase: 'https://example.workers.dev', documentRef: doc,
    setTimeoutFn(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeoutFn(id) { timers.delete(id); },
    fetchImpl: async () => ({ ok: true, json: async () => snapshot() }),
    onState: state => states.push(state), ...overrides,
  });
  return {
    client, states, timers, doc,
    visibility(hidden) { doc.hidden = hidden; listeners.get('visibilitychange')?.(); },
    fire(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected timer of ${delay} ms`);
      timers.delete(entry[0]); entry[1].callback();
    },
  };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('API URL accepts same origin or HTTPS and rejects credentials / non-HTTPS', () => {
  assert.equal(validateApiBase(''), '');
  assert.equal(validateApiBase('https://api.example.test/'), 'https://api.example.test');
  for (const invalid of ['http://api.test', '/api', 'javascript:alert(1)', 'https://user:pass@api.test', 'https://api.test/?key=secret', 'https://api.test/#token', 42]) {
    assert.throws(() => validateApiBase(invalid));
  }
});

test('rejects bad payloads; quality is explicit and never inferred from old OK counts', () => {
  assert.throws(() => validateSnapshot({ meta: { timestamp: 'invalid' } }));
  assert.throws(() => validateSnapshot({ meta: { timestamp: new Date().toISOString() } }));
  assert.equal(sourceQuality({ meta: { sourcesOk: 29, sourcesQueried: 29 } }), null);
  assert.equal(sourceQuality(snapshot()).partial, true);
  const data = snapshot(); data.meta.quality = { data: 2, no_data: 1, unavailable: 0, error: 0, partial: false };
  assert.deepEqual(sourceQuality(data), { counts: { data: 2, no_data: 1, unavailable: 0, error: 0 }, partial: false });
});

test('starts empty, fetches configured API, and accepts only live response', async () => {
  let seen;
  const h = harness({ fetchImpl: async (...args) => { seen = args; return { ok: true, json: async () => snapshot() }; } });
  assert.equal(h.client.getState().data, null);
  await h.client.start();
  assert.equal(seen[0], 'https://example.workers.dev/api/data');
  assert.equal(seen[1].credentials, 'omit');
  assert.equal(seen[1].cache, 'no-store');
  assert.equal(h.states[0].data, null);
  assert.ok(h.client.getState().data);
  assert.ok([...h.timers.values()].some(timer => timer.delay === POLL_INTERVAL_MS));
  h.client.stop();
  assert.equal(h.timers.size, 0);
});

test('initial HTTP error stays empty and is visibly retryable', async () => {
  const h = harness({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  await h.client.start();
  const state = h.client.getState();
  assert.equal(state.data, null);
  assert.match(describeSnapshot(state), /Live data unavailable.*HTTP 503.*No snapshot/);
  h.client.stop();
});

test('temporary errors retain the last good snapshot with a clear warning, then recover', async () => {
  let fail = false;
  const h = harness({ fetchImpl: async () => {
    if (fail) throw new Error('Network offline');
    return { ok: true, json: async () => snapshot() };
  } });
  await h.client.start();
  const original = h.client.getState().data;
  fail = true;
  await h.client.refresh();
  assert.equal(h.client.getState().data, original);
  const message = describeSnapshot(h.client.getState(), Date.parse('2026-10-06T12:00:00Z'));
  assert.match(message, /LAST SUCCESSFUL SNAPSHOT.*STALE/);
  assert.match(message, /2026-10-06T08:00:00.000Z/);
  assert.match(message, /10 data · 2 no data · 3 unavailable · 1 errors/);
  assert.match(message, /Network offline/);
  fail = false;
  await h.client.refresh();
  assert.equal(h.client.getState().error, null);
  h.client.stop();
});

test('rapid retry clicks cannot overlap and polling does not overlap a request', async () => {
  let finish;
  let count = 0;
  const h = harness({ fetchImpl: () => { count++; return new Promise(resolve => { finish = resolve; }); } });
  const first = h.client.start();
  assert.equal(h.client.refresh(), first);
  assert.equal(h.client.refresh(), first);
  assert.equal(count, 1);
  assert.ok(![...h.timers.values()].some(timer => timer.delay === POLL_INTERVAL_MS));
  finish({ ok: true, json: async () => snapshot() });
  await first;
  assert.equal(count, 1);
  h.client.stop();
});

test('hides pause polling; becoming visible immediately refreshes exactly once', async () => {
  let count = 0;
  const h = harness({ fetchImpl: async () => { count++; return { ok: true, json: async () => snapshot() }; } });
  await h.client.start();
  h.visibility(true);
  assert.equal(h.timers.size, 0);
  await h.client.refresh();
  assert.equal(count, 1);
  h.visibility(false);
  await turn();
  assert.equal(count, 2);
  assert.equal(h.client.getState().paused, false);
  h.client.stop();
});

test('initially hidden tabs do not fetch until visible', async () => {
  let count = 0;
  const h = harness({ fetchImpl: async () => { count++; return { ok: true, json: async () => snapshot() }; } });
  h.doc.hidden = true;
  await h.client.start();
  assert.equal(count, 0);
  h.visibility(false);
  await turn();
  assert.equal(count, 1);
  h.client.stop();
});

test('timeout ends even a non-settling fetch and exposes an error', async () => {
  const h = harness({ fetchImpl: () => new Promise(() => {}), requestTimeoutMs: 100 });
  const pending = h.client.start();
  h.fire(100);
  await pending;
  assert.match(h.client.getState().error, /timed out/);
  assert.equal(h.client.getState().refreshing, false);
  h.client.stop();
});

test('rendering or malformed-payload failure does not replace a previously successful snapshot', async () => {
  let invalid = false;
  const h = harness({ onData() { if (invalid) throw new Error('Render failed'); } });
  await h.client.start();
  const previous = h.client.getState().data;
  invalid = true;
  await h.client.refresh();
  assert.equal(h.client.getState().data, previous);
  assert.match(h.client.getState().error, /Render failed/);
  h.client.stop();
});

test('stale threshold is three hours and updates even without another network response', async () => {
  let now = Date.parse('2026-10-06T08:00:00Z') + STALE_AFTER_MS;
  const h = harness({ now: () => now });
  await h.client.start();
  assert.equal(h.states.at(-1).stale, false);
  now++;
  h.fire(60_000);
  assert.equal(h.states.at(-1).stale, true);
  h.client.stop();
});

test('HTTP source script immediately discards archived inline data; file mode is marked archival', async () => {
  const html = await readFile(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const context = vm.createContext({
    location: { protocol: 'https:' }, window: { innerWidth: 1440 },
    localStorage: { getItem: () => null }, document: { addEventListener() {} },
  });
  new vm.Script(script).runInContext(context);
  assert.equal(vm.runInContext('D', context), null);
  assert.match(html, /ARCHIVAL FILE · NOT LIVE/);
  assert.doesNotMatch(html, /new EventSource\(/);
  assert.doesNotMatch(html, /hasInlineData/);
});
