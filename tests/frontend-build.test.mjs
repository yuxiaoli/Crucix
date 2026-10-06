import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPages, buildLiveHtml, validateSourceUrl } from '../scripts/build-pages.mjs';

const sourceUrl = 'https://github.com/example/Crucix/tree/cloud-backend';
const apiBase = 'https://crucix.example.workers.dev';

test('Pages build strips archived data, publishes only static assets, and exposes no environment secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crucix-pages-test-'));
  try {
    const publicDir = join(root, 'dashboard/public');
    await mkdir(publicDir, { recursive: true });
    await writeFile(join(root, 'LICENSE'), 'AGPL-3.0 test fixture');
    await writeFile(join(publicDir, 'jarvis.html'), '<head><!-- CRUCIX_RUNTIME_CONFIG --></head>\n<script>\nlet D = {"newsFeed":["HISTORICAL_SENTINEL"]};\n</script>\n<a data-source-link href="https://old.test">Source</a>');
    await writeFile(join(publicDir, 'live-client.mjs'), '// public module');
    await writeFile(join(publicDir, 'loading.html'), 'legacy loading page');
    await writeFile(join(publicDir, 'latest.json'), '{"should":"never publish snapshots"}');
    await writeFile(join(publicDir, '.env'), 'CLOUDFLARE_API_TOKEN=never-publish');
    await mkdir(join(root, 'output/pages'), { recursive: true });
    await writeFile(join(root, 'output/pages/stale-snapshot.json'), 'previous build residue');
    process.env.FRONTEND_BUILD_SECRET_TEST = 'SECRET_SENTINEL';
    const result = await buildPages({ rootDir: root, apiBase, sourceUrl });
    const files = (await readdir(result.outputDir)).sort();
    assert.deepEqual(files, ['.nojekyll', 'LICENSE', 'index.html', 'live-client.mjs', 'runtime-config.js']);
    const html = await readFile(join(result.outputDir, 'index.html'), 'utf8');
    const config = await readFile(join(result.outputDir, 'runtime-config.js'), 'utf8');
    assert.match(html, /let D = null;/);
    assert.doesNotMatch(html + config, /HISTORICAL_SENTINEL|SECRET_SENTINEL|never-publish/);
    assert.match(html, /\.\/runtime-config.js/);
    assert.ok(html.includes(sourceUrl));
    assert.ok(config.includes(apiBase));
    assert.equal((config.match(/window\./g) || []).length, 2);
  } finally {
    delete process.env.FRONTEND_BUILD_SECRET_TEST;
    await rm(root, { recursive: true, force: true });
  }
});

test('Pages build refuses missing/unsafe configuration and ambiguous inline-data removal', async () => {
  await assert.rejects(buildPages({ apiBase: '', sourceUrl }), /CRUCIX_API_BASE/);
  await assert.rejects(buildPages({ apiBase: 'http://worker.test', sourceUrl }), /HTTPS/);
  await assert.rejects(buildPages({ apiBase, sourceUrl: '' }), /CRUCIX_SOURCE_URL/);
  assert.throws(() => validateSourceUrl('https://user:secret@source.test'), /credentials/);
  assert.throws(() => buildLiveHtml('no data marker', sourceUrl), /exactly one/);
  assert.throws(() => buildLiveHtml('let D = {};\nlet D = {};\n', sourceUrl), /exactly one/);
});

test('actual dashboard builds without the checked-in snapshot', async () => {
  const source = await readFile(new URL('../dashboard/public/jarvis.html', import.meta.url), 'utf8');
  const html = buildLiveHtml(source, sourceUrl);
  assert.match(html, /let D = null;/);
  assert.doesNotMatch(html, /2026-04-03T16:18:10\.188Z/);
  assert.doesNotMatch(html, /let D = \{/);
  assert.match(html, /mountLiveDashboard/);
  assert.equal((html.match(/data-source-link href="https:\/\/github.com\/example\/Crucix/g) || []).length, 2);
});
