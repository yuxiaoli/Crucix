# Crucix live snapshots: Actions → KV → read-only Worker → GitHub Pages

This fork adds an hourly-snapshot architecture. It is not a continuous Express deployment. No Cloudflare resource or credential is created by these files. Hourly cadence is approved and configured at minute 17 UTC, but scheduled jobs remain inert until `CRUCIX_PUBLISH_ENABLED=true` is explicitly set after resources and credentials are approved. Manual publication defaults to dry-run.

## Data contract and quality

A clean Actions checkout runs `npm run snapshot:collect`, which imports the existing one-shot public sources and synthesizer, not `server.mjs`. No LLM, notification bots, paid sources, historical run fallback, or source credentials are used. Both project `.env` files and recognized provider/source credentials cause collection to fail. The collection stage never receives the Cloudflare publisher token.

Only `snapshot:v1` is stored, as `{schemaVersion:1, generatedAt, data}`. `data` is the existing dashboard format with `meta.timestamp` (collection time) and `meta.quality`. The timestamp is not a claim that all upstream economic observations or articles were produced at that time. Individual items retain their upstream dates where available.

Quality states are conservative: `data` means identifiable non-empty observation records; `no_data` means no verified records, including empty feeds; `unavailable` means missing credentials/limited access; `error` means failed, timed out or an error response. None independently guarantees data accuracy. Empty/unavailable is not proof of no events or safety. Upstream transport success counts are replaced. Source panel health flags reflect degraded states. New source payload shapes may be undercounted until the observation classifier is extended.

Partial results publish only with at least 3 sources containing observations. They replace the full snapshot rather than mixing old/new per-source values. Failure, timeout, invalid timestamp (future or older than 2 hours), insufficient quality, or size above 2 MiB stops before KV. The previously published snapshot stays available and becomes visibly stale after 3 hours. Collection is hard-bounded to 120 seconds; the workflow to 5 minutes. A local exclusive lock plus Actions publisher concurrency prevents overlapping runs. An interrupted local run may leave `output/collector.lock`; confirm no collector is running before manually removing that lock. GitHub jobs use fresh workspaces.

Publication makes exactly one KV PUT without automatic retry. There is no history key, list/delete, notification, or unbounded write loop. Failed/uncertain PUTs require verification before retry. Do not run independent publishers against the same key; workflow concurrency is not a distributed lock across other systems.

## Setup after resource/credential approval

1. Confirm the Cloudflare account is on Workers Free and has sufficient remaining shared KV/Worker quota. Do not upgrade plans.
2. Create a new dedicated namespace named `crucix-live`; do not reuse another project's namespace.
3. Deploy `worker/src/index.mjs` using the supplied worker configuration template and bind `CRUCIX_SNAPSHOTS` to that namespace. Follow `worker/README.md` for exact configuration. No Worker secret is needed to read its KV binding.
4. Create a dedicated publisher token with **Account → Workers KV Storage → Edit**, restricted to the selected account. Do not grant Workers Scripts, DNS or zone permissions to this runtime token. Traditional Cloudflare KV API tokens are account-scoped; do not claim a hard namespace security boundary unless the actual token configuration supports one. If namespace-limited grants are unavailable, this token can reach other KV namespaces in that account: obtain approval for that scope, or use a separate account. The code targets only the explicit Crucix namespace, which is an application safeguard, not token isolation.
5. Store the token only as GitHub Actions secret `CF_KV_API_TOKEN` in `yuxiaoli/Crucix` after approval. This is persistent access and must be separately approved. Never paste it into chat, commit it, put it in frontend files, or reuse an existing project's token. Configure non-secret repository variables `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`, `CRUCIX_API_BASE` (verified HTTPS Worker origin), and after approval `CRUCIX_PUBLISH_ENABLED=true`.
6. Run `Collect public snapshot to KV` manually, first with `publish=false`, then with `publish=true` when authorized. Verify `/api/health` and `/api/data` from the deployed Worker and verify CORS for `https://yuxiaoli.github.io`. KV is eventually consistent; allow propagation and the 300-second cache window.
7. Enable GitHub Pages source **GitHub Actions**, then manually dispatch `Deploy live Pages frontend`. The Pages artifact contains HTML/assets, license and a public API URL only, not secrets or a bundled snapshot. The collector needs `contents:read`; the Pages deployment alone needs `pages:write` and `id-token:write`. No new personal GitHub token is needed for runtime deployment: use the job's `GITHUB_TOKEN`.
8. After authorized resources, credentials and a successful first publication, enable `CRUCIX_PUBLISH_ENABLED=true` to activate `17 * * * *` (hourly, UTC). GitHub schedules run from the default branch, may be delayed, and are not precise timers. Ensure the workflow is on the intended default branch before enabling it. Do not publish the unrelated archival frontend.

A setup/deployment operator separately needs permission to create the namespace and deploy the Worker (KV Storage Edit and applicable Workers Scripts/Worker Editor permissions). These broader setup permissions must not be stored in the collector workflow. A public workers.dev deployment avoids custom DNS/zone permissions. Exact modern resource-scoped role support must be verified in the selected account.

## Frontend behavior

All HTTP loads fetch the configured API before rendering. The bundled April snapshot is removed from generated Pages output. Initial failure displays an error, not archival data. Poll every 5 minutes while visible, with no overlap; resume on visibility. Subsequent errors keep the last successfully fetched data with a visible warning. Snapshot age and quality are shown, and older-than-3-hours data is marked stale. File-mode archive behavior, where present in source, is explicitly labeled.

The Worker offers GET/HEAD `/api/data` and `/api/health`, conditional ETags and an exact-origin Pages CORS policy. No write endpoint, SSE, credential relay or browser KV access exists. CORS does not authenticate readers: absent-Origin server clients can still read this intentionally public dataset. A 300-second canonical edge cache ignores query strings to reduce accidental KV amplification, but public request abuse can still exhaust a free quota. Edge caches are per location, not a global read guarantee.

## Free-tier budget (verified 2026-10-06)

At hourly cadence: about **24 writes/day**, one key, at most **2 MiB storage**, no list/deletes. Free KV includes 1,000 writes/day, 100,000 reads/day and 1 GB storage. Workers Free includes 100,000 requests/day and 10 ms CPU per invocation. Read/request budgets are shared account-wide and may be consumed by other projects. A tab polling every 5 minutes makes about 288 data requests/day while continuously visible; caching reduces KV reads but not necessarily Worker requests. Exceeding free quotas causes failures; this setup must not upgrade to paid. Free-tier runtime CPU still needs deployed validation.

Standard GitHub-hosted runners in a public repository are free. Avoid larger/paid runners, artifact retention of raw feeds, and package/image publishing. The existing upstream Docker workflow remains unrelated and should not be triggered just to publish this frontend.

Sources: [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/), [Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/), [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Local verification

```
npm ci --omit=optional --ignore-scripts --no-audit --no-fund
npm test
node scripts/collect-snapshot.mjs --input runs/latest.json  # offline synthesis, requires recent actual raw data
npm run snapshot:check                                 # dry-run, no Cloudflare request
CRUCIX_API_BASE=https://verified-worker.example CRUCIX_SOURCE_URL=https://github.com/yuxiaoli/Crucix npm run pages:build
```

`npm run snapshot:collect` makes one real public-source sweep but never publishes. `node scripts/publish-snapshot.mjs --publish` is the explicit external-write command and requires approved credentials. Preserve AGPL notices and publish corresponding modified source alongside the public service.
