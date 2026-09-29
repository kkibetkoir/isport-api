const express = require('express');
const NodeCache = require('node-cache');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ MIDDLEWARE ============
app.use(cors());
app.use(compression());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: {
    success: false,
    error: 'Too many requests, please try again later.',
  },
});
app.use('/api', limiter);

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

  // ============ LEAGUES ============
  async getLeagueList() {
    return this.fetchWithTimeout(this.buildUrl('/sport/football/league/list'));
  }

  async getLeaguesBasic() {
    return this.fetchWithTimeout(this.buildUrl('/sport/football/league/basic'));
  }

  // ============ COUNTRIES ============
  async getCountries() {
    return this.fetchWithTimeout(this.buildUrl('/sport/football/country'));
  }

  // ============ MATCHES ============
  async getLiveScores() {
    return this.fetchWithTimeout(this.buildUrl('/sport/football/livescores'));
  }

  async getSchedule(date) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/schedule', { date })
    );
  }

  async getMatchDetail(matchId) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/match', { matchId })
    );
  }

  // ============ TEAMS ============
  async getTeamsByLeague(leagueId) {
    return this.fetchWithTimeout(
      this.buildUrl('/sport/football/team', { leagueId }),
      60000
    );
  }

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

// ============ IMAGE REWRITE HELPERS ============

/**
 * Rewrite an iSportsAPI league logo URL to the thscore CDN.
 * Input:  http://zq.titan007.com/Image/league_match/images/20200420184115.jpg?win007=sell
 * Output: https://imgcms.thscore.fun/football/Image/league_match/images/20200420184115.png
 */
function rewriteLeagueLogo(logo) {
  if (!logo || typeof logo !== 'string') return '';
  try {
    const slug = logo
      .split('http://zq.titan007.com/Image/league_match/images/')[1]
      .split('.jpg?win007=sell')[0];
    if (!slug) return '';
    return `https://imgcms.thscore.fun/football/Image/league_match/images/${slug}.png`;
  } catch {
    return '';
  }
}

/**
 * Rewrite an iSportsAPI team logo URL to the thscore CDN.
 * Input:  http://zq.titan007.com/Image/team/images/300/1m0p22mxxw6.png?win007=sell
 * Output: https://imgcms.thscore.fun/football/Image/team/images/300/1m0p22mxxw6.png
 *
 * @param {string} logo raw logo URL
 * @param {string|number} teamId team id (used as fallback path segment)
 */
function rewriteTeamLogo(logo, teamId) {
  if (!logo || typeof logo !== 'string') return '';

  // Try the standard pattern first.
  try {
    const afterHost = logo.split(
      'http://zq.titan007.com/Image/team/images/'
    )[1];
    if (afterHost) {
      // afterHost = "300/1m0p22mxxw6.png?win007=sell"
      const path = afterHost.split('?')[0]; // "300/1m0p22mxxw6.png"
      return `https://imgcms.thscore.fun/football/Image/team/images/${path}`;
    }
  } catch {}

  // Fallback: pattern where the URL has no team-id directory.
  // e.g. http://zq.titan007.com/Image/team/images/1jr565tbs5z.png?win007=sell
  try {
    const afterHost = logo
      .split('http://zq.titan007.com/Image/team/images/')[1];
    if (afterHost) {
      const filename = afterHost.split('?')[0];
      return `https://imgcms.thscore.fun/football/Image/team/images/${filename}`;
    }
  } catch {}

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

// ============ ROUTES ============

/**
 * GET /api/isports/leagues
 * Full league list. Rewrites logo + adds countryLogo.
 * Uses /league/list so we're not limited by the basic endpoint.
 */
app.get(
  '/api/isports/leagues',
  wrap(async (req, res) => {
    await cacheGetOrSet(res, 'isports_leagues_list', async () => {
      const raw = await isports.getLeagueList();
      if (!Array.isArray(raw)) return [];

      return raw.map((item) => {
        const { countryId, logo } = item;
        return {
          ...item,
          logo: rewriteLeagueLogo(logo),
          countryLogo: countryId
            ? `https://imgcms.thscore.fun/mini/fbcountry/${countryId}-flag-small.png`
            : '',
        };
      });
    });
  })
);

/**
 * GET /api/isports/countries
 * Full country list.
 */
app.get(
  '/api/isports/countries',
  wrap(async (req, res) => {
    await cacheGetOrSet(res, 'isports_countries', async () => {
      const raw = await isports.getCountries();
      if (!Array.isArray(raw)) return [];

      return raw.map((item) => {
        const { countryId } = item;
        return {
          ...item,
          flag: countryId
            ? `https://imgcms.thscore.fun/mini/fbcountry/${countryId}-flag-small.png`
            : '',
        };
      });
    });
  })
);

/**
 * GET /api/isports/livescores
 * Live matches with team logos rewritten to the thscore CDN.
 */
app.get(
  '/api/isports/livescores',
  wrap(async (req, res) => {
    await cacheGetOrSet(res, 'isports_livescores', async () => {
      const raw = await isports.getLiveScores();
      if (!Array.isArray(raw)) return [];

      const teamLogos = await getLogosForMatches(raw);

      return raw.map((item) => {
        const { homeId, awayId } = item;
        return {
          ...item,
          homeTeamLogo: rewriteTeamLogo(teamLogos[homeId], homeId),
          awayTeamLogo: rewriteTeamLogo(teamLogos[awayId], awayId),
        };
      });
    });
  })
);

/**
 * GET /api/isports/schedule?date=YYYY-MM-DD
 * Fixtures for a date with team logos rewritten.
 */
app.get(
  '/api/isports/schedule',
  wrap(async (req, res) => {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'date parameter is required',
        usage: '/api/isports/schedule?date=2026-09-15',
      });
    }

    await cacheGetOrSet(res, `isports_schedule_${date}`, async () => {
      const raw = await isports.getSchedule(date);
      if (!Array.isArray(raw)) return [];

      const teamLogos = await getLogosForMatches(raw);

      return raw.map((item) => {
        const { homeId, awayId } = item;
        return {
          ...item,
          homeTeamLogo: rewriteTeamLogo(teamLogos[homeId], homeId),
          awayTeamLogo: rewriteTeamLogo(teamLogos[awayId], awayId),
        };
      });
    });
  })
);

/**
 * GET /api/isports/match?matchId=...
 * Raw iSportsAPI response.
 */
app.get(
  '/api/isports/match',
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
 * GET /api/isports/teams?leagueId=...
 * Teams with logos rewritten.
 */
app.get(
  '/api/isports/teams',
  wrap(async (req, res) => {
    const { leagueId } = req.query;
    const cacheKey = leagueId
      ? `isports_teams_${leagueId}`
      : 'isports_teams_all';

    await cacheGetOrSet(res, cacheKey, async () => {
      const raw = await isports.getTeamsByLeague(leagueId);
      if (!Array.isArray(raw)) return [];

      return raw.map((item) => {
        const { teamId, logo } = item;
        return {
          ...item,
          logo: rewriteTeamLogo(logo, teamId),
        };
      });
    });
  })
);

/**
 * GET /api/isports/team?teamId=...
 * Raw iSportsAPI response.
 */
app.get(
  '/api/isports/team',
  wrap(async (req, res) => {
    const { teamId } = req.query;
    if (!teamId) {
      return res.status(400).json({
        success: false,
        error: 'teamId parameter is required',
      });
    }
    await cacheGetOrSet(res, `isports_team_${teamId}`, async () => {
      return await isports.getTeamDetail(teamId);
    });
  })
);

/**
 * GET /api/isports/standings?leagueId=...
 * Raw iSportsAPI response.
 */
app.get(
  '/api/isports/standings',
  wrap(async (req, res) => {
    const { leagueId } = req.query;
    if (!leagueId) {
      return res.status(400).json({
        success: false,
        error: 'leagueId parameter is required',
      });
    }

    await cacheGetOrSet(res, `isports_standings_${leagueId}`, async () => {
      return await isports.getStandings(leagueId);
    });
  })
);

/**
 * GET /api/isports/lineups?matchId=...
 * Raw iSportsAPI response.
 */
app.get(
  '/api/isports/lineups',
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
 * Raw iSportsAPI response.
 */
app.get(
  '/api/isports/events',
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
 * Raw iSportsAPI response.
 */
app.get(
  '/api/isports/stats',
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
 * Raw iSportsAPI response.
 */
app.get(
  '/api/isports/player',
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

// ============ MONOGRAM AVATAR ============
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

// ============ IMAGE PROXY ============
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

// ============ SYSTEM ENDPOINTS ============

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
    timestamp: new Date().toISOString(),
  });
});

// ============ ROOT DOCS ============
app.get('/', (req, res) => {
  res.json({
    name: 'iSportsAPI Proxy',
    version: '2.0.0',
    description:
      'Express proxy for iSportsAPI with CORS, caching, and thscore CDN logo rewrites',
    baseUrl: `http://localhost:${PORT}`,
    endpoints: [
      { path: '/api/isports/leagues', method: 'GET', example: '/api/isports/leagues' },
      { path: '/api/isports/countries', method: 'GET', example: '/api/isports/countries' },
      { path: '/api/isports/livescores', method: 'GET', example: '/api/isports/livescores' },
      { path: '/api/isports/schedule', method: 'GET', example: '/api/isports/schedule?date=2026-09-15' },
      { path: '/api/isports/match', method: 'GET', example: '/api/isports/match?matchId=12345' },
      { path: '/api/isports/teams', method: 'GET', example: '/api/isports/teams?leagueId=133' },
      { path: '/api/isports/team', method: 'GET', example: '/api/isports/team?teamId=7' },
      { path: '/api/isports/standings', method: 'GET', example: '/api/isports/standings?leagueId=133' },
      { path: '/api/isports/lineups', method: 'GET', example: '/api/isports/lineups?matchId=12345' },
      { path: '/api/isports/events', method: 'GET', example: '/api/isports/events?matchId=12345' },
      { path: '/api/isports/stats', method: 'GET', example: '/api/isports/stats?matchId=12345' },
      { path: '/api/isports/player', method: 'GET', example: '/api/isports/player?playerId=999' },
      { path: '/api/isports/image', method: 'GET', example: '/api/isports/image?url=...' },
      { path: '/api/isports/avatar', method: 'GET', example: '/api/isports/avatar?name=Deportes%20Santa%20Cruz' },
    ],
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
  console.log(`\n🚀 iSportsAPI Proxy v2.0`);
  console.log(`📡 http://localhost:${PORT}`);
  console.log(`\n📊 Endpoints:`);
  console.log(`  - Leagues:   /api/isports/leagues   (uses /league/list)`);
  console.log(`  - Countries: /api/isports/countries`);
  console.log(`  - Live:      /api/isports/livescores`);
  console.log(`  - Schedule:  /api/isports/schedule?date=YYYY-MM-DD`);
  console.log(`  - Teams:     /api/isports/teams?leagueId=...`);
  console.log(`  - Standings: /api/isports/standings?leagueId=...`);
  console.log(`  - Lineups:   /api/isports/lineups?matchId=...`);
  console.log(`  - Events:    /api/isports/events?matchId=...`);
  console.log(`  - Stats:     /api/isports/stats?matchId=...`);
  console.log(`  - Image:     /api/isports/image?url=...`);
  console.log(`  - Avatar:    /api/isports/avatar?name=...`);
  console.log(`\n📖 Docs: http://localhost:${PORT}/\n`);
});