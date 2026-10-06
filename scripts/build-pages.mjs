#!/usr/bin/env node
/** Build a data-free, credential-free static frontend for GitHub Pages. */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateApiBase } from '../dashboard/public/live-client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_ASSET_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf']);
const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function validateSourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('CRUCIX_SOURCE_URL must point to the HTTPS source for this deployment.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('CRUCIX_SOURCE_URL must be HTTPS without credentials, query parameters, or a fragment.');
  }
  return url.href;
}

export function buildLiveHtml(sourceHtml, sourceUrl) {
  const assignments = sourceHtml.match(/^(?:let|const) D = [^\r\n]*;\s*$/gm) || [];
  if (assignments.length !== 1) throw new Error('Expected exactly one inline dashboard data assignment; refusing to publish.');
  let html = sourceHtml.replace(/^(?:let|const) D = [^\r\n]*;\s*$/m, 'let D = null;');
  if (!html.includes('<!-- CRUCIX_RUNTIME_CONFIG -->')) throw new Error('Missing runtime configuration insertion point.');
  html = html.replace('<!-- CRUCIX_RUNTIME_CONFIG -->', '<script src="./runtime-config.js"></script>');
  html = html.replace(/(<a data-source-link href=")[^"]*(")/g, (_, prefix, suffix) => prefix + escapeAttribute(sourceUrl) + suffix);
  return html;
}

async function copyAssets(sourceDir, outputDir) {
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const source = join(sourceDir, entry.name);
    const destination = join(outputDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destination, { recursive: true });
      await copyAssets(source, destination);
    } else if (entry.isFile() && PUBLIC_ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase()) && entry.name !== 'runtime-config.js') {
      await cp(source, destination);
    }
  }
}

export async function buildPages({
  rootDir = ROOT,
  apiBase = process.env.CRUCIX_API_BASE,
  sourceUrl = process.env.CRUCIX_SOURCE_URL,
} = {}) {
  if (!apiBase) throw new Error('Set CRUCIX_API_BASE to the public HTTPS Worker URL.');
  const validatedBase = validateApiBase(apiBase);
  const validatedSource = validateSourceUrl(sourceUrl);
  const publicDir = join(rootDir, 'dashboard', 'public');
  const outputDir = join(rootDir, 'output', 'pages');
  // Validate all inputs before removing any previous generated output.
  const html = buildLiveHtml(await readFile(join(publicDir, 'jarvis.html'), 'utf8'), validatedSource);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await copyAssets(publicDir, outputDir);
  await writeFile(join(outputDir, 'index.html'), html);
  // These are intentionally the only two public configuration fields. Never serialize process.env.
  const runtime = `window.CRUCIX_API_BASE = ${JSON.stringify(validatedBase)};\nwindow.CRUCIX_SOURCE_URL = ${JSON.stringify(validatedSource)};\n`;
  await writeFile(join(outputDir, 'runtime-config.js'), runtime);
  await cp(join(rootDir, 'LICENSE'), join(outputDir, 'LICENSE'));
  await writeFile(join(outputDir, '.nojekyll'), '');
  return { outputDir, apiBase: validatedBase, sourceUrl: validatedSource };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildPages();
    console.log(`Built live Pages frontend: ${result.outputDir}`);
    console.log(`API: ${result.apiBase}\nSource: ${result.sourceUrl}`);
  } catch (error) {
    console.error(`Pages build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
