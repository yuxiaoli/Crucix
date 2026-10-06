// Public, read-only snapshot API. Only the publisher may write to KV.
export const SNAPSHOT_KEY = 'snapshot:v1';
export const ALLOWED_ORIGIN = 'https://yuxiaoli.github.io';
export const CACHE_TTL_SECONDS = 300;
export const STALE_AFTER_SECONDS = 3 * 60 * 60;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const FAILURE_TTL_MS = 30_000;
const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';
const PREFLIGHT_HEADERS = new Set(['accept', 'content-type', 'if-none-match']);
const EXPOSE_HEADERS = 'ETag, X-Snapshot-Timestamp, X-Snapshot-Generated-At, X-Snapshot-Age-Seconds, X-Snapshot-Stale';
const encoder = new TextEncoder();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validQuality(quality) {
  if (!isObject(quality) || !isObject(quality.counts) || typeof quality.partial !== 'boolean' ||
      !Number.isInteger(quality.total) || quality.total < 0 || !Array.isArray(quality.sources) ||
      quality.sources.length !== quality.total) return false;
  const states = ['data', 'no_data', 'unavailable', 'error'];
  const counts = Object.fromEntries(states.map(state => [state, 0]));
  for (const source of quality.sources) {
    if (!isObject(source) || typeof source.name !== 'string' || typeof source.reason !== 'string' ||
        !states.includes(source.state)) return false;
    counts[source.state] += 1;
  }
  return states.every(state => quality.counts[state] === counts[state]);
}

function publicHeaders(origin) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  if (origin === ALLOWED_ORIGIN) {
    headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    headers.set('Access-Control-Expose-Headers', EXPOSE_HEADERS);
  }
  return headers;
}

function errorResponse(request, origin, status, code, message, extra = {}) {
  const headers = publicHeaders(origin);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: code, message }), { status, headers });
}

// Stream the raw envelope so an oversized/corrupt KV value cannot force an
// unbounded body allocation or parse. The limit covers UTF-8 bytes, not characters.
async function readBounded(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot size limit');
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Best-effort cancellation. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function digest(body) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(body));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readSnapshot(binding, now) {
  const stream = await binding.get(SNAPSHOT_KEY, { type: 'stream', cacheTtl: CACHE_TTL_SECONDS });
  if (!stream) throw new Error('Snapshot missing');
  const snapshot = JSON.parse(await readBounded(stream));
  // Require the publisher's canonical UTC ISO timestamp. Reject impossible dates
  // and large clock skew rather than reporting future snapshots as fresh forever.
  const generatedMs = Date.parse(snapshot?.generatedAt);
  const observedMs = Date.parse(snapshot?.data?.meta?.timestamp);
  if (!isObject(snapshot) || snapshot.schemaVersion !== 1 ||
      !Number.isFinite(generatedMs) || new Date(generatedMs).toISOString() !== snapshot.generatedAt ||
      generatedMs > now + 5 * 60_000 || !Number.isFinite(observedMs) ||
      observedMs > generatedMs + 5 * 60_000 || !isObject(snapshot.data) ||
      !isObject(snapshot.data.meta) || !validQuality(snapshot.data.meta.quality)) {
    throw new Error('Snapshot format');
  }
  const dataBody = JSON.stringify(snapshot.data);
  const hash = await digest(`${snapshot.generatedAt}\n${dataBody}`);
  return {
    dataBody,
    generatedAt: snapshot.generatedAt,
    timestamp: new Date(observedMs).toISOString(),
    quality: snapshot.data.meta.quality,
    etag: `"${hash}"`,
    expiresAt: now + CACHE_TTL_SECONDS * 1000,
  };
}

function cacheKey(request, kind) {
  const url = new URL(request.url);
  url.pathname = `/__crucix_snapshot_cache/v1/${kind}`;
  url.search = '';
  url.hash = '';
  // Never pass through queries, conditional headers, cookies, Origin, or methods.
  return new Request(url.toString(), { method: 'GET' });
}

function cachedResponse(snapshot, kind) {
  return new Response(kind === 'data' ? snapshot.dataBody : JSON.stringify({ quality: snapshot.quality }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      'X-Crucix-Expires-At': String(snapshot.expiresAt),
      'X-Crucix-Generated-At': snapshot.generatedAt,
      'X-Crucix-Timestamp': snapshot.timestamp,
      ETag: snapshot.etag,
    },
  });
}

async function readCached(cache, request, kind, now) {
  if (!cache) return null;
  try {
    const response = await cache.match(cacheKey(request, kind));
    if (!response || response.status !== 200) return null;
    const generatedAt = response.headers.get('X-Crucix-Generated-At');
    const timestamp = response.headers.get('X-Crucix-Timestamp');
    const expiresAt = Number(response.headers.get('X-Crucix-Expires-At'));
    const etag = response.headers.get('ETag');
    if (!Number.isFinite(Date.parse(generatedAt)) || !Number.isFinite(Date.parse(timestamp)) || expiresAt <= now || !Number.isFinite(expiresAt) || !etag) {
      if (response.body) void response.body.cancel().catch(() => {});
      return null;
    }
    if (kind === 'data') return { body: response.body, generatedAt, timestamp, etag };
    const metadata = await response.json();
    if (!validQuality(metadata.quality)) return null;
    return { quality: metadata.quality, generatedAt, timestamp, etag };
  } catch {
    // Cache API is optional (for example, local development or unavailable cache).
    return null;
  }
}

function notModified(header, etag) {
  return header?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag) ?? false;
}

function respond(request, origin, kind, snapshot, now) {
  const headers = publicHeaders(origin);
  const ageSeconds = Math.max(0, Math.floor((now - Date.parse(snapshot.timestamp)) / 1000));
  const stale = now - Date.parse(snapshot.timestamp) > STALE_AFTER_SECONDS * 1000;
  headers.set('X-Snapshot-Timestamp', snapshot.timestamp);
  headers.set('X-Snapshot-Generated-At', snapshot.generatedAt);
  headers.set('X-Snapshot-Age-Seconds', String(ageSeconds));
  headers.set('X-Snapshot-Stale', String(stale));
  // Force browser revalidation so freshness headers and health age remain current.
  // The internal edge/memory representations still live for 300 seconds.
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  let etag = snapshot.etag;
  let body = snapshot.body ?? snapshot.dataBody;
  if (kind === 'health') {
    const degraded = snapshot.quality?.partial === true;
    body = JSON.stringify({
      ok: !stale && !degraded,
      status: stale ? 'stale' : degraded ? 'degraded' : 'ok',
      timestamp: snapshot.timestamp,
      generatedAt: snapshot.generatedAt,
      ageSeconds,
      stale,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      quality: snapshot.quality,
      consistency: 'eventual',
      cacheTtlSeconds: CACHE_TTL_SECONDS,
    });
    // Health is a different, age-sensitive representation from the data body.
    etag = `"health-${snapshot.etag.slice(1, -1)}-${ageSeconds}-${stale}"`;
  }
  headers.set('ETag', etag);
  const status = notModified(request.headers.get('If-None-Match'), etag) ? 304 : 200;
  if (request.method === 'HEAD' || status === 304) {
    // A cached stream not forwarded to the client must be released.
    if (body && typeof body.cancel === 'function') void body.cancel().catch(() => {});
    body = null;
  }
  return new Response(body, { status, headers });
}

/** Optional dependencies keep tests local and dependency-free. */
export function createWorker({ now = () => Date.now(), getCache = () => globalThis.caches?.default } = {}) {
  // One memo per KV binding. No per-query, per-Origin, or per-client allocation.
  // Pending reads are coalesced; unavailable snapshots get a short negative memo.
  const snapshots = new WeakMap();

  async function load(binding, cache, request, ctx) {
    const time = now();
    let entry = snapshots.get(binding);
    if (entry?.pending) return entry.pending;
    if (entry && entry.expiresAt > time) {
      if (entry.failed) throw new Error('Snapshot unavailable');
      return entry;
    }
    entry = {};
    entry.pending = (async () => {
      try {
        const snapshot = await readSnapshot(binding, time);
        snapshots.set(binding, snapshot);
        if (cache) {
          const store = Promise.all(['data', 'health'].map(kind =>
            Promise.resolve().then(() => cache.put(cacheKey(request, kind), cachedResponse(snapshot, kind))),
          )).catch(() => {});
          if (ctx?.waitUntil) ctx.waitUntil(store);
          else await store;
        }
        return snapshot;
      } catch {
        snapshots.set(binding, { failed: true, expiresAt: now() + FAILURE_TTL_MS });
        throw new Error('Snapshot unavailable');
      }
    })();
    snapshots.set(binding, entry);
    return entry.pending;
  }

  return {
    async fetch(request, env, ctx) {
      const origin = request.headers.get('Origin');
      if (origin !== null && origin !== ALLOWED_ORIGIN) {
        return errorResponse(request, null, 403, 'ORIGIN_NOT_ALLOWED', 'Origin not allowed');
      }
      const path = new URL(request.url).pathname;
      if (path !== '/api/data' && path !== '/api/health') {
        return errorResponse(request, origin, 404, 'NOT_FOUND', 'Not found');
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
        return errorResponse(request, origin, 405, 'METHOD_NOT_ALLOWED', 'Read-only API', { Allow: ALLOWED_METHODS });
      }
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('Access-Control-Request-Method');
        const requested = request.headers.get('Access-Control-Request-Headers');
        if ((method && !['GET', 'HEAD'].includes(method)) ||
            (requested && requested.split(',').some(header => !PREFLIGHT_HEADERS.has(header.trim().toLowerCase())))) {
          return errorResponse(request, origin, 403, 'PREFLIGHT_NOT_ALLOWED', 'Preflight not allowed');
        }
        const headers = publicHeaders(origin);
        headers.set('Allow', ALLOWED_METHODS);
        headers.set('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
        if (origin === ALLOWED_ORIGIN) {
          headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
          headers.set('Access-Control-Allow-Headers', 'Accept, Content-Type, If-None-Match');
          headers.set('Access-Control-Max-Age', String(CACHE_TTL_SECONDS));
        }
        return new Response(null, { status: 204, headers });
      }
      const kind = path === '/api/data' ? 'data' : 'health';
      try {
        const binding = env?.CRUCIX_SNAPSHOTS;
        if (!binding || typeof binding.get !== 'function') throw new Error('No binding');
        let cache;
        try { cache = getCache(); } catch { /* Optional cache may be unavailable. */ }
        const memo = snapshots.get(binding);
        const snapshot = memo && !memo.failed && !memo.pending && memo.expiresAt > now()
          ? memo
          : await readCached(cache, request, kind, now()) ?? await load(binding, cache, request, ctx);
        return respond(request, origin, kind, snapshot, now());
      } catch {
        return errorResponse(request, origin, 503, 'SNAPSHOT_UNAVAILABLE', 'Snapshot temporarily unavailable', { 'Retry-After': '30' });
      }
    },
  };
}

export default createWorker();
