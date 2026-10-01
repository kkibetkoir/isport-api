const express = require('express');
const NodeCache = require('node-cache');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
  cache: {
    stdTTL: 60,
    checkperiod: 60,
  },
  leagueLogo: {
    ttlMs: 6 * 60 * 60 * 1000,
    emptyTtlMs: 30 * 60 * 1000,
    concurrency: 10,
  },
};

const cache = new NodeCache({
  stdTTL: CONFIG.cache.stdTTL,
  checkperiod: CONFIG.cache.checkperiod,
});

// ============ LOCAL DATA LOADER ============
// Each file can be either a bare array or { success, data: [...] }.
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

// Build a fast teamId -> team lookup once.
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

  async getMatchDetail(matchId) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/match', { matchId })
    );
  }

  // ============ TEAMS (upstream, only used to build team logos for matches) ============
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

  // ============ PLAYERS ============
  async getPlayerDetail(playerId) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/player', { playerId })
    );
  }
}

const isports = new ISportsService();

// ============ PER-LEAGUE TEAM LOGO CACHE ============
const leagueLogoCache = new Map();
const leagueLogoInflight = new Map();

async function getLeagueLogos(leagueId) {
  const cached = leagueLogoCache.get(leagueId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  if (leagueLogoInflight.has(leagueId)) {
    return leagueLogoInflight.get(leagueId);
  }

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

// ============ LOGO LOOKUP HELPERS ============
// Prefer the local teams.json (fully rewritten logos already), fall back
// to whatever upstream sent.

/**
 * Look up a local team's logo by teamId. Returns '' if not found.
 * Local teams.json already stores the final https URL, so no rewrite needed.
 */
function localTeamLogo(teamId) {
  const t = TEAM_BY_ID.get(String(teamId));
  return t && t.logo ? t.logo : '';
}

// ============ IMAGE REWRITE HELPERS ============

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

/**
 * Rewrite any team logo URL we get — either from teams.json (already
 * rewritten, pass through) or from upstream iSportsAPI (needs rewriting).
 */
function ensureTeamLogo(teamId, rawLogo) {
  // 1. Prefer local teams.json
  const local = localTeamLogo(teamId);
  if (local) return local;

  // 2. Otherwise rewrite whatever upstream sent
  if (rawLogo) return rewriteTeamLogo(rawLogo);

  // 3. Nothing available
  return '';
}

// ============ HELPERS ============
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function cacheGetOrSet(res, key, producer) {
  const cached = cache.get(key);
  if (cached) {
    res.json({ success: true, source: 'cache', data: cached });
    return;
  }
  return producer().then((data) => {
    cache.set(key, data);
    res.json({
      success: true,
      source: 'api',
      data,
      timestamp: new Date().toISOString(),
    });
  });
}

// ============ PER-ENDPOINT RATE LIMITERS ============
//
// Local endpoints (leagues, countries, teams, images, avatar) are NOT
// rate-limited — they read from disk or generate SVG locally.
//
// Upstream endpoints get their own budgets. Requests that hit the proxy
// but never touch iSportsAPI don't consume these.

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
 * Served entirely from data/leagues.json. No iSportsAPI call.
 */
app.get(
  '/api/isports/leagues',
  wrap((req, res) => {
    const cached = cache.get('isports_leagues_local');
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

      // If the local file already has a rewritten https logo, keep it.
      // Otherwise rewrite from the original iSportsAPI url.
      const finalLogo =
        logo && logo.startsWith('https://')
          ? logo
          : rewriteLeagueLogo(logo);

      const finalCountryLogo = countryLogo
        ? countryLogo.startsWith('https://')
          ? countryLogo
          : rewriteCountryLogo(countryLogo)
        : countryId
          ? `https://imgcms.thscore.fun/mini/fbcountry/${countryId}-flag-small.png`
          : '';

      return {
        ...item,
        logo: finalLogo,
        countryLogo: finalCountryLogo,
      };
    });

    cache.set('isports_leagues_local', enriched, 6 * 60 * 60);
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
 * Re-reads all three local files and flushes caches.
 */
app.post('/api/isports/leagues/reload', (req, res) => {
  loadAllLocalData();
  rebuildTeamIndex();
  cache.del('isports_leagues_local');
  cache.del('isports_countries_local');
  cache.del('isports_teams_all');
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
 * Served entirely from data/countries.json.
 */
app.get(
  '/api/isports/countries',
  wrap((req, res) => {
    const cached = cache.get('isports_countries_local');
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

    cache.set('isports_countries_local', enriched, 6 * 60 * 60);
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
 * Served from data/teams.json. Filters by leagueId if provided.
 */
app.get(
  '/api/isports/teams',
  wrap((req, res) => {
    const { leagueId } = req.query;
    const cacheKey = leagueId
      ? `isports_teams_local_${leagueId}`
      : 'isports_teams_local_all';

    const cached = cache.get(cacheKey);
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

    // Ensure logos are https (they should be already in teams.json).
    const enriched = filtered.map((item) => ({
      ...item,
      logo: item.logo && item.logo.startsWith('https://')
        ? item.logo
        : rewriteTeamLogo(item.logo),
    }));

    cache.set(cacheKey, enriched, 6 * 60 * 60);
    res.json({
      success: true,
      source: 'local',
      data: enriched,
      timestamp: new Date().toISOString(),
    });
  })
);

// ============ MONOGRAM AVATAR (no rate limit) ============
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
 * Upstream. Rate-limited.
 */
app.get(
  '/api/isports/livescores',
  limiterLive,
  wrap(async (req, res) => {
    await cacheGetOrSet(res, 'isports_livescores', async () => {
      const raw = await isports.getLiveScores();
      if (!Array.isArray(raw)) return [];

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
 * GET /api/isports/schedule?date=... | ?leagueId=... | ?matchId=...
 * Upstream. Rate-limited.
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

    let cacheKey;
    if (date) {
      cacheKey = `isports_schedule_date_${date}`;
    } else if (leagueId) {
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

    await cacheGetOrSet(res, cacheKey, async () => {
      const raw = await isports.getSchedule({
        date,
        leagueId,
        matchId,
        season,
        subLeagueId,
        stageId,
      });

      if (!Array.isArray(raw)) return [];

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
 * Upstream. Rate-limited.
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
    await cacheGetOrSet(res, `isports_match_${matchId}`, async () => {
      return await isports.getMatchDetail(matchId);
    });
  })
);

/**
 * GET /api/isports/team?teamId=...
 * Upstream. Rate-limited. Also enriched with local fields when available.
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

    // Prefer local team detail when we have it.
    const local = TEAM_BY_ID.get(String(teamId));
    if (local) {
      return res.json({
        success: true,
        source: 'local',
        data: local,
        timestamp: new Date().toISOString(),
      });
    }

    await cacheGetOrSet(res, `isports_team_${teamId}`, async () => {
      const raw = await isports.getTeamDetail(teamId);
      // If upstream returns team info, rewrite its logo too.
      if (raw && typeof raw === 'object' && raw.logo) {
        return { ...raw, logo: rewriteTeamLogo(raw.logo) };
      }
      return raw;
    });
  })
);

/**
 * GET /api/isports/standings?leagueId=...
 * Upstream. Rewrites teamInfos[].logo to our format.
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

    await cacheGetOrSet(res, `isports_standings_${leagueId}`, async () => {
      const raw = await isports.getStandings(leagueId);

      if (!raw || typeof raw !== 'object') return raw;

      // Rewrite team logos in teamInfos: prefer local teams.json.
      const teamInfos = Array.isArray(raw.teamInfos) ? raw.teamInfos : [];
      const rewrittenTeamInfos = teamInfos.map((t) => {
        const teamId = String(t.teamId ?? '');
        return {
          ...t,
          logo: ensureTeamLogo(teamId, t.logo),
        };
      });

      return {
        ...raw,
        teamInfos: rewrittenTeamInfos,
      };
    });
  })
);

/**
 * GET /api/isports/lineups?matchId=...
 * Upstream. Rate-limited.
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
    await cacheGetOrSet(res, `isports_lineups_${matchId}`, async () => {
      return await isports.getLineups(matchId);
    });
  })
);

/**
 * GET /api/isports/events?matchId=...
 * Upstream. Rate-limited.
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
    await cacheGetOrSet(res, `isports_events_${matchId}`, async () => {
      return await isports.getMatchEvents(matchId);
    });
  })
);

/**
 * GET /api/isports/stats?matchId=...
 * Upstream. Rate-limited.
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
    await cacheGetOrSet(res, `isports_stats_${matchId}`, async () => {
      return await isports.getMatchStats(matchId);
    });
  })
);

/**
 * GET /api/isports/player?playerId=...
 * Upstream. Rate-limited.
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
    await cacheGetOrSet(res, `isports_player_${playerId}`, async () => {
      return await isports.getPlayerDetail(playerId);
    });
  })
);

// ============ SYSTEM ENDPOINTS (no rate limit) ============

app.post('/api/cache/clear', (req, res) => {
  cache.flushAll();
  leagueLogoCache.clear();
  leagueLogoInflight.clear();

  res.json({
    success: true,
    message: 'Cache cleared successfully',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/cache/stats', (req, res) => {
  res.json({
    success: true,
    stats: cache.getStats(),
    keys: cache.keys(),
    count: cache.keys().length,
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
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    cache: {
      keys: cache.keys().length,
      stats: cache.getStats(),
    },
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
    version: '3.0.0',
    description:
      'Express proxy for iSportsAPI. Leagues/countries/teams served from local JSON; matches/standings/details proxied and rate-limited per endpoint.',
    baseUrl: `http://localhost:${PORT}`,
    localEndpoints: [
      { path: '/api/isports/leagues', method: 'GET', source: 'data/leagues.json' },
      { path: '/api/isports/countries', method: 'GET', source: 'data/countries.json' },
      { path: '/api/isports/teams', method: 'GET', source: 'data/teams.json' },
      { path: '/api/isports/leagues/reload', method: 'POST' },
      { path: '/api/isports/avatar', method: 'GET' },
      { path: '/api/isports/image', method: 'GET' },
    ],
    upstreamEndpoints: [
      { path: '/api/isports/livescores', method: 'GET' },
      { path: '/api/isports/schedule', method: 'GET', params: ['date | leagueId | matchId', 'season', 'subLeagueId', 'stageId'] },
      { path: '/api/isports/match', method: 'GET' },
      { path: '/api/isports/team', method: 'GET' },
      { path: '/api/isports/standings', method: 'GET' },
      { path: '/api/isports/lineups', method: 'GET' },
      { path: '/api/isports/events', method: 'GET' },
      { path: '/api/isports/stats', method: 'GET' },
      { path: '/api/isports/player', method: 'GET' },
    ],
    rateLimits: {
      localEndpoints: 'none',
      live: '30 / min',
      schedule: '60 / min',
      detail: '120 / min',
    },
    systemEndpoints: [
      { path: '/api/health', method: 'GET' },
      { path: '/api/cache/stats', method: 'GET' },
      { path: '/api/cache/clear', method: 'POST' },
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
  console.log(`\n🚀 iSportsAPI Proxy v3.0`);
  console.log(`📡 http://localhost:${PORT}`);
  console.log(`\n📦 Local data (no rate limit):`);
  console.log(`  - Leagues:   /api/isports/leagues`);
  console.log(`  - Countries: /api/isports/countries`);
  console.log(`  - Teams:     /api/isports/teams?leagueId=...`);
  console.log(`  - Image:     /api/isports/image?url=...`);
  console.log(`  - Avatar:    /api/isports/avatar?name=...`);
  console.log(`\n🌐 Upstream (rate-limited):`);
  console.log(`  - Live:      /api/isports/livescores   (30/min)`);
  console.log(`  - Schedule:  /api/isports/schedule     (60/min)`);
  console.log(`  - Detail:    /api/isports/{match,team,standings,lineups,events,stats,player} (120/min)`);
  console.log(`\n📖 Docs: http://localhost:${PORT}/\n`);
});