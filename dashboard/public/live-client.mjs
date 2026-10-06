/** Live snapshot transport. No snapshots or credentials are persisted by this client. */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 20 * 1000;

export function validateApiBase(value = '') {
  if (value === '') return ''; // Existing Express server: same-origin API.
  if (typeof value !== 'string') throw new Error('The API URL must be an HTTPS URL.');
  let url;
  try { url = new URL(value); } catch { throw new Error('The API URL must be an HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('The API URL must use HTTPS without credentials, query parameters, or a fragment.');
  }
  return url.href.replace(/\/+$/, '');
}

export function snapshotTimestamp(data) {
  return data?.meta?.snapshotTimestamp || data?.meta?.timestamp || null;
}

export function validateSnapshot(data) {
  if (!data || typeof data !== 'object' || !Number.isFinite(Date.parse(snapshotTimestamp(data)))) {
    throw new Error('The API returned an invalid snapshot timestamp.');
  }
  for (const key of ['air', 'thermal', 'chokepoints', 'nuke', 'who', 'fred', 'bls', 'health', 'tSignals']) {
    if (!Array.isArray(data[key])) throw new Error(`The API returned an invalid snapshot (${key}).`);
  }
  if (!Array.isArray(data.tg?.urgent) || !Array.isArray(data.tg?.topPosts) ||
      !Array.isArray(data.sdr?.zones) || !data.energy || !data.treasury) {
    throw new Error('The API returned an incomplete snapshot.');
  }
  return data;
}

export function sourceQuality(data) {
  const quality = data?.meta?.quality;
  const raw = quality?.counts || quality;
  const keys = ['data', 'no_data', 'unavailable', 'error'];
  if (!raw || !keys.every(key => Number.isSafeInteger(raw[key]) && raw[key] >= 0)) return null;
  const counts = Object.fromEntries(keys.map(key => [key, raw[key]]));
  return { counts, partial: quality.partial === true || counts.unavailable > 0 || counts.error > 0 };
}

export function describeSnapshot(state, now = Date.now()) {
  if (!state.data) return state.error
    ? `Live data unavailable. ${state.error} No snapshot has been loaded.`
    : 'Loading the latest live snapshot…';
  const timestamp = snapshotTimestamp(state.data);
  const age = Math.max(0, now - Date.parse(timestamp));
  const stale = age > STALE_AFTER_MS;
  const quality = sourceQuality(state.data);
  const condition = state.error ? 'UPDATE FAILED · LAST SUCCESSFUL SNAPSHOT' : stale ? 'STALE SNAPSHOT' : 'LIVE SNAPSHOT';
  const ageLabel = age < 60_000 ? '<1 min' : age < 3_600_000 ? `${Math.floor(age / 60_000)} min` : `${Math.floor(age / 3_600_000)} h`;
  const qualityLabel = quality
    ? `${quality.partial ? 'PARTIAL' : 'SOURCE QUALITY'} · ${quality.counts.data} data · ${quality.counts.no_data} no data · ${quality.counts.unavailable} unavailable · ${quality.counts.error} errors`
    : 'SOURCE QUALITY UNKNOWN';
  return `${condition}${stale && state.error ? ' · STALE' : ''} · ${new Date(timestamp).toISOString()} · ${ageLabel} old\n${qualityLabel}${state.error ? `\n${state.error}` : ''}${state.refreshing ? '\nChecking for updates…' : ''}${state.paused ? '\nPolling paused while this tab is hidden.' : '\nChecks every 5 minutes while this tab is visible.'}`;
}

/** Injectable browser dependencies make failure, timing and visibility behavior testable offline. */
export function createLiveClient({
  apiBase = '', fetchImpl = globalThis.fetch?.bind(globalThis), documentRef = globalThis.document,
  now = Date.now, setTimeoutFn = globalThis.setTimeout, clearTimeoutFn = globalThis.clearTimeout,
  pollIntervalMs = POLL_INTERVAL_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS,
  onData = () => {}, onState = () => {},
} = {}) {
  const base = validateApiBase(apiBase);
  let state = { data: null, error: null, refreshing: false, paused: !!documentRef?.hidden, checkedAt: null };
  let started = false;
  let stopped = false;
  let pending = null;
  let pollTimer = null;
  let freshnessTimer = null;
  let controller = null;
  const emit = () => {
    const timestamp = snapshotTimestamp(state.data);
    onState({ ...state, stale: !!timestamp && now() - Date.parse(timestamp) > STALE_AFTER_MS });
  };
  const clearPoll = () => { if (pollTimer !== null) clearTimeoutFn(pollTimer); pollTimer = null; };
  const clearFreshness = () => { if (freshnessTimer !== null) clearTimeoutFn(freshnessTimer); freshnessTimer = null; };
  const scheduleFreshness = () => {
    clearFreshness();
    if (!started || stopped || documentRef?.hidden || !state.data) return;
    // Freshness is reevaluated independently of whether the next request succeeds.
    freshnessTimer = setTimeoutFn(() => { freshnessTimer = null; emit(); scheduleFreshness(); }, 60_000);
  };
  const schedulePoll = () => {
    clearPoll();
    if (!started || stopped || documentRef?.hidden) return;
    pollTimer = setTimeoutFn(() => { pollTimer = null; void refresh(); }, pollIntervalMs);
  };
  function refresh() {
    if (stopped || documentRef?.hidden) return Promise.resolve(null);
    if (pending) return pending; // Retry clicks / visibility changes cannot overlap requests.
    clearPoll();
    state = { ...state, refreshing: true, paused: false };
    emit();
    controller = new AbortController();
    const requestController = controller;
    let timeoutTimer;
    const timeout = new Promise((_, reject) => {
      timeoutTimer = setTimeoutFn(() => {
        requestController.abort();
        reject(new Error('The API request timed out.'));
      }, requestTimeoutMs);
    });
    pending = (async () => {
      try {
        const request = (async () => {
          const response = await fetchImpl(`${base}/api/data`, {
            signal: requestController.signal, cache: 'no-store', credentials: 'omit',
            headers: { Accept: 'application/json' },
          });
          if (!response.ok) throw new Error(`The API returned HTTP ${response.status}.`);
          return validateSnapshot(await response.json());
        })();
        const data = await Promise.race([request, timeout]);
        if (stopped) return null;
        // Render before accepting this as the last successful snapshot.
        onData(data);
        state = { ...state, data, error: null, checkedAt: now() };
        return data;
      } catch (error) {
        if (!stopped) state = { ...state, error: error?.message || 'The API could not be reached.' };
        return null;
      } finally {
        clearTimeoutFn(timeoutTimer);
        controller = null;
        pending = null;
        state = { ...state, refreshing: false, paused: !!documentRef?.hidden };
        if (!stopped) { emit(); schedulePoll(); scheduleFreshness(); }
      }
    })();
    return pending;
  }
  function onVisibilityChange() {
    state = { ...state, paused: !!documentRef?.hidden };
    clearPoll();
    clearFreshness();
    emit();
    if (!documentRef?.hidden) { scheduleFreshness(); void refresh(); }
  }
  return {
    start() {
      if (started || stopped) return pending || Promise.resolve(null);
      started = true;
      state = { ...state, paused: !!documentRef?.hidden };
      documentRef?.addEventListener('visibilitychange', onVisibilityChange);
      emit();
      return refresh();
    },
    refresh,
    getState: () => ({ ...state }),
    stop() {
      stopped = true;
      clearPoll();
      clearFreshness();
      controller?.abort();
      documentRef?.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}

/** Mount status text with textContent, including all API/network error details. */
export function mountLiveDashboard({ apiBase = '', documentRef = document, onData, fetchImpl, now } = {}) {
  const status = documentRef.getElementById('liveStatusText');
  const banner = documentRef.getElementById('liveStatus');
  const boot = documentRef.getElementById('bootLines');
  const retryButtons = [...documentRef.querySelectorAll('[data-live-retry]')];
  const client = createLiveClient({ apiBase, documentRef, onData, fetchImpl, now,
    onState(state) {
      const message = describeSnapshot(state, now ? now() : Date.now());
      if (status) status.textContent = message;
      if (banner) banner.dataset.state = state.error ? 'error' : state.stale ? 'stale' : sourceQuality(state.data)?.partial ? 'partial' : 'live';
      if (!state.data && boot) { boot.textContent = message; boot.style.opacity = '1'; }
      for (const button of retryButtons) {
        button.disabled = state.refreshing;
        button.textContent = state.refreshing ? 'Loading…' : state.error ? 'Retry now' : 'Refresh now';
      }
    },
  });
  for (const button of retryButtons) button.addEventListener('click', () => { void client.refresh(); });
  void client.start();
  return client;
}
