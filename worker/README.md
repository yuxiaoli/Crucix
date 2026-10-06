# Read-only snapshot Worker

This Worker serves a public, cached Crucix snapshot. It has no publisher route,
cron, tokens, SSE endpoint, or upstream collectors. The sole KV operation is
`CRUCIX_SNAPSHOTS.get('snapshot:v1', { type: 'stream', cacheTtl: 300 })`.

## Storage contract

The publisher writes this envelope as UTF-8 JSON (maximum **2 MiB**, including
the envelope):

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-06T08:00:00.000Z",
  "data": {
    "meta": {
      "timestamp": "2026-10-06T07:55:00.000Z",
      "quality": {
        "counts": { "data": 1, "no_data": 0, "unavailable": 0, "error": 0 },
        "total": 1,
        "partial": false,
        "sources": [
          { "name": "Example", "state": "data", "reason": "Observations returned" }
        ],
        "policy": "conservative-observations-v1"
      }
    }
  }
}
```

`data` is the complete existing Crucix dashboard object, not just the example's
`meta`. `meta.timestamp` is the source sweep time; synthesizing or uploading an
old sweep does not make it fresh. `generatedAt` is separately reported and must
be a canonical UTC ISO timestamp. The Worker checks quality source counts and
states. Missing/invalid snapshot content, invalid UTF-8, oversized bodies,
missing binding, and KV failures return a generic `503` without exception text.

Empty, unavailable, or failing sources must not be interpreted as “no events.”
The data response preserves the publisher's complete `meta.quality`.

## HTTP contract

| Route | Methods | Result |
| --- | --- | --- |
| `/api/data` | GET / HEAD | Exactly `snapshot.data`; no envelope or synthetic live stream |
| `/api/health` | GET / HEAD | `ok`, `status`, `timestamp`, `generatedAt`, `ageSeconds`, `stale`, `staleAfterSeconds`, `quality`, `consistency`, `cacheTtlSeconds` |
| Either route | OPTIONS | Restricted CORS preflight; does not access KV |

Other routes return `404`; mutation methods on known routes return `405`.
`/api/events`, `/api/refresh`, and `/api/publish` do not exist. A valid but stale
snapshot remains readable with HTTP `200`; health uses `ok: false` and
`status: "stale"`. Monitoring must inspect the health body, not only HTTP status.
Fresh partial coverage uses `ok: false` and `status: "degraded"`.

The stale threshold is **strictly greater than 3 hours** after `meta.timestamp`.
Both data and health expose current `X-Snapshot-Timestamp`,
`X-Snapshot-Generated-At`, `X-Snapshot-Age-Seconds`, and `X-Snapshot-Stale` headers.
HEAD and conditional `304` responses preserve these headers and have no body.
ETags support `If-None-Match`, including weak comparisons and lists. Health's
validator changes with age and staleness, independently of the data validator.

## Browser access

Only the exact Origin `https://yuxiaoli.github.io` is accepted. Origins with
extra paths, ports, suffixes, `null`, or other hosts are rejected **before** any
KV or cache read. Requests without Origin remain permitted for server probes.
No wildcard or credentialed CORS is emitted. Preflights permit GET/HEAD and
Accept, Content-Type, If-None-Match; authorization/publisher headers are denied.

CORS is a browser control, **not authentication or abuse protection**. The
snapshot is public; other clients can omit Origin. Do not publish secrets or
private user information. Production quota protection may require separately
authorized account-level rate limiting; this implementation creates no such
resources or paid services.

## Cache behavior and limits

- Successful data and a compact health representation share one KV read and a
  **300-second** edge Cache API lifetime. Queries and request headers never form
  part of the key, and HEAD shares GET's cache. `?nonce=...` cannot bypass it.
- A warm data hit streams the cached JSON body without parsing the full
  snapshot. Health parses only compact quality metadata.
- Short-lived per-isolate memoization and coalesced pending reads reduce duplicate
  reads. If the Cache API is unavailable, the same 300-second memo remains usable.
  Failed reads have a 30-second per-isolate negative memo.
- The browser response requires revalidation (`max-age=0, must-revalidate`) so
  age/staleness headers remain current, while the internal edge representations
  remain cached for 300 seconds. Staleness is recomputed on every request.
- Cache API entries are per Cloudflare location. KV is **eventually consistent**;
  its own 300-second read cache and edge caching may delay new snapshots. There
  is no promise of immediate propagation or a global single read per 5 minutes.
- No stale-while-revalidate loop, external fetch, or unbounded KV key lookup exists.
  The stream is cancelled once the raw snapshot exceeds 2 MiB. Parsing and
  hashing happen only on cache misses. Actual Free-tier CPU/quota suitability
  still needs measurement using realistic payloads in the deployed account.

Cloudflare references: [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/),
[KV reads](https://developers.cloudflare.com/kv/api/read-key-value-pairs/).

## Local verification and later deployment

From the repository root:

```sh
node --test tests/worker*.mjs
node --check worker/src/index.mjs
```

Tests use built-in Node Web APIs plus fake KV/Cache bindings; they make no network
calls and require no Cloudflare account. Node 22+ is expected by the project.
They are not a production Cloudflare runtime or quota benchmark.

`wrangler.jsonc` is intentionally a **template** with an invalid namespace ID.
No account, namespace, token, secret, resource, or deployment is created here.
Before a separately authorized deployment, copy it to an ignored local config
or render an ephemeral config and fill in the authorized namespace ID. Keep
publisher credentials in the publishing environment, never in Worker vars,
frontend code, or the checked-in config. Do not add a token to browser requests.
