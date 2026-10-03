const express = require('express');
const NodeCache = require('node-cache');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway's proxy so rate limiting keys on real client IPs.
app.set('trust proxy', 1);

// ============ MIDDLEWARE ============
app.use(cors());
app.use(compression());
app.use(express.json());

// ============ CONFIGURATION ============
const CONFIG = {
  isports: {
    baseUrl: 'https://api.isportsapi.com',
    apiKey: process.env.ISPORTS_API_KEY || 'ycOrrj2NLYdzuOBr',
  },
  leagueLogo: {
    ttlMs: 6 * 60 * 60 * 1000,
    emptyTtlMs: 30 * 60 * 1000,
    concurrency: 10,
  },
};

// ============ CACHES ============
// One NodeCache instance per data class, so each has its own TTL and can
// be flushed independently.
const CACHE_TTLS = {
  // Local JSON — essentially static.
  leagues: 6 * 60 * 60,
  countries: 6 * 60 * 60,
  teams: 6 * 60 * 60,

  // Live data — short TTLs.
  livescores: 30,

  // Schedule is refreshed by the background poller, so TTL is generous.
  schedule: 60 * 60, // 1 hour

  // Match detail / standings / lineups.
  match: 120,
  standings: 5 * 60,
  lineups: 5 * 60,
  h2h: 24 * 60 * 60,   // analysis data is cached 24h upstream; match that

  // Events / stats change every minute during a match.
  events: 30,
  stats: 30,

  // Player profile is basically static.
  player: 60 * 60,
};

const caches = Object.fromEntries(
  Object.entries(CACHE_TTLS).map(([name, ttl]) => [
    name,
    new NodeCache({
      stdTTL: ttl,
      checkperiod: Math.max(15, Math.floor(ttl / 2)),
    }),
  ])
);

// ============ QUOTA TRACKER ============
// iSportsAPI plan resets every 6 hours (empirically). Track rolling usage
// so /health can show it. Informational only — does not itself throttle.
const quota = (() => {
  const WINDOW_MS = 6 * 60 * 60 * 1000;
  const events = [];

  function prune() {
    const cutoff = Date.now() - WINDOW_MS;
    while (events.length && events[0].t < cutoff) events.shift();
  }

  return {
    record(endpoint) {
      events.push({ t: Date.now(), endpoint });
      prune();
    },
    snapshot() {
      prune();
      const byEndpoint = {};
      for (const e of events) {
        byEndpoint[e.endpoint] = (byEndpoint[e.endpoint] || 0) + 1;
      }
      return {
        windowMs: WINDOW_MS,
        totalInWindow: events.length,
        byEndpoint,
      };
    },
  };
})();

// ============ LOCAL DATA LOADER ============
function loadJsonArray(filename) {
  const filePath = path.join(__dirname, 'data', filename);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      console.log(`✅ Loaded ${parsed.length} entries from data/${filename}`);
      return parsed;
    }
    if (parsed && Array.isArray(parsed.data)) {
      console.log(
        `✅ Loaded ${parsed.data.length} entries from data/${filename}`
      );
      return parsed.data;
    }
    console.warn(`⚠️  data/${filename} is not an array or {data:[...]} envelope`);
    return [];
  } catch (err) {
    console.warn(`⚠️  Failed to load data/${filename}:`, err.message);
    return [];
  }
}

let LOCAL_LEAGUES = [];
let LOCAL_COUNTRIES = [];
let LOCAL_TEAMS = [];

function loadAllLocalData() {
  LOCAL_LEAGUES = loadJsonArray('leagues.json');
  LOCAL_COUNTRIES = loadJsonArray('countries.json');
  LOCAL_TEAMS = loadJsonArray('teams.json');
}

loadAllLocalData();

let TEAM_BY_ID = new Map();
function rebuildTeamIndex() {
  TEAM_BY_ID = new Map();
  for (const t of LOCAL_TEAMS) {
    if (t && t.teamId != null) {
      TEAM_BY_ID.set(String(t.teamId), t);
    }
  }
}
rebuildTeamIndex();

// ============ ISPOPRTS API SERVICE ============
class ISportsService {
  constructor() {
    this.baseUrl = CONFIG.isports.baseUrl;
    this.apiKey = CONFIG.isports.apiKey;
  }

  buildUrl(path, params = {}) {
    const url = new URL(this.baseUrl + path);
    url.searchParams.set('api_key', this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  async fetchWithTimeout(url, timeout = 20000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      const text = await response.text();

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
      }

      if (json.code !== 0 && json.code !== '0') {
        throw new Error(
          `iSportsAPI error ${json.code}: ${json.message || 'unknown'}`
        );
      }

      return json.data;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  // ============ MATCHES ============
  async getLiveScores() {
    return this.fetchWithTimeout(this.buildUrl('/sport/football/livescores'));
  }

  async getLivescoresChanges() {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/livescores/changes')
    );
  }

  async getSchedule({ date, leagueId, matchId, season, subLeagueId, stageId } = {}) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/schedule', {
        date,
        leagueId,
        matchId,
        season,
        subLeagueId,
        stageId,
      })
    );
  }

  async getScheduleChange() {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/scheduleChange')
    );
  }

  async getMatchDetail(matchId) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/match', { matchId })
    );
  }

  // ============ TEAMS ============
  async getTeamLogosByLeague(leagueId) {
    const raw = await this.fetchWithTimeout(
      this.buildUrl('/sport/football/team', { leagueId })
    );
    if (!Array.isArray(raw)) return {};
    const map = {};
    for (const t of raw) {
      if (t && t.teamId != null) {
        map[String(t.teamId)] = t.logo ?? '';
      }
    }
    return map;
  }

  async getTeamDetail(teamId) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/team/detail', { teamId })
    );
  }

  // ============ STANDINGS ============
  async getStandings(leagueId) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/standing/league', { leagueId })
    );
  }

  // ============ LINEUPS ============
  async getLineups(matchId) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/lineups', { matchId })
    );
  }

  // ============ EVENTS ============
  async getMatchEvents(matchId) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/events', { matchId })
    );
  }

  async getMatchStats(matchId) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/events/stats', { matchId })
    );
  }

    // ============ H2H ============
  /**
 * Match analysis. Returns head-to-head + recent form + more.
 * iSportsAPI limits to 1s/call, recommends 1/day.
 * @param {string} matchId
 */
async getAnalysis(matchId) {
  return this.fetchWithTimeout(
    this.buildUrl('/sport/football/analysis', { matchId })
  );
}

  // ============ PLAYERS ============
  async getPlayerDetail(playerId) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/player', { playerId })
    );
  }

  /**
 * Top scorers for a league. iSportsAPI limits to 10s/call, recommends 1/day.
 * @param {object} params
 * @param {string} params.leagueId  required
 * @param {string} [params.season]  only with leagueId
 */
  async getTopScorers({ leagueId, season } = {}) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/topscorer', { leagueId, season }),
      30000
    );
  }

  /**
   * Player lookup. Exactly one of `teamId`, `playerId`, or `day` is required.
   * @param {object} params
   * @param {string} [params.teamId]     up to 50 ids, comma-separated
   * @param {string} [params.playerId]
   * @param {string} [params.day]        updated within last N days
   * @param {string} [params.cmd]        "more" for extended data
   */
  async getPlayers({ teamId, playerId, day, cmd } = {}) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/player', { teamId, playerId, day, cmd })
    );
  }
}

const isports = new ISportsService();

// ============ PER-LEAGUE TEAM LOGO CACHE ============
const leagueLogoCache = new Map();
const leagueLogoInflight = new Map();

async function getLeagueLogos(leagueId) {
  const cached = leagueLogoCache.get(leagueId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (leagueLogoInflight.has(leagueId)) return leagueLogoInflight.get(leagueId);

  const p = isports
    .getTeamLogosByLeague(leagueId)
    .then((logos) => {
      const isEmpty = !logos || Object.keys(logos).length === 0;
      if (isEmpty) {
        console.warn(
          `⚠️  League ${leagueId} returned 0 teams — no logos available upstream`
        );
      }
      leagueLogoCache.set(leagueId, {
        data: logos,
        expiresAt:
          Date.now() +
          (isEmpty ? CONFIG.leagueLogo.emptyTtlMs : CONFIG.leagueLogo.ttlMs),
      });
      return logos;
    })
    .catch((err) => {
      console.warn(`League ${leagueId} logo fetch failed:`, err.message);
      leagueLogoCache.set(leagueId, {
        data: {},
        expiresAt: Date.now() + CONFIG.leagueLogo.emptyTtlMs,
      });
      return {};
    })
    .finally(() => {
      leagueLogoInflight.delete(leagueId);
    });

  leagueLogoInflight.set(leagueId, p);
  return p;
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker
  );
  await Promise.all(workers);
  return results;
}

async function getLogosForMatches(matches) {
  const leagueIds = [
    ...new Set(matches.map((m) => String(m.leagueId ?? '')).filter(Boolean)),
  ];

  const results = await mapWithConcurrency(
    leagueIds,
    CONFIG.leagueLogo.concurrency,
    (id) => getLeagueLogos(id)
  );

  const merged = {};
  for (const map of results) {
    Object.assign(merged, map);
  }
  return merged;
}

// ============ LOGO HELPERS ============
function localTeamLogo(teamId) {
  const t = TEAM_BY_ID.get(String(teamId));
  return t && t.logo ? t.logo : '';
}

function rewriteLeagueLogo(logo) {
  if (!logo || typeof logo !== 'string') return '';
  const afterHost = logo.split(
    'http://zq.titan007.com/Image/league_match/images/'
  )[1];
  if (!afterHost) return logo;
  const slug = afterHost.split('?')[0].replace(/\.(jpg|jpeg|png|gif)$/i, '');
  if (!slug) return logo;
  return `https://imgcms.thscore.fun/football/Image/league_match/images/${slug}.png`;
}

function rewriteCountryLogo(logo) {
  if (!logo || typeof logo !== 'string') return '';
  const afterHost = logo.split(
    'http://zq.titan007.com/Image/info/images/'
  )[1];
  if (!afterHost) return logo;
  const slug = afterHost.split('?')[0].replace(/\.(jpg|jpeg|png|gif)$/i, '');
  if (!slug) return logo;
  return `https://imgcms.thscore.fun/football/Image/info/images/${slug}.png`;
}

function rewriteTeamLogo(logo) {
  if (!logo || typeof logo !== 'string') return '';
  const afterHost = logo.split(
    'http://zq.titan007.com/Image/team/images/'
  )[1];
  if (!afterHost) return '';
  const pathPart = afterHost.split('?')[0];
  if (!pathPart) return '';
  return `https://imgcms.thscore.fun/football/Image/team/images/${pathPart}`;
}

function ensureTeamLogo(teamId, rawLogo) {
  const local = localTeamLogo(teamId);
  if (local) return local;
  if (rawLogo) return rewriteTeamLogo(rawLogo);
  return '';
}


/**
 * Rewrite an iSportsAPI player photo URL to the thscore CDN.
 *
 * Input:  http://zq.titan007.com/Image/player/images/2016225183959.jpg?win007=sell
 * Output: https://imgcms.thscore.fun/football/Image/player/images/2016225183959.png
 */
function rewritePlayerPhoto(photo) {
  if (!photo || typeof photo !== 'string') return '';
  const afterHost = photo.split(
    'http://zq.titan007.com/Image/player/images/'
  )[1];
  if (!afterHost) return '';
  const slug = afterHost.split('?')[0].replace(/\.(jpg|jpeg|png|gif)$/i, '');
  if (!slug) return '';
  return `https://imgcms.thscore.fun/football/Image/player/images/${slug}.png`;
}

/**
 * Parse a single iSportsAPI CSV row from an analysis array into an object.
 * Rows look like:
 *   "395140920,MEX LT,190616,1764363600,Home Name,60013,Away Name,63557,3,2,1,0,0,0,2,6,,,,,,..."
 * Trailing empty fields are ignored.
 */
function parseMatchRow(row) {
  if (typeof row !== 'string' || row.length === 0) return null;

  const f = row.split(',');

  // Helper: return '' for missing/undefined so the JSON is consistent.
  const at = (i) => (f[i] !== undefined ? f[i] : '');
  const intAt = (i) => {
    const v = at(i);
    if (v === '') return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };

  return {
    matchId: at(0),
    league: at(1),
    leagueId: at(2),
    matchTime: intAt(3),
    home: at(4),
    homeTeamId: at(5),
    away: at(6),
    awayTeamId: at(7),
    scoreHome: intAt(8),
    scoreAway: intAt(9),
    homeHalfScore: intAt(10),
    awayHalfScore: intAt(11),
    homeRed: intAt(12),
    awayRed: intAt(13),
    homeCorner: intAt(14),
    awayCorner: intAt(15),
  };
}

/**
 * Parse one of the analysis arrays (headToHead, homeLastMatches, ...).
 */
function parseMatchRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(parseMatchRow).filter(Boolean);
}

// ============ HELPERS ============
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Generic cache-or-produce. Takes a cache instance so each route can pick
 * its own TTL.
 */
function cacheGetOrSet(res, cacheInstance, key, producer) {
  const cached = cacheInstance.get(key);
  if (cached) {
    res.json({ success: true, source: 'cache', data: cached });
    return;
  }
  return producer().then((data) => {
    cacheInstance.set(key, data);
    res.json({
      success: true,
      source: 'api',
      data,
      timestamp: new Date().toISOString(),
    });
  });
}

function isoDateFromEpochSeconds(seconds) {
  const d = new Date(seconds * 1000);
  return d.toISOString().slice(0, 10);
}

// ============ BACKGROUND: SCHEDULE CHANGE POLLER ============
// /scheduleChange returns matches added or modified in the past hour.
// Poll every 30 min (iSportsAPI recommends 30 min) and merge the results
// into an in-memory index. Clients read /schedule?date=... from this index
// so they never trigger an iSportsAPI call for fixtures.

const SCHEDULE_CHANGE_INTERVAL_MS = 30 * 60 * 1000;
const liveScheduleIndex = new Map(); // matchId -> match object

async function pollScheduleChange() {
  try {
    const raw = await isports.getScheduleChange();
    if (!Array.isArray(raw)) return;

    quota.record('scheduleChange');

    let added = 0;
    let updated = 0;
    for (const m of raw) {
      const id = String(m.matchId ?? '');
      if (!id) continue;

      const enriched = {
        ...m,
        homeTeamLogo: ensureTeamLogo(m.homeId, ''),
        awayTeamLogo: ensureTeamLogo(m.awayId, ''),
      };

      if (liveScheduleIndex.has(id)) updated++;
      else added++;
      liveScheduleIndex.set(id, enriched);

      const date =
        m.matchTime != null ? isoDateFromEpochSeconds(m.matchTime) : null;
      if (date) {
        caches.schedule.del(`isports_schedule_date_${date}`);
      }
    }

    console.log(
      `[scheduleChange] +${added} new, ~${updated} updated, index=${liveScheduleIndex.size}`
    );
  } catch (err) {
    console.warn('[scheduleChange] failed:', err.message);
  }
}

function pruneScheduleIndex() {
  const cutoff = Date.now() / 1000 - 24 * 60 * 60; // 24h ago
  for (const [id, m] of liveScheduleIndex) {
    if (m.matchTime && m.matchTime < cutoff) {
      liveScheduleIndex.delete(id);
    }
  }
}

// ============ BACKGROUND: LIVESCORES CHANGE POLLER ============
// /livescores/changes returns matches whose livescore changed in the last
// 20 seconds. Poll only when (a) someone hit /livescores recently and
// (b) the livescores cache has entries. This keeps overnight usage at zero.

const LIVESCORES_POLL_INTERVAL_MS = 60 * 1000; // 60s — adjust to taste
let lastLivescoresClientHit = 0;

function recentlyServedLivescoresClients() {
  return Date.now() - lastLivescoresClientHit < 5 * 60 * 1000; // 5 min
}

async function pollLivescoresChanges() {
  if (!recentlyServedLivescoresClients()) return;

  const cached = caches.livescores.get('isports_livescores');
  if (!cached || !Array.isArray(cached) || cached.length === 0) return;

  try {
    const raw = await isports.getLivescoresChanges();
    if (!Array.isArray(raw) || raw.length === 0) return;

    quota.record('livescoresChanges');

    const byId = new Map(cached.map((m) => [String(m.matchId), m]));
    for (const m of raw) {
      const id = String(m.matchId ?? '');
      if (!id) continue;

      const enriched = {
        ...m,
        homeTeamLogo: ensureTeamLogo(m.homeId, ''),
        awayTeamLogo: ensureTeamLogo(m.awayId, ''),
      };
      byId.set(id, enriched);
    }

    const merged = Array.from(byId.values());
    caches.livescores.set('isports_livescores', merged, 300);
    console.log(
      `[livescores/changes] merged ${raw.length} changes, total=${merged.length}`
    );
  } catch (err) {
    console.warn('[livescores/changes] failed:', err.message);
  }
}

// Kick off the pollers.
pollScheduleChange();
setInterval(pollScheduleChange, SCHEDULE_CHANGE_INTERVAL_MS);
setInterval(pruneScheduleIndex, 60 * 60 * 1000);
setInterval(pollLivescoresChanges, LIVESCORES_POLL_INTERVAL_MS);

// ============ RATE LIMITERS ============
// Local endpoints are NOT rate-limited. Upstream endpoints are, with
// per-endpoint budgets.

const limiterLive = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: {
    success: false,
    error: 'Too many live-scores requests, try again in a minute.',
  },
});

const limiterSchedule = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: {
    success: false,
    error: 'Too many schedule requests, try again in a minute.',
  },
});

const limiterDetail = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: {
    success: false,
    error: 'Too many detail requests, try again in a minute.',
  },
});

const limiterDefault = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: {
    success: false,
    error: 'Too many requests, try again in a minute.',
  },
});

// ============ LOCAL ROUTES (no rate limit) ============

/**
 * GET /api/isports/leagues
 */
app.get(
  '/api/isports/leagues',
  wrap((req, res) => {
    const cacheKey = 'isports_leagues_local';
    const cached = caches.leagues.get(cacheKey);
    if (cached) {
      return res.json({ success: true, source: 'cache', data: cached });
    }

    if (!LOCAL_LEAGUES.length) {
      return res.status(500).json({
        success: false,
        error: 'Local leagues data is empty — check data/leagues.json',
      });
    }

    const enriched = LOCAL_LEAGUES.map((item) => {
      const { countryId, logo, countryLogo } = item;
      const finalLogo =
        logo && logo.startsWith('https://') ? logo : rewriteLeagueLogo(logo);
      const finalCountryLogo = countryLogo
        ? countryLogo.startsWith('https://')
          ? countryLogo
          : rewriteCountryLogo(countryLogo)
        : countryId
          ? `https://imgcms.thscore.fun/mini/fbcountry/${countryId}-flag-small.png`
          : '';

      return { ...item, logo: finalLogo, countryLogo: finalCountryLogo };
    });

    caches.leagues.set(cacheKey, enriched);
    res.json({
      success: true,
      source: 'local',
      data: enriched,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * POST /api/isports/leagues/reload
 */
app.post('/api/isports/leagues/reload', (req, res) => {
  loadAllLocalData();
  rebuildTeamIndex();
  caches.leagues.flushAll();
  caches.countries.flushAll();
  caches.teams.flushAll();
  res.json({
    success: true,
    counts: {
      leagues: LOCAL_LEAGUES.length,
      countries: LOCAL_COUNTRIES.length,
      teams: LOCAL_TEAMS.length,
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/isports/countries
 */
app.get(
  '/api/isports/countries',
  wrap((req, res) => {
    const cacheKey = 'isports_countries_local';
    const cached = caches.countries.get(cacheKey);
    if (cached) {
      return res.json({ success: true, source: 'cache', data: cached });
    }

    if (!LOCAL_COUNTRIES.length) {
      return res.status(500).json({
        success: false,
        error: 'Local countries data is empty — check data/countries.json',
      });
    }

    const enriched = LOCAL_COUNTRIES.map((item) => {
      const { countryId, flag } = item;
      const finalFlag =
        flag && flag.startsWith('https://')
          ? flag
          : countryId
            ? `https://imgcms.thscore.fun/mini/fbcountry/${countryId}-flag-small.png`
            : '';
      return { ...item, flag: finalFlag };
    });

    caches.countries.set(cacheKey, enriched);
    res.json({
      success: true,
      source: 'local',
      data: enriched,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * GET /api/isports/teams?leagueId=...
 */
app.get(
  '/api/isports/teams',
  wrap((req, res) => {
    const { leagueId } = req.query;
    const cacheKey = leagueId
      ? `isports_teams_local_${leagueId}`
      : 'isports_teams_local_all';

    const cached = caches.teams.get(cacheKey);
    if (cached) {
      return res.json({ success: true, source: 'cache', data: cached });
    }

    if (!LOCAL_TEAMS.length) {
      return res.status(500).json({
        success: false,
        error: 'Local teams data is empty — check data/teams.json',
      });
    }

    const filtered = leagueId
      ? LOCAL_TEAMS.filter(
        (t) => String(t.leagueId ?? '') === String(leagueId)
      )
      : LOCAL_TEAMS;

    const enriched = filtered.map((item) => ({
      ...item,
      logo:
        item.logo && item.logo.startsWith('https://')
          ? item.logo
          : rewriteTeamLogo(item.logo),
    }));

    caches.teams.set(cacheKey, enriched);
    res.json({
      success: true,
      source: 'local',
      data: enriched,
      timestamp: new Date().toISOString(),
    });
  })
);

// ============ AVATAR (no rate limit) ============
app.get('/api/isports/avatar', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const rawName = (req.query.name || '?').toString();
  const name = rawName.trim().slice(0, 60);

  const words = name.split(/\s+/).filter(Boolean);
  const initials =
    (words[0]?.[0] || '?').toUpperCase() +
    (words[1]?.[0] || '').toUpperCase();

  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  const bg = `hsl(${hue}, 55%, 45%)`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="10" fill="${bg}"/>
  <text x="32" y="41" font-family="Arial, Helvetica, sans-serif"
        font-size="26" font-weight="700" fill="#ffffff"
        text-anchor="middle">${initials}</text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.send(svg);
});

// ============ IMAGE PROXY (no rate limit) ============
app.get(
  '/api/isports/image',
  wrap(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { url } = req.query;
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'url parameter is required',
      });
    }

    let target;
    try {
      target = new URL(url);
    } catch {
      return res.status(400).json({ success: false, error: 'invalid url' });
    }

    const ALLOWED_HOSTS = new Set([
      'zq.titan007.com',
      'www.titan007.com',
      'titan007.com',
      'imgcms.thscore.fun',
    ]);

    if (!ALLOWED_HOSTS.has(target.hostname)) {
      return res.status(400).json({
        success: false,
        error: `host not allowed: ${target.hostname}`,
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const upstream = await fetch(target.toString(), {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!upstream.ok) {
        return res.status(upstream.status).end();
      }

      const contentType =
        upstream.headers.get('content-type') ?? 'image/png';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=604800');

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.end(buf);
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn(`Image proxy failed for ${url}:`, err.message);
      return res.status(502).end();
    }
  })
);

// ============ UPSTREAM ROUTES (rate limited) ============

/**
 * GET /api/isports/livescores
 * Served from cache when warm. Only fetches upstream on cold start or
 * after the cache has been explicitly cleared.
 */
app.get(
  '/api/isports/livescores',
  limiterLive,
  wrap(async (req, res) => {
    // Mark activity so the poller knows to keep this warm.
    lastLivescoresClientHit = Date.now();

    const cacheKey = 'isports_livescores';
    const cached = caches.livescores.get(cacheKey);
    if (cached) {
      return res.json({ success: true, source: 'cache', data: cached });
    }

    try {
      const raw = await isports.getLiveScores();
      if (!Array.isArray(raw)) {
        return res.json({ success: true, source: 'api', data: [] });
      }

      quota.record('livescores');

      const teamLogos = await getLogosForMatches(raw);
      const enriched = raw.map((item) => {
        const { homeId, awayId } = item;
        return {
          ...item,
          homeTeamLogo: ensureTeamLogo(homeId, teamLogos[homeId]),
          awayTeamLogo: ensureTeamLogo(awayId, teamLogos[awayId]),
        };
      });

      caches.livescores.set(cacheKey, enriched, 600); // 10 min base TTL
      res.json({
        success: true,
        source: 'api',
        data: enriched,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[livescores] upstream failed:', err.message);
      res.status(502).json({
        success: false,
        error: 'Upstream livescores unavailable',
      });
    }
  })
);

/**
 * GET /api/isports/livescores/changes
 * Pass-through to /livescores/changes. The background poller also uses
 * this same iSports endpoint, but this route exists for debugging.
 */
app.get(
  '/api/isports/livescores/changes',
  limiterDefault,
  wrap(async (req, res) => {
    const cacheKey = 'isports_livescores_changes';
    const cached = caches.livescores.get(cacheKey);
    if (cached) {
      return res.json({ success: true, source: 'cache', data: cached });
    }

    const raw = await isports.getLivescoresChanges();
    if (!Array.isArray(raw)) {
      return res.json({ success: true, source: 'api', data: [] });
    }

    quota.record('livescores/changes (manual)');

    const enriched = raw.map((item) => {
      const { homeId, awayId } = item;
      return {
        ...item,
        homeTeamLogo: ensureTeamLogo(homeId, ''),
        awayTeamLogo: ensureTeamLogo(awayId, ''),
      };
    });

    caches.livescores.set(cacheKey, enriched, 5);
    res.json({
      success: true,
      source: 'api',
      data: enriched,
      timestamp: new Date().toISOString(),
    });
  })
);

/**
 * GET /api/isports/scheduleChange
 * Pass-through to /scheduleChange. Same endpoint the background poller
 * uses, exposed for debugging.
 */
app.get(
  '/api/isports/scheduleChange',
  limiterDefault,
  wrap(async (req, res) => {
    await cacheGetOrSet(
      res,
      caches.schedule,
      'isports_schedule_change',
      async () => {
        const raw = await isports.getScheduleChange();
        if (!Array.isArray(raw)) return [];
        quota.record('scheduleChange (manual)');

        return raw.map((item) => {
          const { homeId, awayId } = item;
          return {
            ...item,
            homeTeamLogo: ensureTeamLogo(homeId, ''),
            awayTeamLogo: ensureTeamLogo(awayId, ''),
          };
        });
      }
    );
  })
);

/**
 * GET /api/isports/schedule
 * Date queries served from the in-memory index maintained by the poller.
 * leagueId/matchId queries fall through to upstream (rare, cached).
 */
app.get(
  '/api/isports/schedule',
  limiterSchedule,
  wrap(async (req, res) => {
    const { date, leagueId, matchId, season, subLeagueId, stageId } = req.query;

    const selectors = [date, leagueId, matchId].filter(
      (v) => v !== undefined && v !== null && v !== ''
    );

    if (selectors.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one of date, leagueId, or matchId is required',
        usage: '/api/isports/schedule?date=2026-09-15',
      });
    }
    if (selectors.length > 1) {
      return res.status(400).json({
        success: false,
        error:
          'date, leagueId, and matchId are mutually exclusive — provide only one',
      });
    }
    if (!leagueId && (season || subLeagueId || stageId)) {
      return res.status(400).json({
        success: false,
        error:
          'season, subLeagueId, and stageId can only be used with leagueId',
      });
    }

    // ---- Date: read from the rolling index ----
    if (date) {
      const rows = [];
      for (const m of liveScheduleIndex.values()) {
        const mDate =
          m.matchTime != null ? isoDateFromEpochSeconds(m.matchTime) : null;
        if (mDate === date) rows.push(m);
      }

      // If the index is cold (just deployed), fall back to upstream once.
      if (rows.length === 0 && liveScheduleIndex.size === 0) {
        return cacheGetOrSet(
          res,
          caches.schedule,
          `isports_schedule_date_${date}`,
          async () => {
            const raw = await isports.getSchedule({ date });
            if (!Array.isArray(raw)) return [];
            quota.record('schedule (cold date)');

            const teamLogos = await getLogosForMatches(raw);
            return raw.map((item) => {
              const { homeId, awayId } = item;
              return {
                ...item,
                homeTeamLogo: ensureTeamLogo(homeId, teamLogos[homeId]),
                awayTeamLogo: ensureTeamLogo(awayId, teamLogos[awayId]),
              };
            });
          }
        );
      }

      return res.json({
        success: true,
        source: 'index',
        data: rows,
        timestamp: new Date().toISOString(),
      });
    }

    // ---- leagueId / matchId: cache-aside upstream ----
    let cacheKey;
    if (leagueId) {
      cacheKey = `isports_schedule_league_${leagueId}`;
      if (season) cacheKey += `_s_${season}`;
      if (subLeagueId) cacheKey += `_sub_${subLeagueId}`;
      if (stageId) cacheKey += `_stage_${stageId}`;
    } else {
      const normalized = matchId
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort()
        .join(',');
      cacheKey = `isports_schedule_match_${normalized}`;
    }

    await cacheGetOrSet(res, caches.schedule, cacheKey, async () => {
      const raw = await isports.getSchedule({
        date,
        leagueId,
        matchId,
        season,
        subLeagueId,
        stageId,
      });
      if (!Array.isArray(raw)) return [];
      quota.record('schedule');

      const teamLogos = await getLogosForMatches(raw);
      return raw.map((item) => {
        const { homeId, awayId } = item;
        return {
          ...item,
          homeTeamLogo: ensureTeamLogo(homeId, teamLogos[homeId]),
          awayTeamLogo: ensureTeamLogo(awayId, teamLogos[awayId]),
        };
      });
    });
  })
);

/**
 * GET /api/isports/match?matchId=...
 */
app.get(
  '/api/isports/match',
  limiterDetail,
  wrap(async (req, res) => {
    const { matchId } = req.query;
    if (!matchId) {
      return res.status(400).json({
        success: false,
        error: 'matchId parameter is required',
      });
    }
    await cacheGetOrSet(
      res,
      caches.match,
      `isports_match_${matchId}`,
      async () => {
        const raw = await isports.getMatchDetail(matchId);
        quota.record('match');
        return raw;
      }
    );
  })
);

/**
 * GET /api/isports/team?teamId=...
 */
app.get(
  '/api/isports/team',
  limiterDetail,
  wrap(async (req, res) => {
    const { teamId } = req.query;
    if (!teamId) {
      return res.status(400).json({
        success: false,
        error: 'teamId parameter is required',
      });
    }

    const local = TEAM_BY_ID.get(String(teamId));
    if (local) {
      return res.json({
        success: true,
        source: 'local',
        data: local,
        timestamp: new Date().toISOString(),
      });
    }

    await cacheGetOrSet(
      res,
      caches.teams,
      `isports_team_${teamId}`,
      async () => {
        const raw = await isports.getTeamDetail(teamId);
        quota.record('team');
        if (raw && typeof raw === 'object' && raw.logo) {
          return { ...raw, logo: rewriteTeamLogo(raw.logo) };
        }
        return raw;
      }
    );
  })
);

/**
 * GET /api/isports/standings?leagueId=...
 */
app.get(
  '/api/isports/standings',
  limiterDetail,
  wrap(async (req, res) => {
    const { leagueId } = req.query;
    if (!leagueId) {
      return res.status(400).json({
        success: false,
        error: 'leagueId parameter is required',
      });
    }

    await cacheGetOrSet(
      res,
      caches.standings,
      `isports_standings_${leagueId}`,
      async () => {
        const raw = await isports.getStandings(leagueId);
        quota.record('standings');

        if (!raw || typeof raw !== 'object') return raw;

        const teamInfos = Array.isArray(raw.teamInfos) ? raw.teamInfos : [];
        const rewrittenTeamInfos = teamInfos.map((t) => {
          const teamId = String(t.teamId ?? '');
          return { ...t, logo: ensureTeamLogo(teamId, t.logo) };
        });

        return { ...raw, teamInfos: rewrittenTeamInfos };
      }
    );
  })
);

/**
 * GET /api/isports/lineups?matchId=...
 */
app.get(
  '/api/isports/lineups',
  limiterDetail,
  wrap(async (req, res) => {
    const { matchId } = req.query;
    if (!matchId) {
      return res.status(400).json({
        success: false,
        error: 'matchId parameter is required',
      });
    }
    await cacheGetOrSet(
      res,
      caches.lineups,
      `isports_lineups_${matchId}`,
      async () => {
        const raw = await isports.getLineups(matchId);
        quota.record('lineups');
        return raw;
      }
    );
  })
);

/**
 * GET /api/isports/h2h?matchId=...
 *
 * Returns head-to-head + recent-form analysis for a match.
 * The three relevant arrays are parsed from iSportsAPI's CSV-string
 * format into proper JSON objects. Everything else passes through as-is.
 */
app.get(
  '/api/isports/h2h',
  limiterDetail,
  wrap(async (req, res) => {
    const { matchId } = req.query;
    if (!matchId) {
      return res.status(400).json({
        success: false,
        error: 'matchId parameter is required',
        usage: '/api/isports/h2h?matchId=211379034',
      });
    }

    await cacheGetOrSet(res, caches.h2h, `isports_h2h_${matchId}`, async () => {
      const raw = await isports.getAnalysis(matchId);
      if (!raw || typeof raw !== 'object') return raw;
      quota.record('h2h');

      return {
        // Parsed into JSON objects — this is what clients care about.
        headToHead: parseMatchRows(raw.headToHead),
        homeLastMatches: parseMatchRows(raw.homeLastMatches),
        awayLastMatches: parseMatchRows(raw.awayLastMatches),

        // Pass through the rest untouched so nothing is lost.
        homeSchedule: raw.homeSchedule ?? [],
        awaySchedule: raw.awaySchedule ?? [],
        homeOdds: raw.homeOdds ?? [],
        awayOdds: raw.awayOdds ?? [],
        homeGoals: raw.homeGoals ?? [],
        awayGoals: raw.awayGoals ?? [],
        homeHT: raw.homeHT ?? [],
        awayHT: raw.awayHT ?? [],
        homeShootTime: raw.homeShootTime ?? [],
        awayShootTime: raw.awayShootTime ?? [],
        homeSingleDouble: raw.homeSingleDouble ?? [],
        awaySingleDouble: raw.awaySingleDouble ?? [],
        homeDataVs: raw.homeDataVs ?? [],
        awayDataVs: raw.awayDataVs ?? [],
      };
    });
  })
);

/**
 * GET /api/isports/events?matchId=...
 */
app.get(
  '/api/isports/events',
  limiterDetail,
  wrap(async (req, res) => {
    const { matchId } = req.query;
    if (!matchId) {
      return res.status(400).json({
        success: false,
        error: 'matchId parameter is required',
      });
    }
    await cacheGetOrSet(
      res,
      caches.events,
      `isports_events_${matchId}`,
      async () => {
        const raw = await isports.getMatchEvents(matchId);
        quota.record('events');
        return raw;
      }
    );
  })
);

/**
 * GET /api/isports/stats?matchId=...
 */
app.get(
  '/api/isports/stats',
  limiterDetail,
  wrap(async (req, res) => {
    const { matchId } = req.query;
    if (!matchId) {
      return res.status(400).json({
        success: false,
        error: 'matchId parameter is required',
      });
    }
    await cacheGetOrSet(
      res,
      caches.stats,
      `isports_stats_${matchId}`,
      async () => {
        const raw = await isports.getMatchStats(matchId);
        quota.record('stats');
        return raw;
      }
    );
  })
);

/**
 * GET /api/isports/player?playerId=...
 */
app.get(
  '/api/isports/player',
  limiterDetail,
  wrap(async (req, res) => {
    const { playerId } = req.query;
    if (!playerId) {
      return res.status(400).json({
        success: false,
        error: 'playerId parameter is required',
      });
    }
    await cacheGetOrSet(
      res,
      caches.player,
      `isports_player_${playerId}`,
      async () => {
        const raw = await isports.getPlayerDetail(playerId);
        quota.record('player');
        return raw;
      }
    );
  })
);

/**
 * GET /api/isports/topscorer?leagueId=...&season=...
 * Top scorers with team logos enriched.
 */
app.get(
  '/api/isports/topscorer',
  limiterDetail,
  wrap(async (req, res) => {
    const { leagueId, season } = req.query;
    if (!leagueId) {
      return res.status(400).json({
        success: false,
        error: 'leagueId parameter is required',
        usage: '/api/isports/topscorer?leagueId=1572',
      });
    }

    const cacheKey = season
      ? `isports_topscorer_${leagueId}_${season}`
      : `isports_topscorer_${leagueId}`;

    await cacheGetOrSet(res, caches.standings, cacheKey, async () => {
      const raw = await isports.getTopScorers({ leagueId, season });
      if (!Array.isArray(raw)) return [];
      quota.record('topscorer');

      return raw.map((row) => {
        const teamId = String(row.teamId ?? '');
        return {
          ...row,
          teamLogo: ensureTeamLogo(teamId, ''),
        };
      });
    });
  })
);

/**
 * GET /api/isports/player
 * Selector: exactly one of ?teamId=... | ?playerId=... | ?day=...
 * Optional: ?cmd=more
 *
 * Rewrites player photos and adds team logos.
 */
app.get(
  '/api/isports/player',
  limiterDetail,
  wrap(async (req, res) => {
    const { teamId, playerId, day, cmd } = req.query;

    const selectors = [teamId, playerId, day].filter(
      (v) => v !== undefined && v !== null && v !== ''
    );

    if (selectors.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'One of teamId, playerId, or day is required',
        usage: '/api/isports/player?teamId=4140',
      });
    }
    if (selectors.length > 1) {
      return res.status(400).json({
        success: false,
        error: 'teamId, playerId, and day are mutually exclusive',
      });
    }

    let cacheKey;
    if (teamId) cacheKey = `isports_player_team_${teamId}`;
    else if (playerId) cacheKey = `isports_player_id_${playerId}`;
    else cacheKey = `isports_player_day_${day}`;
    if (cmd) cacheKey += `_${cmd}`;

    const ttl = day ? 6 * 60 * 60 : undefined;
    cacheGetOrSet(res, caches.player, cacheKey, producer, ttl);

    //await cacheGetOrSet(res, caches.player, cacheKey, async () => {
    await cacheGetOrSet(res, caches.player, cacheKey, ttl, async () => {
      const raw = await isports.getPlayers({ teamId, playerId, day, cmd });
      if (!Array.isArray(raw)) return [];
      quota.record('player');

      return raw.map((p) => {
        const tid = String(p.teamId ?? '');
        return {
          ...p,
          photo: rewritePlayerPhoto(p.photo),
          teamLogo: ensureTeamLogo(tid, ''),
        };
      });
    });
  })
);

// ============ SYSTEM ENDPOINTS ============

/**
 * POST /api/cache/clear
 * Optional ?cache=<name> clears only one cache. Otherwise, clears all.
 */
app.post('/api/cache/clear', (req, res) => {
  const { cache: cacheName } = req.query;

  if (cacheName) {
    if (!caches[cacheName]) {
      return res.status(400).json({
        success: false,
        error: `Unknown cache: ${cacheName}`,
        available: Object.keys(caches),
      });
    }
    caches[cacheName].flushAll();
    return res.json({
      success: true,
      cleared: cacheName,
      timestamp: new Date().toISOString(),
    });
  }

  for (const c of Object.values(caches)) c.flushAll();
  leagueLogoCache.clear();
  leagueLogoInflight.clear();

  res.json({
    success: true,
    message: 'All caches cleared',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/cache/stats', (req, res) => {
  const perCache = {};
  for (const [name, c] of Object.entries(caches)) {
    perCache[name] = {
      keys: c.keys().length,
      stats: c.getStats(),
    };
  }

  res.json({
    success: true,
    caches: perCache,
    leagueLogoCache: {
      leagues: leagueLogoCache.size,
      inflight: leagueLogoInflight.size,
    },
    localData: {
      leagues: LOCAL_LEAGUES.length,
      countries: LOCAL_COUNTRIES.length,
      teams: LOCAL_TEAMS.length,
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (req, res) => {
  const cacheSummary = {};
  for (const [name, c] of Object.entries(caches)) {
    cacheSummary[name] = c.keys().length;
  }

  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    caches: cacheSummary,
    scheduleIndexSize: liveScheduleIndex.size,
    quota: quota.snapshot(),
    leagueLogoCache: {
      leagues: leagueLogoCache.size,
      inflight: leagueLogoInflight.size,
    },
    localData: {
      leagues: LOCAL_LEAGUES.length,
      countries: LOCAL_COUNTRIES.length,
      teams: LOCAL_TEAMS.length,
    },
    timestamp: new Date().toISOString(),
  });
});

// ============ ROOT DOCS ============
app.get('/', (req, res) => {
  res.json({
    name: 'iSportsAPI Proxy',
    version: '4.0.0',
    description:
      'Proxy with local JSON data, split caches, background pollers for scheduleChange/livescores-changes, and quota tracking.',
    baseUrl: `http://localhost:${PORT}`,
    localEndpoints: [
      { path: '/api/isports/leagues', source: 'data/leagues.json' },
      { path: '/api/isports/countries', source: 'data/countries.json' },
      { path: '/api/isports/teams', source: 'data/teams.json' },
      { path: '/api/isports/leagues/reload', method: 'POST' },
      { path: '/api/isports/avatar' },
      { path: '/api/isports/image' },
    ],
    upstreamEndpoints: [
      { path: '/api/isports/livescores' },
      { path: '/api/isports/livescores/changes' },
      { path: '/api/isports/scheduleChange' },
      { path: '/api/isports/schedule' },
      { path: '/api/isports/match' },
      { path: '/api/isports/team' },
      { path: '/api/isports/standings' },
      { path: '/api/isports/lineups' },
      { path: '/api/isports/events' },
      { path: '/api/isports/stats' },
      { path: '/api/isports/player' },
      { path: '/api/isports/topscorer', method: 'GET' },
      { path: '/api/isports/player',   method: 'GET' },
    ],
    backgroundPollers: {
      scheduleChange: 'every 30 min → maintains in-memory schedule index',
      livescoresChanges:
        'every 60s, only while clients are active and livescores cache is warm',
    },
    caches: Object.entries(CACHE_TTLS).map(([name, ttl]) => ({
      name,
      ttlSeconds: ttl,
    })),
    rateLimits: {
      local: 'none',
      live: '30 / min',
      schedule: '60 / min',
      detail: '120 / min',
    },
    systemEndpoints: [
      { path: '/api/health', method: 'GET' },
      { path: '/api/cache/stats', method: 'GET' },
      { path: '/api/cache/clear', method: 'POST' },
      { path: '/api/cache/clear?cache=<name>', method: 'POST' },
    ],
    timestamp: new Date().toISOString(),
  });
});

// ============ ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}`, err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error',
  });
});

// ============ START ============
app.listen(PORT, () => {
  console.log(`\n🚀 iSportsAPI Proxy v4.0`);
  console.log(`📡 http://localhost:${PORT}`);
  console.log(`\n📦 Local (no rate limit):`);
  console.log(`  - Leagues:   /api/isports/leagues`);
  console.log(`  - Countries: /api/isports/countries`);
  console.log(`  - Teams:     /api/isports/teams?leagueId=...`);
  console.log(`  - Image:     /api/isports/image?url=...`);
  console.log(`  - Avatar:    /api/isports/avatar?name=...`);
  console.log(`\n🌐 Upstream (rate-limited, backed by pollers):`);
  console.log(`  - Live:      /api/isports/livescores          (30/min)`);
  console.log(`               /api/isports/livescores/changes  (60s bg poll)`);
  console.log(`  - Schedule:  /api/isports/schedule            (60/min)`);
  console.log(`               /api/isports/scheduleChange      (30min bg poll)`);
  console.log(`  - Detail:    /api/isports/{match,team,standings,lineups,events,stats,player} (120/min)`);
  console.log(`\n📊 Diagnostics:`);
  console.log(`  - Health:    /api/health     (shows quota + cache summary)`);
  console.log(`  - Cache:     /api/cache/stats`);
  console.log(`  - Clear:     POST /api/cache/clear[?cache=<name>]`);
  console.log(`\n📖 Docs: http://localhost:${PORT}/\n`);
});