import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorker, SNAPSHOT_KEY, ALLOWED_ORIGIN, CACHE_TTL_SECONDS,
  STALE_AFTER_SECONDS, MAX_SNAPSHOT_BYTES,
} from '../worker/src/index.mjs';

const START = Date.parse('2026-10-06T08:00:00.000Z');
const encoder = new TextEncoder();
const iso = milliseconds => new Date(milliseconds).toISOString();
function fixture({ timestamp = START - 600_000, generatedAt = START - 60_000, partial = false, data = {} } = {}) {
  return {
    schemaVersion: 1,
    generatedAt: iso(generatedAt),
    data: {
      meta: {
        timestamp: iso(timestamp),
        quality: {
          counts: { data: partial ? 0 : 1, no_data: 0, unavailable: partial ? 1 : 0, error: 0 },
          total: 1,
          partial,
          sources: [{ name: 'FIRMS', state: partial ? 'unavailable' : 'data', reason: partial ? 'Missing configuration' : 'Observations returned' }],
          policy: 'conservative-observations-v1',
        },
      },
      news: [{ title: 'Snapshot fixture' }],
      ...data,
    },
  };
}

class FakeKV {
  constructor(value = JSON.stringify(fixture())) { this.value = value; this.calls = []; this.cancelled = false; }
  async get(key, options) {
    this.calls.push({ key, options });
    if (this.error) throw this.error;
    if (this.gate) await this.gate;
    if (this.value === null) return null;
    const bytes = typeof this.value === 'string' ? encoder.encode(this.value) : this.value;
    const self = this;
    let offset = 0;
    return new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset += 64 * 1024));
      },
      cancel() { self.cancelled = true; },
    });
  }
  put() { throw new Error('Worker attempted KV mutation'); }
  delete() { throw new Error('Worker attempted KV mutation'); }
  list() { throw new Error('Worker attempted namespace scan'); }
}

class FakeCache {
  constructor() { this.entries = new Map(); this.matches = []; this.puts = []; }
  async match(request) {
    this.matches.push({ url: request.url, method: request.method, headers: [...request.headers] });
    return this.entries.get(request.url)?.clone();
  }
  async put(request, response) {
    this.puts.push({ url: request.url, method: request.method, headers: [...request.headers] });
    this.entries.set(request.url, response.clone());
  }
}

function setup({ value, cache = new FakeCache(), start = START } = {}) {
  let time = start;
  const kv = new FakeKV(value);
  const env = { CRUCIX_SNAPSHOTS: kv };
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const dependencies = { now: () => time, getCache: () => cache };
  let worker = createWorker(dependencies);
  return {
    kv, env, cache, ctx,
    async fetch(path = '/api/data', options = {}) {
      return worker.fetch(new Request(`https://crucix.example${path}`, options), env, ctx);
    },
    async flush() { await Promise.all(pending.splice(0)); },
    advance(milliseconds) { time += milliseconds; },
    freshIsolate() { worker = createWorker(dependencies); },
  };
}

const allowedHeaders = { Origin: ALLOWED_ORIGIN };

test('GET returns exactly snapshot.data and exact CORS, without credentials', async () => {
  const run = setup();
  const response = await run.fetch('/api/data', { headers: allowedHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), fixture().data);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(response.headers.get('Vary'), 'Origin');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Snapshot-Timestamp'), fixture().data.meta.timestamp);
  assert.equal(response.headers.get('X-Snapshot-Generated-At'), fixture().generatedAt);
  assert.equal(response.headers.get('X-Snapshot-Age-Seconds'), '600');
  assert.equal(response.headers.get('X-Snapshot-Stale'), 'false');
  assert.match(response.headers.get('Access-Control-Expose-Headers'), /X-Snapshot-Stale/);
  assert.deepEqual(run.kv.calls, [{ key: SNAPSHOT_KEY, options: { type: 'stream', cacheTtl: 300 } }]);
  await run.flush();
  assert.equal(run.cache.puts.length, 2);
});

test('Origin absent is permitted for probes and never emits wildcard CORS', async () => {
  const response = await setup().fetch();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
});

test('health reports source sweep age, separate generation time and quality', async () => {
  const response = await setup().fetch('/api/health');
  const health = await response.json();
  assert.deepEqual(health, {
    ok: true, status: 'ok', timestamp: fixture().data.meta.timestamp,
    generatedAt: fixture().generatedAt, ageSeconds: 600, stale: false,
    staleAfterSeconds: 10800, quality: fixture().data.meta.quality,
    consistency: 'eventual', cacheTtlSeconds: 300,
  });
});

test('partial coverage reports degraded even if the snapshot is fresh', async () => {
  const run = setup({ value: JSON.stringify(fixture({ partial: true })) });
  const health = await (await run.fetch('/api/health')).json();
  assert.equal(health.ok, false);
  assert.equal(health.status, 'degraded');
  assert.equal(health.stale, false);
  assert.equal(health.quality.partial, true);
});

test('stale is strictly over 3 hours and updates across cached reads', async () => {
  const run = setup({ value: JSON.stringify(fixture({ timestamp: START - STALE_AFTER_SECONDS * 1000 })) });
  const fresh = await run.fetch('/api/health');
  const etag = fresh.headers.get('ETag');
  assert.equal((await fresh.json()).stale, false);
  await run.flush();
  run.advance(1);
  run.freshIsolate();
  const stale = await run.fetch('/api/health', { headers: { 'If-None-Match': etag } });
  assert.equal(stale.status, 200);
  const health = await stale.json();
  assert.equal(health.status, 'stale');
  assert.equal(health.ok, false);
  assert.equal(health.stale, true);
  assert.equal(health.ageSeconds, 10800);
  const data = await run.fetch('/api/data');
  assert.equal(data.headers.get('X-Snapshot-Stale'), 'true');
  assert.equal(run.kv.calls.length, 1);
});

test('recent synthesis cannot hide a stale source sweep', async () => {
  const run = setup({ value: JSON.stringify(fixture({ timestamp: START - 4 * 3600_000, generatedAt: START })) });
  const response = await run.fetch('/api/health');
  assert.equal((await response.json()).ageSeconds, 14400);
  assert.equal(response.headers.get('X-Snapshot-Stale'), 'true');
});

test('HEAD for data and health has no body and the GET validators', async () => {
  for (const path of ['/api/data', '/api/health']) {
    const run = setup();
    const get = await run.fetch(path, { headers: allowedHeaders });
    const head = await run.fetch(path, { method: 'HEAD', headers: allowedHeaders });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('ETag'), get.headers.get('ETag'));
    assert.equal(head.headers.get('X-Snapshot-Age-Seconds'), get.headers.get('X-Snapshot-Age-Seconds'));
  }
});

test('hostile or malformed Origins are rejected before any KV/cache access', async () => {
  const run = setup();
  for (const origin of [
    'null', 'https://evil.example', 'http://yuxiaoli.github.io',
    'https://yuxiaoli.github.io.evil.example', 'https://yuxiaoli.github.io@evil.example',
    'https://yuxiaoli.github.io:443', 'https://yuxiaoli.github.io/',
    'https://YUXIAOLI.github.io', 'https://yuxiaoli.github.io, https://evil.example', 'garbage', '',
  ]) {
    const response = await run.fetch('/api/data', { headers: { Origin: origin } });
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(run.kv.calls.length, 0);
  assert.equal(run.cache.matches.length, 0);
});

test('preflights allow only exact Origin, read methods and bounded headers', async () => {
  const run = setup();
  for (const method of ['GET', 'HEAD']) {
    const response = await run.fetch('/api/data', {
      method: 'OPTIONS', headers: { ...allowedHeaders,
        'Access-Control-Request-Method': method,
        'Access-Control-Request-Headers': 'If-None-Match, Content-Type',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('Access-Control-Max-Age'), '300');
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  }
  for (const headers of [
    { ...allowedHeaders, 'Access-Control-Request-Method': 'POST' },
    { ...allowedHeaders, 'Access-Control-Request-Headers': 'Authorization' },
    { ...allowedHeaders, 'Access-Control-Request-Headers': 'If-None-Match, X-Publish-Token' },
    { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
  ]) {
    assert.equal((await run.fetch('/api/health', { method: 'OPTIONS', headers })).status, 403);
  }
  assert.equal(run.kv.calls.length, 0);
});

test('mutation methods and unexpected routes are denied without reading or writing KV', async () => {
  const run = setup();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await run.fetch('/api/data', { method, headers: allowedHeaders, body: 'attack' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD, OPTIONS');
  }
  for (const path of ['/', '/api/events', '/api/refresh', '/api/publish', '/api/data/', '/__crucix_snapshot_cache/v1/data']) {
    assert.equal((await run.fetch(path)).status, 404, path);
  }
  assert.equal(run.kv.calls.length, 0);
  assert.equal(run.cache.matches.length, 0);
});

test('queries, Origin, request headers and HEAD cannot fragment cached snapshot keys', async () => {
  const run = setup();
  await run.fetch('/api/health?timestamp=first');
  await run.flush();
  for (let index = 0; index < 5; index++) {
    run.freshIsolate();
    const response = await run.fetch(`/api/data?nonce=${index}&key=other`, {
      method: index % 2 ? 'HEAD' : 'GET',
      headers: { ...allowedHeaders, Cookie: 'ignore=me', 'Cache-Control': 'no-cache', 'If-None-Match': '"miss"' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
    await response.text();
  }
  assert.equal(run.kv.calls.length, 1);
  assert.equal(new Set([...run.cache.matches, ...run.cache.puts].map(item => item.url)).size, 2);
  for (const request of [...run.cache.matches, ...run.cache.puts]) {
    assert.equal(new URL(request.url).search, '');
    assert.equal(request.method, 'GET');
    assert.deepEqual(request.headers, []);
  }
});

test('cache API serves both endpoints to a cold isolate from one snapshot read', async () => {
  const run = setup();
  await run.fetch();
  await run.flush();
  run.kv.error = new Error('KV must not be read for cached representations');
  run.freshIsolate();
  assert.equal((await run.fetch('/api/health')).status, 200);
  assert.deepEqual(await (await run.fetch()).json(), fixture().data);
  assert.equal(run.kv.calls.length, 1);
});

test('ETag supports exact, weak, list and wildcard conditional reads', async () => {
  const run = setup();
  const initial = await run.fetch();
  const etag = initial.headers.get('ETag');
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  await run.flush();
  for (const value of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
    run.freshIsolate();
    const response = await run.fetch('/api/data', { headers: { ...allowedHeaders, 'If-None-Match': value } });
    assert.equal(response.status, 304);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('ETag'), etag);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
  }
  assert.equal((await run.fetch('/api/data', { headers: { 'If-None-Match': '"wrong"' } })).status, 200);
  assert.equal(run.kv.calls.length, 1);
});

test('health ETag changes with age and differs from data validator', async () => {
  const run = setup();
  const data = await run.fetch();
  const first = await run.fetch('/api/health');
  const etag = first.headers.get('ETag');
  assert.notEqual(etag, data.headers.get('ETag'));
  assert.equal((await run.fetch('/api/health', { headers: { 'If-None-Match': etag } })).status, 304);
  run.advance(1000);
  assert.equal((await run.fetch('/api/health', { headers: { 'If-None-Match': etag } })).status, 200);
});

test('300-second memo and edge cache expire and a new snapshot is loaded', async () => {
  const run = setup();
  const first = await run.fetch();
  const etag = first.headers.get('ETag');
  await run.flush();
  run.kv.value = JSON.stringify(fixture({ generatedAt: START, data: { news: [] } }));
  run.advance(CACHE_TTL_SECONDS * 1000 - 1);
  assert.equal((await run.fetch()).headers.get('ETag'), etag);
  run.advance(1);
  const refreshed = await run.fetch();
  assert.notEqual(refreshed.headers.get('ETag'), etag);
  assert.deepEqual((await refreshed.json()).news, []);
  assert.equal(run.kv.calls.length, 2);
});

test('concurrent data and health cache misses share the pending KV read', async () => {
  const run = setup({ cache: undefined });
  let release;
  run.kv.gate = new Promise(resolve => { release = resolve; });
  const pending = Array.from({ length: 12 }, (_, i) => run.fetch(i % 2 ? '/api/health' : '/api/data'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(run.kv.calls.length, 1);
  release();
  assert.ok((await Promise.all(pending)).every(response => response.status === 200));
  assert.equal(run.kv.calls.length, 1);
});

test('unsupported or failing Cache API still permits reads with a bounded isolate memo', async () => {
  for (const cache of [null, { match() { throw new Error('cache unavailable'); }, put() { throw new Error('cache unavailable'); } }]) {
    const run = setup({ cache });
    assert.equal((await run.fetch()).status, 200);
    await run.flush();
    assert.equal((await run.fetch('/api/health')).status, 200);
    assert.equal(run.kv.calls.length, 1);
  }
});

test('missing, corrupt, unsupported and malformed snapshots return safe 503s', async () => {
  const variants = [null, '', 'not json', '{}', 'null', '[]',
    JSON.stringify({ ...fixture(), schemaVersion: 2 }),
    JSON.stringify({ ...fixture(), generatedAt: 'not a date' }),
    JSON.stringify({ ...fixture(), generatedAt: '2026-02-30T00:00:00.000Z' }),
    JSON.stringify({ ...fixture(), generatedAt: iso(START + 3600_000) }),
    JSON.stringify({ ...fixture(), data: [] }),
    JSON.stringify({ ...fixture(), data: { meta: { timestamp: iso(START), quality: {} } } }),
    JSON.stringify({ ...fixture(), data: { meta: { timestamp: 'bad', quality: fixture().data.meta.quality } } }),
  ];
  for (const value of variants) {
    const run = setup({ value });
    const response = await run.fetch('/api/data', { headers: allowedHeaders });
    assert.equal(response.status, 503, String(value));
    assert.deepEqual(await response.json(), { error: 'SNAPSHOT_UNAVAILABLE', message: 'Snapshot temporarily unavailable' });
    assert.equal(response.headers.get('Retry-After'), '30');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ALLOWED_ORIGIN);
    assert.equal(run.cache.puts.length, 0);
    assert.equal((await run.fetch('/api/health')).status, 503);
    assert.equal(run.kv.calls.length, 1, 'short negative memo avoids repeated reads');
  }
});

test('KV exceptions and missing binding do not leak stack traces or credentials', async () => {
  const run = setup();
  run.kv.error = new Error('sensitive token stack secret location');
  const response = await run.fetch();
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /sensitive|token|stack|secret|location/);
  const worker = createWorker();
  const missing = await worker.fetch(new Request('https://crucix.example/api/health'), {});
  assert.equal(missing.status, 503);
  assert.doesNotMatch(await missing.text(), /binding|TypeError|stack/i);
});

test('negative memo expires, allowing a missing snapshot to recover', async () => {
  const run = setup({ value: null });
  assert.equal((await run.fetch()).status, 503);
  run.kv.value = JSON.stringify(fixture());
  run.advance(29_999);
  assert.equal((await run.fetch()).status, 503);
  run.advance(1);
  assert.equal((await run.fetch()).status, 200);
  assert.equal(run.kv.calls.length, 2);
});

test('oversized UTF-8 snapshots are cancelled before JSON parse', async () => {
  const run = setup({ value: JSON.stringify(fixture({ data: { payload: '界'.repeat(MAX_SNAPSHOT_BYTES / 2) } })) });
  assert.ok(run.kv.value.length < MAX_SNAPSHOT_BYTES, 'fixture is below cap in characters, above it in bytes');
  assert.equal((await run.fetch()).status, 503);
  assert.equal(run.kv.cancelled, true);
  assert.equal(run.cache.puts.length, 0);
});

test('malformed UTF-8 is rejected instead of silently repaired', async () => {
  const original = encoder.encode(JSON.stringify(fixture()));
  const bytes = new Uint8Array(original.length + 1);
  bytes.set(original);
  bytes[original.length] = 0xff;
  assert.equal((await setup({ value: bytes }).fetch()).status, 503);
});

test('HEAD errors remain bodyless', async () => {
  const run = setup({ value: null });
  for (const [path, headers, status] of [
    ['/api/data', {}, 503], ['/nope', {}, 404], ['/api/data', { Origin: 'null' }, 403],
  ]) {
    const response = await run.fetch(path, { method: 'HEAD', headers });
    assert.equal(response.status, status);
    assert.equal(await response.text(), '');
  }
});

test('invalid cached metadata is discarded and the KV snapshot repairs it', async () => {
  const run = setup();
  await run.fetch();
  await run.flush();
  const key = run.cache.puts.find(item => item.url.endsWith('/health')).url;
  const previous = run.cache.entries.get(key);
  run.cache.entries.set(key, new Response('{broken-json', { headers: previous.headers }));
  run.freshIsolate();
  assert.equal((await run.fetch('/api/health')).status, 200);
  assert.equal(run.kv.calls.length, 2);
});

test('snapshot cap is inclusive for a valid exactly 2 MiB envelope', async () => {
  const sample = fixture({ data: { payload: '' } });
  const overhead = encoder.encode(JSON.stringify(sample)).byteLength;
  sample.data.payload = 'x'.repeat(MAX_SNAPSHOT_BYTES - overhead);
  const value = JSON.stringify(sample);
  assert.equal(encoder.encode(value).byteLength, MAX_SNAPSHOT_BYTES);
  const run = setup({ value, cache: null });
  const response = await run.fetch();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).payload.length, MAX_SNAPSHOT_BYTES - overhead);
});

test('quality count mismatches and unknown states are corrupt snapshots', async () => {
  for (const alter of [
    q => { q.counts.data = 9; },
    q => { q.sources[0].state = 'unknown'; },
    q => { q.total = 2; },
    q => { delete q.partial; },
  ]) {
    const snapshot = fixture();
    alter(snapshot.data.meta.quality);
    assert.equal((await setup({ value: JSON.stringify(snapshot) }).fetch()).status, 503);
  }
});
