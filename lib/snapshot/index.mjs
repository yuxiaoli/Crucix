// Conservative observations, not transport-success counts. Empty feeds do not imply safety.
export const SNAPSHOT_KEY = 'snapshot:v1';
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const fields = {
  GDELT: ['allArticles', 'geoPoints'], OpenSky: ['hotspots'], FIRMS: ['hotspots'],
  Maritime: ['vessels'], Safecast: ['sites', 'readings', 'measurements'], ACLED: ['events', 'deadliestEvents'],
  ReliefWeb: ['reports', 'hdxDatasets'], WHO: ['diseaseOutbreakNews'], OFAC: ['sampleEntries'],
  OpenSanctions: ['entities'], 'ADS-B': ['militaryAircraft'], FRED: ['indicators', 'series'],
  Treasury: ['debt', 'interestRates'], BLS: ['indicators'], EIA: ['series'], GSCPI: ['history'],
  USAspending: ['recentDefenseContracts', 'topAgencies'], Comtrade: ['tradeFlows'],
  NOAA: ['topAlerts'], EPA: ['readings'], Patents: ['recentPatents'], Bluesky: ['topics'],
  Reddit: ['posts', 'subreddits'], Telegram: ['topPosts', 'urgentPosts'], KiwiSDR: ['topActive'],
  Space: ['recentLaunches', 'spaceStations', 'militarySatellites'], YFinance: ['quotes'],
  'CISA-KEV': ['vulnerabilities'], 'Cloudflare-Radar': ['outages.activeEvents', 'anomalies.events'],
};
const at = (o, path) => path.split('.').reduce((v, k) => v?.[k], o);
function observations(value) {
  if (Array.isArray(value)) return value.filter(v => v && !v.error).length;
  if (value && typeof value === 'object') return Object.values(value).reduce((n, v) => n + (Array.isArray(v) ? observations(v) : (v && typeof v === 'object' && !v.error && Number.isFinite(v.price)) ? 1 : 0), 0);
  return 0;
}
export function assessQuality(raw) {
  const names = [...new Set([...Object.keys(raw.timing || {}), ...Object.keys(raw.sources || {}), ...(raw.errors || []).map(e => e.name)])];
  const counts = { data: 0, no_data: 0, unavailable: 0, error: 0 };
  const sources = names.map(name => {
    const source = raw.sources?.[name];
    const failure = (raw.errors || []).find(e => e.name === name);
    let state = 'no_data';
    let reason = 'No verified observation records returned; absence is not evidence of no events.';
    if (failure || !source) { state = 'error'; reason = 'Source failed or timed out.'; }
    else if (/no_key|no_credentials|limited/.test(source.status || '') || /no .*key|set .*key|credentials/i.test(source.error || '')) { state = 'unavailable'; reason = 'Optional credentials absent or source limited.'; }
    else if (source.error || /^(error|failed)$/.test(source.status || '')) { state = 'error'; reason = 'Source returned an error.'; }
    else if ((name === 'OpenSky' ? source.hotspots?.some(h => h.totalAircraft > 0) : (fields[name] || []).some(path => observations(at(source, path)) > 0))) {
      state = 'data'; reason = 'Non-empty observation records returned; not independently verified.';
    }
    const warnings = Object.entries(source || {}).filter(([key, value]) => /error$/i.test(key) && value).map(([key]) => key);
    if (name === 'KiwiSDR' && source?.status === 'active' && source?.network?.totalReceivers > 0 && Object.values(source.conflictZones || {}).some(z => observations(z.receivers) > 0)) {
      state = 'data'; reason = 'Receiver directory entries returned; online status and utilization are not measured.';
      warnings.push('directory_only_online_unverified');
    }
    counts[state]++;
    return { name, state, reason, ...(warnings.length ? { warnings } : {}) };
  });
  return { counts, total: names.length, partial: counts.data !== names.length || sources.some(s => s.warnings), sources, policy: 'conservative-observations-v1' };
}
export function createSnapshot(raw, data, { now = Date.now(), minSources = 3 } = {}) {
  const timestamp = raw.crucix?.timestamp;
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms) || ms > now + 60_000 || now - ms > 2 * 3600_000) throw new Error('Raw snapshot timestamp invalid, future, or older than two hours');
  const quality = assessQuality(raw);
  if (quality.counts.data < minSources) throw new Error(`Insufficient usable sources (${quality.counts.data}/${minSources}); preserve previous KV snapshot`);
  const snapshot = { schemaVersion: 1, generatedAt: new Date(now).toISOString(), data: {
    ...data, sdr: data.sdr ? { ...data.sdr, online: null, directoryOnly: true } : undefined, health: quality.sources.map(s => ({ n: s.name, err: s.state !== 'data' || Boolean(s.warnings?.length), stale: false, state: s.state })), ideas: [], ideasSource: 'disabled', meta: { ...data.meta, timestamp, quality,
      sourcesOk: quality.counts.data, sourcesFailed: quality.counts.error,
      sourcesQueried: quality.total, sourcesUnavailable: quality.counts.unavailable,
      sourcesEmpty: quality.counts.no_data, collectionMode: 'github-actions-kv-hourly',
      generatedAt: new Date(now).toISOString(), staleAfterSeconds: 10800 },
  }};
  encodeSnapshot(snapshot);
  return snapshot;
}
export function encodeSnapshot(snapshot) {
  const body = JSON.stringify(snapshot);
  if (Buffer.byteLength(body, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error('Snapshot exceeds conservative 2 MiB limit; previous KV snapshot preserved');
  return body;
}
export function validateSnapshot(snapshot, now = Date.now()) {
  const timestamp = Date.parse(snapshot?.data?.meta?.timestamp);
  if (snapshot?.schemaVersion !== 1 || !Number.isFinite(Date.parse(snapshot.generatedAt)) || !Number.isFinite(timestamp) || timestamp > now + 60_000 || now - timestamp > 2 * 3600_000 || !Number.isInteger(snapshot.data?.meta?.quality?.counts?.data) || snapshot.data.meta.quality.counts.data < 3) throw new Error('Invalid, stale, or insufficient snapshot');
  return encodeSnapshot(snapshot);
}
