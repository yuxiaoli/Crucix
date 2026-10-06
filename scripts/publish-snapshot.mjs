import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SNAPSHOT_KEY, validateSnapshot } from '../lib/snapshot/index.mjs';
export async function publishSnapshot(snapshot, { accountId, namespaceId, token, fetchFn = fetch, dryRun = true } = {}) {
  const body = validateSnapshot(snapshot);
  if (dryRun) return { published: false, dryRun: true, bytes: Buffer.byteLength(body), key: SNAPSHOT_KEY };
  if (!/^[a-f\d]{32}$/i.test(accountId || '') || !/^[a-f\d]{32}$/i.test(namespaceId || '') || !token) throw new Error('Explicit Cloudflare account, dedicated namespace and token are required');
  // Exactly one PUT, no retries, list calls or per-source writes. Workflow concurrency serializes writes.
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(SNAPSHOT_KEY)}`;
  const response = await fetchFn(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`KV publication failed (HTTP ${response.status}); no retry attempted`);
  const result = await response.json();
  if (result.success !== true) throw new Error('KV did not confirm publication; verify before retry');
  return { published: true, bytes: Buffer.byteLength(body), key: SNAPSHOT_KEY, timestamp: snapshot.data.meta.timestamp };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const snapshot = JSON.parse(await readFile('output/snapshot.json', 'utf8'));
    console.log(JSON.stringify(await publishSnapshot(snapshot, { accountId: process.env.CF_ACCOUNT_ID, namespaceId: process.env.CF_KV_NAMESPACE_ID, token: process.env.CF_KV_API_TOKEN, dryRun: !process.argv.includes('--publish') })));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
