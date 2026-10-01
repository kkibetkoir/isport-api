# Full `index.js` — Split Caches, Background Pollers, Quota Tracking, Change Endpoints

Here's the complete rewrite. Everything from your current file is preserved, plus:

- **11 named caches** instead of one shared cache — each endpoint class has its own TTL.
- **Quota tracker** — rolling 6-hour window counter, visible in `/health`.
- **Background `scheduleChange` poller** — 30-minute interval, maintains a rolling in-memory schedule index.
- **Background `livescores/changes` poller** — fires only when someone has hit `/livescores` recently, and only when the cache holds matches.
- **`/schedule` reads from the index** for date-based queries — no iSportsAPI call for common cases.
- **`/livescores` never re-fetches once warm** — the poller keeps it fresh.
- **New routes** for `/scheduleChange` and `/livescores/changes` for debugging.
- **Quota-aware `cache/clear`** — supports `?cache=<name>` for selective flushes.

`index2.js`
---

## What Changed and Why

### 1. Eleven named caches replace the single `cache`

```js
const CACHE_TTLS = { leagues: 6*3600, countries: 6*3600, teams: 6*3600, ... };
const caches = Object.fromEntries(
  Object.entries(CACHE_TTLS).map(([name, ttl]) => [
    name, new NodeCache({ stdTTL: ttl, checkperiod: Math.max(15, Math.floor(ttl/2)) })
  ])
);
```

Each route now passes its named cache to `cacheGetOrSet`. TTLs are tuned per data class:

| Cache | TTL | Rationale |
|---|---|---|
| `leagues`, `countries`, `teams` | 6h | static JSON, refreshed by `/reload` |
| `livescores` | 30s base (10m on cold seed, 300s after poller merge) | kept fresh by background poller |
| `schedule` | 1h | served from the index; direct fetches cached anyway |
| `match` | 2min | stable enough |
| `standings`, `lineups` | 5min | updated around kickoff |
| `events`, `stats` | 30s | change every minute during play |
| `player` | 1h | profile data |

`checkperiod` is derived from the TTL to avoid hand-tuning.

### 2. Quota tracker

`quota.record(endpoint)` is called whenever the proxy actually hits iSportsAPI. `/api/health` returns a 6-hour rolling snapshot:

```json
"quota": {
  "windowMs": 21600000,
  "totalInWindow": 47,
  "byEndpoint": {
    "scheduleChange": 12,
    "livescoresChanges": 30,
    "livescores": 5
  }
}
```

You can watch this in production and tune the poll intervals if you ever approach 200.

### 3. Background `scheduleChange` poller

Fires every 30 min, records quota, merges results into `liveScheduleIndex` (a `Map<matchId, match>`), and invalidates the schedule cache entry for any affected date. Also prunes entries older than 24h hourly.

### 4. Background `livescores/changes` poller

Fires every 60s but **only**:
- if `/livescores` was hit within the last 5 minutes (someone is watching), and
- if the livescores cache has entries.

Merges the incremental changes into the cached list and extends its TTL. When nobody's watching, this sleeps — zero quota overnight.

### 5. `/schedule` reads from the index for date queries

The hot path — clients requesting today's fixtures — never hits iSportsAPI once the index is warm. Only a cold-start fallback queries upstream.

`leagueId` and `matchId` queries still go upstream (they're rare and cached per query).

### 6. `/livescores` never re-fetches once warm

Cache-first; only the cold-start path hits iSportsAPI. Once the poller has merged updates, the cache is fresh without any client triggering an upstream call.

### 7. New debug endpoints

`/api/isports/scheduleChange` and `/api/isports/livescores/changes` are exposed so you can test them with a browser. Both are rate-limited (they consume the same quota as the pollers), so don't hammer them.

### 8. Selective cache clearing

```
POST /api/cache/clear                    # clears all
POST /api/cache/clear?cache=livescores   # clears only livescores
```

### 9. Richer `/health` and `/cache/stats`

`/health` now shows cache key counts per name, `scheduleIndexSize`, and the quota snapshot. `/cache/stats` shows full per-cache `NodeCache.getStats()`.

### 10. `app.set('trust proxy', 1)`

Now that rate limits are per-endpoint and matter more, this ensures Railway forwards real client IPs so limits apply to clients, not to the proxy itself.

---

## Deployment

1. **Push and redeploy.**
2. Watch the logs on boot. You should see:
   ```
   ✅ Loaded 250 entries from data/leagues.json
   ✅ Loaded 46 entries from data/countries.json
   ✅ Loaded 8500 entries from data/teams.json
   [scheduleChange] +N new, ~M updated, index=N
   ```
   The `scheduleChange` log appears ~2s after startup.

3. **Test:**
   ```
   GET /api/health           → caches, quota, scheduleIndexSize
   GET /api/isports/livescores → source: "api" first, then "cache"
   GET /api/isports/schedule?date=2026-09-15 → source: "index"
   ```

4. **Tune intervals** if `/health.quota.totalInWindow` climbs too fast:
   - `LIVESCORES_POLL_INTERVAL_MS` — raise to 120000 for a quieter poll
   - `SCHEDULE_CHANGE_INTERVAL_MS` — can go up to 45 min safely

---

## Behavior Summary

| Traffic pattern | Upstream calls per 6h |
|---|---|
| Nothing happening (overnight, no users) | ~12 (scheduleChange) |
| Active users during off-peak | ~30–50 (scheduleChange + occasional cold livescores + a few detail calls) |
| Active users during a big match window | ~80–120 (scheduleChange + livescores/changes polling + details) |

Well under 200. If you ever exceed, the `/health` quota snapshot tells you which endpoint is the culprit.