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
    ttlMs: 6 * 60 * 60 * 1000,        // 6 hours for successful lookups
    emptyTtlMs: 30 * 60 * 1000,       // 30 minutes for empty/failed lookups
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

  async getLeaguesBasic() {
    return this.fetchWithTimeout(this.buildUrl('/sport/football/league/basic'));
  }

  async getLeagueList() {
    return this.fetchWithTimeout(this.buildUrl('/sport/football/league/list'));
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

  /**
   * Fetch team logos for a single league (~few KB, fast).
   * Returns { teamId: logo }.
   */
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
        // Cache empty results for less time so we retry sooner.
        expiresAt:
          Date.now() +
          (isEmpty ? CONFIG.leagueLogo.emptyTtlMs : CONFIG.leagueLogo.ttlMs),
      });
      return logos;
    })
    .catch((err) => {
      console.warn(`League ${leagueId} logo fetch failed:`, err.message);
      // Cache failures briefly so we don't hammer a broken upstream.
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
    ...new Set(
      matches.map((m) => String(m.leagueId ?? '')).filter(Boolean)
    ),
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

// ============ IMAGE HELPERS ============

/**
 * Return a proxied URL for a real logo, or a self-hosted monogram avatar
 * fallback derived from the team name. Never returns ''.
 *
 * @param {string|undefined} url raw logo URL from iSportsAPI
 * @param {string|undefined} fallbackName team name for the monogram
 */
function toProxiedImage(url, fallbackName) {
  // Real logo → proxy it through our own server.
  if (url && typeof url === 'string' && url.length > 0) {
    return `/api/isports/image?url=${encodeURIComponent(url)}`;
  }

  // No logo → monogram avatar based on the team name.
  const name =
    typeof fallbackName === 'string' && fallbackName.trim().length > 0
      ? fallbackName.trim()
      : '?';
  return `/api/isports/avatar?name=${encodeURIComponent(name)}`;
}

// ============ DATA TRANSFORMERS ============
class DataTransformer {
  static league(l) {
    return {
      leagueId: String(l.leagueId ?? ''),
      name: l.name ?? '',
      shortName: l.shortName ?? l.name ?? '',
      logo: l.logo ?? '',
      country: l.country ?? '',
      countryId: l.countryId != null ? String(l.countryId) : null,
    };
  }

  static match(m, teamLogos = {}) {
    const homeTeamId = String(m.homeId ?? m.homeTeamId ?? '');
    const awayTeamId = String(m.awayId ?? m.awayTeamId ?? '');
    const homeTeamName = m.homeName ?? m.homeTeam?.name ?? '';
    const awayTeamName = m.awayName ?? m.awayTeam?.name ?? '';

    return {
      matchId: String(m.matchId ?? ''),
      leagueId: String(m.leagueId ?? ''),
      leagueName: m.leagueName ?? m.league?.name ?? '',

      homeTeamId,
      homeTeamName,
      homeTeamLogo: toProxiedImage(teamLogos[homeTeamId], homeTeamName),
      homeScore: m.homeScore ?? null,

      awayTeamId,
      awayTeamName,
      awayTeamLogo: toProxiedImage(teamLogos[awayTeamId], awayTeamName),
      awayScore: m.awayScore ?? null,

      status: m.status ?? '',
      matchTime: m.matchTime ?? m.time ?? '',
      kickoff: m.kickoff ?? m.startTime ?? '',
    };
  }

  static team(t) {
    return {
      teamId: String(t.teamId ?? ''),
      leagueId: String(t.leagueId ?? ''),
      name: t.name ?? '',
      shortName: t.shortName ?? t.name ?? '',
      logo: toProxiedImage(t.logo, t.name),
      foundingDate: t.foundingDate ?? '',
    };
  }

  static standingRow(row, teamInfoById) {
    const teamId = String(row.teamId ?? '');
    const info = teamInfoById[teamId] || {};
    const teamName = info.name ?? row.name ?? '';
    return {
      teamId,
      teamName,
      teamLogo: toProxiedImage(info.logo, teamName),
      position: row.position ?? row.rank ?? null,
      played: row.played ?? row.matches ?? null,
      won: row.won ?? row.win ?? null,
      drawn: row.drawn ?? row.draw ?? null,
      lost: row.lost ?? row.lose ?? null,
      goalsFor: row.goalsFor ?? row.gf ?? null,
      goalsAgainst: row.goalsAgainst ?? row.ga ?? null,
      goalDiff: row.goalDiff ?? row.gd ?? null,
      points: row.points ?? row.pts ?? null,
    };
  }

  static lineupPlayer(entry) {
    return {
      playerId: String(entry.playerId ?? ''),
      name: entry.name ?? '',
      number: entry.number != null ? Number(entry.number) : 0,
      position: entry.position != null ? Number(entry.position) : 0,
    };
  }

  static matchEvent(e) {
    return {
      eventId: String(e.eventId ?? ''),
      minute: e.time?.elapsed != null ? String(e.time.elapsed) : null,
      type: e.type ?? null,
      playerId: e.player?.id != null ? String(e.player.id) : null,
      playerName: e.player?.name ?? null,
      assistPlayerId: e.assist?.id != null ? String(e.assist.id) : null,
    };
  }

  static matchStat(homeStat, awayStat) {
    return {
      type: homeStat?.type ?? null,
      home: homeStat?.value != null ? String(homeStat.value) : null,
      away: awayStat?.value != null ? String(awayStat.value) : null,
    };
  }
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

app.get(
  '/api/isports/leagues',
  wrap(async (req, res) => {
    await cacheGetOrSet(res, 'isports_leagues_basic', async () => {
      const raw = await isports.getLeaguesBasic();
      if (!Array.isArray(raw)) return [];
      return raw.map(DataTransformer.league);
    });
  })
);

app.get(
  '/api/isports/livescores',
  wrap(async (req, res) => {
    await cacheGetOrSet(res, 'isports_livescores', async () => {
      const raw = await isports.getLiveScores();
      if (!Array.isArray(raw)) return [];
      const teamLogos = await getLogosForMatches(raw);
      return raw.map((m) => DataTransformer.match(m, teamLogos));
    });
  })
);

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
      return raw.map((m) => DataTransformer.match(m, teamLogos));
    });
  })
);

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
      const raw = await isports.getMatchDetail(matchId);
      return raw;
    });
  })
);

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
      return raw.map(DataTransformer.team);
    });
  })
);

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
      const raw = await isports.getTeamDetail(teamId);
      return raw;
    });
  })
);

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
      const raw = await isports.getStandings(leagueId);

      if (!raw || typeof raw !== 'object') return [];

      const teamInfos = Array.isArray(raw.teamInfos) ? raw.teamInfos : [];
      const teamInfoById = {};
      for (const t of teamInfos) {
        if (t && t.teamId != null) {
          teamInfoById[String(t.teamId)] = t;
        }
      }

      const standings = Array.isArray(raw.totalStandings)
        ? raw.totalStandings
        : [];

      return standings.map((row) =>
        DataTransformer.standingRow(row, teamInfoById)
      );
    });
  })
);

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
      const raw = await isports.getLineups(matchId);
      if (!Array.isArray(raw) || raw.length === 0) {
        return { home: [], away: [], homeBackup: [], awayBackup: [] };
      }

      const m = raw[0];
      const parse = (arr) =>
        Array.isArray(arr) ? arr.map(DataTransformer.lineupPlayer) : [];

      return {
        homeFormation: m.homeFormation ?? null,
        awayFormation: m.awayFormation ?? null,
        home: parse(m.homeLineup),
        away: parse(m.awayLineup),
        homeBackup: parse(m.homeBackup),
        awayBackup: parse(m.awayBackup),
      };
    });
  })
);

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
      const raw = await isports.getMatchEvents(matchId);
      if (!Array.isArray(raw)) return [];
      return raw.map(DataTransformer.matchEvent);
    });
  })
);

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
      const raw = await isports.getMatchStats(matchId);
      if (!Array.isArray(raw) || raw.length < 2) return [];

      const homeStats = Array.isArray(raw[0]?.statistics)
        ? raw[0].statistics
        : [];
      const awayStats = Array.isArray(raw[1]?.statistics)
        ? raw[1].statistics
        : [];

      const out = [];
      for (let i = 0; i < homeStats.length; i++) {
        out.push(DataTransformer.matchStat(homeStats[i], awayStats[i]));
      }
      return out;
    });
  })
);

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
/**
 * GET /api/isports/avatar?name=Deportes%20Santa%20Cruz
 *
 * Returns a small SVG with the first letters of the first two words of the
 * name, on a color derived deterministically from the name. Used as a
 * fallback when iSportsAPI has no logo for a team.
 */
app.get('/api/isports/avatar', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const rawName = (req.query.name || '?').toString();
  const name = rawName.trim().slice(0, 60); // cap length

  // Take first character of the first two words, uppercase.
  const words = name.split(/\s+/).filter(Boolean);
  const initials =
    (words[0]?.[0] || '?').toUpperCase() +
    (words[1]?.[0] || '').toUpperCase();

  // Deterministic hue from the name.
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
  res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 days
  res.send(svg);
});

// ============ IMAGE PROXY ============
app.get(
  '/api/isports/image',
  wrap(async (req, res) => {
    // Set CORS early so it's present on every response path.
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
    version: '1.3.0',
    description:
      'Express proxy for iSportsAPI with CORS, caching, per-league logo enrichment, and monogram fallback',
    baseUrl: `http://localhost:${PORT}`,
    endpoints: [
      { path: '/api/isports/leagues', method: 'GET', params: [], example: '/api/isports/leagues' },
      { path: '/api/isports/livescores', method: 'GET', params: [], example: '/api/isports/livescores' },
      { path: '/api/isports/schedule', method: 'GET', params: ['date'], example: '/api/isports/schedule?date=2026-09-15' },
      { path: '/api/isports/match', method: 'GET', params: ['matchId'], example: '/api/isports/match?matchId=12345' },
      { path: '/api/isports/teams', method: 'GET', params: ['leagueId (optional)'], example: '/api/isports/teams?leagueId=133' },
      { path: '/api/isports/team', method: 'GET', params: ['teamId'], example: '/api/isports/team?teamId=7' },
      { path: '/api/isports/standings', method: 'GET', params: ['leagueId'], example: '/api/isports/standings?leagueId=133' },
      { path: '/api/isports/lineups', method: 'GET', params: ['matchId'], example: '/api/isports/lineups?matchId=12345' },
      { path: '/api/isports/events', method: 'GET', params: ['matchId'], example: '/api/isports/events?matchId=12345' },
      { path: '/api/isports/stats', method: 'GET', params: ['matchId'], example: '/api/isports/stats?matchId=12345' },
      { path: '/api/isports/player', method: 'GET', params: ['playerId'], example: '/api/isports/player?playerId=999' },
      { path: '/api/isports/image', method: 'GET', params: ['url'], example: '/api/isports/image?url=http%3A%2F%2Fzq.titan007.com%2F...' },
      { path: '/api/isports/avatar', method: 'GET', params: ['name'], example: '/api/isports/avatar?name=Deportes%20Santa%20Cruz' },
    ],
    systemEndpoints: [
      { path: '/api/health', method: 'GET', description: 'Health check' },
      { path: '/api/cache/stats', method: 'GET', description: 'Cache statistics' },
      { path: '/api/cache/clear', method: 'POST', description: 'Clear cache' },
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
  console.log(`\n🚀 iSportsAPI Proxy v1.3`);
  console.log(`📡 http://localhost:${PORT}`);
  console.log(`\n📊 Endpoints:`);
  console.log(`  - Leagues:   /api/isports/leagues`);
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