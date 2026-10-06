import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildLiveHtml } from '../scripts/build-pages.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {}
const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const available = chromium && existsSync(executablePath);

// No network or real source credentials are needed. An optional local fixture is never published.
test('browser: Pages success, error/retry, retained snapshot, stale state, mobile layout', { skip: !available }, async () => {
  const sourceHtml = await readFile(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
  const html = buildLiveHtml(sourceHtml, 'https://github.com/example/Crucix/tree/cloud-backend');
  const clientModule = await readFile(new URL('../dashboard/public/live-client.mjs', import.meta.url), 'utf8');
  let fixture = {
    meta: { timestamp: new Date().toISOString(), sourcesQueried: 29, sourcesOk: 7, totalDurationMs: 30000,
      quality: { counts: { data: 7, no_data: 9, unavailable: 8, error: 5 }, partial: true } },
    air: [], thermal: [], tSignals: [], chokepoints: [], nuke: [], who: [], fred: [], bls: [], health: [],
    sdr: { total: 0, online: 0, zones: [] }, tg: { posts: 0, urgent: [], topPosts: [] },
    energy: { wti: null, brent: null }, treasury: { totalDebt: null }, newsFeed: [], ideas: [],
  };
  if (process.env.CRUCIX_BROWSER_FIXTURE) {
    const input = JSON.parse(await readFile(process.env.CRUCIX_BROWSER_FIXTURE, 'utf8'));
    fixture = input.data || input;
  }
  const originalTimestamp = fixture.meta.timestamp;
  const server = createServer((request, response) => {
    if (request.url === '/runtime-config.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end('window.CRUCIX_API_BASE = "https://fixture.example.test";'); }
    else if (request.url === '/live-client.mjs') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(clientModule); }
    else if (request.url === '/' || request.url === '/index.html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(html); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const localUrl = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const output = fileURLToPath(new URL('../output/frontend-qa/', import.meta.url));
  await mkdir(output, { recursive: true });
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    let fail = false;
    const requests = [];
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url === 'https://fixture.example.test/api/data') {
        requests.push(url);
        return route.fulfill({ status: fail ? 503 : 200, contentType: 'application/json', body: JSON.stringify(fail ? { error: 'Unavailable' } : fixture) });
      }
      if (url.startsWith(localUrl)) return route.continue();
      // Offline QA also checks that unavailable map/CDN libraries cannot block the data UI.
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(localUrl);
    await page.locator('#liveStatusText').filter({ hasText: originalTimestamp }).waitFor();
    const counts = fixture.meta.quality.counts;
    assert.ok((await page.locator('#liveStatusText').innerText()).includes(`${counts.data} data · ${counts.no_data} no data · ${counts.unavailable} unavailable · ${counts.error} errors`));
    assert.equal(await page.locator('#boot').isVisible(), false);
    assert.equal(await page.locator('#main').evaluate(el => getComputedStyle(el).opacity), '1');
    assert.equal(requests.length, 1);
    await page.screenshot({ path: `${output}/desktop-success.png`, fullPage: true });

    fail = true;
    await page.locator('#liveStatus [data-live-retry]').click();
    await page.locator('#liveStatusText').filter({ hasText: 'UPDATE FAILED' }).waitFor();
    assert.match(await page.locator('#liveStatusText').innerText(), /LAST SUCCESSFUL SNAPSHOT/);
    assert.ok((await page.locator('#liveStatusText').innerText()).includes(originalTimestamp));
    assert.equal(await page.locator('#main').evaluate(el => getComputedStyle(el).opacity), '1');
    await page.screenshot({ path: `${output}/desktop-refresh-error.png`, fullPage: true });

    await page.reload();
    await page.locator('#bootLines').filter({ hasText: 'HTTP 503' }).waitFor();
    assert.equal(await page.locator('#topbar').innerText(), '');
    assert.equal(await page.locator('#main').evaluate(el => getComputedStyle(el).opacity), '0');
    assert.doesNotMatch(await page.locator('body').innerText(), /2026-04-03T16:18:10/);
    await page.screenshot({ path: `${output}/initial-error.png` });

    fail = false;
    await page.locator('#boot [data-live-retry]').click();
    await page.locator('#liveStatusText').filter({ hasText: originalTimestamp }).waitFor();
    assert.equal(await page.locator('#boot').isVisible(), false);
    fixture = structuredClone(fixture);
    fixture.meta.timestamp = new Date(Date.now() - 4 * 3600_000).toISOString();
    await page.locator('#liveStatus [data-live-retry]').click();
    await page.locator('#liveStatusText').filter({ hasText: 'STALE SNAPSHOT' }).waitFor();
    assert.equal(await page.locator('#liveStatus').getAttribute('data-state'), 'stale');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.locator('#liveStatusText').filter({ hasText: 'STALE SNAPSHOT' }).waitFor();
    assert.equal(await page.locator('#boot').isVisible(), false);
    const statusBox = await page.locator('#liveStatus').boundingBox();
    assert.ok(statusBox.x >= 0 && statusBox.x + statusBox.width <= 391);
    const retryBox = await page.locator('#liveStatus [data-live-retry]').boundingBox();
    assert.ok(retryBox.x >= 0 && retryBox.x + retryBox.width <= 391);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${output}/mobile-stale.png`, fullPage: true });
    assert.deepEqual(errors, [], `Unexpected browser exceptions: ${errors.join('; ')}`);
    await context.close();
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
