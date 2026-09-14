const express = require('express');
const NodeCache = require('node-cache');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

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
    // Read from env in production. Never commit the real key.
    apiKey: process.env.ISPORTS_API_KEY || 'ycOrrj2NLYdzuOBr',
  },
  cache: {
    stdTTL: 60, // live data changes fast; 60s is a sane default
    checkperiod: 60,
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

  /**
   * Build a fully-qualified iSportsAPI URL with api_key injected.
   * All other query params are passed through unchanged.
   */
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

  /**
   * Fetch with timeout. Uses global fetch (Node 18+).
   */
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

      // iSportsAPI envelope: { code, message, data }
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
      this.buildUrl('/sport/football/team', { leagueId })
    );
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

// ============ DATA TRANSFORMERS ============
//
// iSportsAPI returns arrays of raw objects. We normalise field names so the
// Flutter side has one consistent shape regardless of upstream quirks.
//
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

  static match(m) {
    return {
      matchId: String(m.matchId ?? ''),
      leagueId: String(m.leagueId ?? ''),
      leagueName: m.leagueName ?? m.league?.name ?? '',
      homeTeamId: String(m.homeId ?? m.homeTeamId ?? ''),
      homeTeamName: m.homeName ?? m.homeTeam?.name ?? '',
      homeScore: m.homeScore ?? null,
      awayTeamId: String(m.awayId ?? m.awayTeamId ?? ''),
      awayTeamName: m.awayName ?? m.awayTeam?.name ?? '',
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
      logo: t.logo ?? '',
      foundingDate: t.foundingDate ?? '',
    };
  }

  static standingRow(row, teamInfoById) {
    const teamId = String(row.teamId ?? '');
    const info = teamInfoById[teamId] || {};
    return {
      teamId,
      teamName: info.name ?? row.name ?? '',
      teamLogo: info.logo ?? '',
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

/**
 * GET /api/isports/leagues
 * All leagues (basic).
 */
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

/**
 * GET /api/isports/livescores
 * All currently live matches.
 */
app.get(
  '/api/isports/livescores',
  wrap(async (req, res) => {
    await cacheGetOrSet(res, 'isports_livescores', async () => {
      const raw = await isports.getLiveScores();
      if (!Array.isArray(raw)) return [];
      return raw.map(DataTransformer.match);
    });
  })
);

/**
 * GET /api/isports/schedule?date=YYYY-MM-DD
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
      return raw.map(DataTransformer.match);
    });
  })
);

/**
 * GET /api/isports/match?matchId=...
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
      const raw = await isports.getMatchDetail(matchId);
      return raw;
    });
  })
);

/**
 * GET /api/isports/teams?leagueId=...
 * Teams for a specific league. Avoid the unfiltered /team call — it's 16 MB.
 */
app.get(
  '/api/isports/teams',
  wrap(async (req, res) => {
    const { leagueId } = req.query;
    if (!leagueId) {
      return res.status(400).json({
        success: false,
        error: 'leagueId parameter is required',
        usage: '/api/isports/teams?leagueId=133',
      });
    }

    await cacheGetOrSet(res, `isports_teams_${leagueId}`, async () => {
      const raw = await isports.getTeamsByLeague(leagueId);
      if (!Array.isArray(raw)) return [];
      return raw.map(DataTransformer.team);
    });
  })
);

/**
 * GET /api/isports/team?teamId=...
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
      const raw = await isports.getTeamDetail(teamId);
      return raw;
    });
  })
);

/**
 * GET /api/isports/standings?leagueId=...
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
      const raw = await isports.getStandings(leagueId);

      // iSportsAPI returns { teamInfos: [...], totalStandings: [...] }
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

/**
 * GET /api/isports/lineups?matchId=...
 * Returns { home: [...], away: [...], homeBackup: [...], awayBackup: [...] }
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

/**
 * GET /api/isports/events?matchId=...
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
      const raw = await isports.getMatchEvents(matchId);
      if (!Array.isArray(raw)) return [];
      return raw.map(DataTransformer.matchEvent);
    });
  })
);

/**
 * GET /api/isports/stats?matchId=...
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

/**
 * GET /api/isports/player?playerId=...
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

// ============ SYSTEM ENDPOINTS ============

app.post('/api/cache/clear', (req, res) => {
  cache.flushAll();
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
    timestamp: new Date().toISOString(),
  });
});

// ============ ROOT DOCS ============
app.get('/', (req, res) => {
  res.json({
    name: 'iSportsAPI Proxy',
    version: '1.0.0',
    description:
      'Express proxy for iSportsAPI with CORS, caching, and normalised shapes',
    baseUrl: `http://localhost:${PORT}`,
    endpoints: [
      {
        path: '/api/isports/leagues',
        method: 'GET',
        params: [],
        example: '/api/isports/leagues',
      },
      {
        path: '/api/isports/livescores',
        method: 'GET',
        params: [],
        example: '/api/isports/livescores',
      },
      {
        path: '/api/isports/schedule',
        method: 'GET',
        params: ['date'],
        example: '/api/isports/schedule?date=2026-09-15',
      },
      {
        path: '/api/isports/match',
        method: 'GET',
        params: ['matchId'],
        example: '/api/isports/match?matchId=12345',
      },
      {
        path: '/api/isports/teams',
        method: 'GET',
        params: ['leagueId'],
        example: '/api/isports/teams?leagueId=133',
      },
      {
        path: '/api/isports/team',
        method: 'GET',
        params: ['teamId'],
        example: '/api/isports/team?teamId=7',
      },
      {
        path: '/api/isports/standings',
        method: 'GET',
        params: ['leagueId'],
        example: '/api/isports/standings?leagueId=133',
      },
      {
        path: '/api/isports/lineups',
        method: 'GET',
        params: ['matchId'],
        example: '/api/isports/lineups?matchId=12345',
      },
      {
        path: '/api/isports/events',
        method: 'GET',
        params: ['matchId'],
        example: '/api/isports/events?matchId=12345',
      },
      {
        path: '/api/isports/stats',
        method: 'GET',
        params: ['matchId'],
        example: '/api/isports/stats?matchId=12345',
      },
      {
        path: '/api/isports/player',
        method: 'GET',
        params: ['playerId'],
        example: '/api/isports/player?playerId=999',
      },
    ],
    systemEndpoints: [
      { path: '/api/health', method: 'GET', description: 'Health check' },
      {
        path: '/api/cache/stats',
        method: 'GET',
        description: 'Cache statistics',
      },
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
  console.log(`\n🚀 iSportsAPI Proxy v1.0`);
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
  console.log(`\n📖 Docs: http://localhost:${PORT}/\n`);
});
