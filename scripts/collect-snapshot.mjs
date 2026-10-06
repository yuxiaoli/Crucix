import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createSnapshot, encodeSnapshot } from '../lib/snapshot/index.mjs';

const output = resolve('output/snapshot.json');
const lockPath = resolve('output/collector.lock');
await mkdir(dirname(output), { recursive: true });
let lock;
let timer;
try {
  lock = await open(lockPath, 'wx');
  // Do not let the one-shot collector inherit bot/paid-provider or source secrets.
  const forbidden = /^(CF_.*TOKEN$|LLM_|TELEGRAM_BOT_TOKEN$|TELEGRAM_CHAT_ID$|DISCORD_|OPENAI_OAUTH_TOKEN$|CODEX_ACCESS_TOKEN$|FRED_API_KEY$|FIRMS_MAP_KEY$|EIA_API_KEY$|AISSTREAM_API_KEY$|ACLED_|ADSB_API_KEY$|BLS_API_KEY$|CLOUDFLARE_API_TOKEN$|REDDIT_CLIENT_|RAPIDAPI_KEY$)/;
  if (Object.entries(process.env).some(([key, value]) => value && forbidden.test(key))) throw new Error('Collector must run without source, LLM, bot, or publisher credentials');
  if (existsSync('.env') || existsSync('apis/.env')) throw new Error('Collector refuses project .env files; use a clean checkout');
  timer = setTimeout(() => { console.error('Collection exceeded 120 seconds; existing KV snapshot unchanged'); process.exit(1); }, 120_000);
  const inputArg = process.argv.indexOf('--input');
  const offline = inputArg >= 0;
  if (offline && !process.argv[inputArg + 1]) throw new Error('--input requires a raw briefing JSON path');
  const raw = offline ? JSON.parse(await readFile(process.argv[inputArg + 1], 'utf8')) : await (await import('../apis/briefing.mjs')).fullBriefing();
  const { synthesize } = await import('../dashboard/inject.mjs');
  const data = await synthesize(raw, { offline, disableFallback: true });
  const snapshot = createSnapshot(raw, data);
  await writeFile(output + '.tmp', encodeSnapshot(snapshot));
  await rename(output + '.tmp', output);
  console.log(JSON.stringify({ output, timestamp: snapshot.data.meta.timestamp, quality: snapshot.data.meta.quality.counts, bytes: Buffer.byteLength(encodeSnapshot(snapshot)), published: false }));
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Collector already running; no overlapping collection' : error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  if (lock) { await lock.close(); await unlink(lockPath); }
}
// Some upstream timed-out fetch promises remain active. The one-shot never becomes a daemon.
process.exit(process.exitCode || 0);
