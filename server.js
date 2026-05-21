#!/usr/bin/env node
// server.js — local development server for the Business Ideas archive
// Usage: node server.js
// Then open: http://localhost:3737

'use strict';

const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const { spawnSync } = require('child_process');
const vm          = require('vm');
const crypto      = require('crypto');
const Database    = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3737);
const DIR  = __dirname;

const DB_PATH = process.env.VOTES_DB_PATH
  ? path.resolve(process.env.VOTES_DB_PATH)
  : path.join(DIR, 'votes.sqlite');

const COOKIE_NAME      = process.env.VOTER_COOKIE_NAME || 'biz_voter';
const COOKIE_MAX_AGE_S = Number(process.env.VOTER_COOKIE_MAX_AGE_S || 60 * 60 * 24 * 365);
const COOKIE_SECURE    = process.env.VOTER_COOKIE_SECURE === '1';

const RATE_LIMIT_WINDOW_MS = Number(process.env.VOTE_RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX_WRITES = Number(process.env.VOTE_RATE_LIMIT_MAX_WRITES || 90);

const DIMS = ['feasibility', 'speed', 'gap', 'demand'];
const DIM_SET = new Set(DIMS);

const writeBuckets = new Map();
let IDEA_IDS = new Set();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS votes (
  voter_id TEXT NOT NULL,
  idea_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (voter_id, idea_id, dimension)
);

CREATE INDEX IF NOT EXISTS idx_votes_idea ON votes(idea_id);
CREATE INDEX IF NOT EXISTS idx_votes_voter ON votes(voter_id);
`);

const upsertVoteStmt = db.prepare(`
  INSERT INTO votes (voter_id, idea_id, dimension, value, updated_at)
  VALUES (@voter_id, @idea_id, @dimension, @value, @updated_at)
  ON CONFLICT(voter_id, idea_id, dimension)
  DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at
`);

const deleteVoteStmt = db.prepare(`
  DELETE FROM votes
  WHERE voter_id = ? AND idea_id = ? AND dimension = ?
`);

const hasVoteStmt = db.prepare(`
  SELECT 1
  FROM votes
  WHERE voter_id = ? AND idea_id = ? AND dimension = ?
  LIMIT 1
`);

const myVotesStmt = db.prepare(`
  SELECT idea_id, dimension, value
  FROM votes
  WHERE voter_id = ?
`);

const myIdeaVotesStmt = db.prepare(`
  SELECT dimension, value
  FROM votes
  WHERE voter_id = ? AND idea_id = ?
`);

const aggregateByIdeaStmt = db.prepare(`
  SELECT
    idea_id,
    COUNT(DISTINCT voter_id) AS voters,
    AVG(value) AS overall,
    AVG(CASE WHEN dimension = 'feasibility' THEN value END) AS feasibility,
    AVG(CASE WHEN dimension = 'speed' THEN value END) AS speed,
    AVG(CASE WHEN dimension = 'gap' THEN value END) AS gap,
    AVG(CASE WHEN dimension = 'demand' THEN value END) AS demand
  FROM votes
  WHERE idea_id = ?
  GROUP BY idea_id
`);

const allAggregatesStmt = db.prepare(`
  SELECT
    idea_id,
    COUNT(DISTINCT voter_id) AS voters,
    AVG(value) AS overall,
    AVG(CASE WHEN dimension = 'feasibility' THEN value END) AS feasibility,
    AVG(CASE WHEN dimension = 'speed' THEN value END) AS speed,
    AVG(CASE WHEN dimension = 'gap' THEN value END) AS gap,
    AVG(CASE WHEN dimension = 'demand' THEN value END) AS demand
  FROM votes
  GROUP BY idea_id
`);

const migrateVotesTx = db.transaction((voterId, entries, now) => {
  let imported = 0;
  const touched = new Set();

  for (const entry of entries) {
    const exists = hasVoteStmt.get(voterId, entry.ideaId, entry.dim);
    if (exists) continue;

    upsertVoteStmt.run({
      voter_id: voterId,
      idea_id: entry.ideaId,
      dimension: entry.dim,
      value: entry.value,
      updated_at: now,
    });

    imported += 1;
    touched.add(entry.ideaId);
  }

  return { imported, touched: [...touched] };
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// ── Helpers ───────────────────────────────────────────────────────────────

function sendJSON(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':                'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'null', // file:// and localhost only
    'Cache-Control':               'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function getMdFiles() {
  return fs.readdirSync(DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f))
    .sort();
}

function getMeta() {
  const dataPath = path.join(DIR, 'data.js');
  if (!fs.existsSync(dataPath)) return { processedFiles: [], totalIdeas: 0 };
  try {
    const code = fs.readFileSync(dataPath, 'utf8');
    const ctx  = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    return ctx.window.IDEAS_META || { processedFiles: [], totalIdeas: 0 };
  } catch (_) {
    return { processedFiles: [], totalIdeas: 0 };
  }
}

function getIdeasData() {
  const dataPath = path.join(DIR, 'data.js');
  if (!fs.existsSync(dataPath)) return [];

  try {
    const code = fs.readFileSync(dataPath, 'utf8');
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    return Array.isArray(ctx.window.IDEAS_DATA) ? ctx.window.IDEAS_DATA : [];
  } catch (_) {
    return [];
  }
}

function refreshIdeaIds() {
  IDEA_IDS = new Set(getIdeasData().map(idea => idea.id).filter(Boolean));
}

function parseCookies(rawCookieHeader) {
  const out = {};
  if (!rawCookieHeader) return out;

  rawCookieHeader.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i <= 0) return;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name) return;
    try {
      out[name] = decodeURIComponent(value);
    } catch (_) {
      out[name] = value;
    }
  });

  return out;
}

function isValidVoterId(value) {
  return typeof value === 'string' && /^[a-f0-9]{32,64}$/i.test(value);
}

function createVoterId() {
  return crypto.randomUUID().replace(/-/g, '');
}

function buildVoterCookie(voterId) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(voterId)}`,
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE_S}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

function ensureVoterId(req, headers) {
  const cookies = parseCookies(req.headers.cookie || '');
  if (isValidVoterId(cookies[COOKIE_NAME])) return cookies[COOKIE_NAME];

  const voterId = createVoterId();
  headers['Set-Cookie'] = buildVoterCookie(voterId);
  return voterId;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }

  return req.socket.remoteAddress || 'unknown';
}

function isWriteRateLimited(ip, voterId) {
  const now = Date.now();
  const key = `${ip}:${voterId}`;
  const existing = writeBuckets.get(key) || [];
  const fresh = existing.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);

  if (fresh.length >= RATE_LIMIT_MAX_WRITES) {
    writeBuckets.set(key, fresh);
    return true;
  }

  fresh.push(now);
  writeBuckets.set(key, fresh);

  if (writeBuckets.size > 25000) {
    // Keep memory bounded for long-lived processes.
    for (const [bucketKey, bucket] of writeBuckets.entries()) {
      const live = bucket.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
      if (!live.length) writeBuckets.delete(bucketKey);
      else writeBuckets.set(bucketKey, live);
      if (writeBuckets.size <= 20000) break;
    }
  }

  return false;
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let total = 0;
    const chunks = [];

    function fail(error) {
      if (resolved) return;
      resolved = true;
      reject(error);
    }

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        fail(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (resolved) return;
      resolved = true;

      if (!chunks.length) {
        resolve({});
        return;
      }

      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (_) {
        const err = new Error('Invalid JSON payload');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', fail);
  });
}

function toOptionalNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowToAggregate(row) {
  if (!row) {
    return {
      overall: null,
      voters: 0,
      dims: {
        feasibility: null,
        speed: null,
        gap: null,
        demand: null,
      },
    };
  }

  return {
    overall: toOptionalNumber(row.overall),
    voters: Number(row.voters) || 0,
    dims: {
      feasibility: toOptionalNumber(row.feasibility),
      speed: toOptionalNumber(row.speed),
      gap: toOptionalNumber(row.gap),
      demand: toOptionalNumber(row.demand),
    },
  };
}

function getMyRatings(voterId) {
  const rows = myVotesStmt.all(voterId);
  const out = {};

  for (const row of rows) {
    if (!out[row.idea_id]) out[row.idea_id] = {};
    out[row.idea_id][row.dimension] = row.value;
  }

  return out;
}

function getMyRatingForIdea(voterId, ideaId) {
  const rows = myIdeaVotesStmt.all(voterId, ideaId);
  const out = {};

  for (const row of rows) {
    out[row.dimension] = row.value;
  }

  return out;
}

function getAggregateForIdea(ideaId) {
  return rowToAggregate(aggregateByIdeaStmt.get(ideaId));
}

function getAllAggregates() {
  const rows = allAggregatesStmt.all();
  const out = {};

  for (const row of rows) {
    out[row.idea_id] = rowToAggregate(row);
  }

  return out;
}

// Prevent path traversal — only serve files within DIR
function safeFilePath(urlPathname) {
  const rel      = urlPathname === '/' ? 'index.html' : urlPathname.slice(1);
  const resolved = path.resolve(DIR, rel);
  // Must stay within the project directory
  if (!resolved.startsWith(DIR + path.sep) && resolved !== DIR) return null;
  // Block access to .md source files and Node scripts from the browser
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.md') return null;
  if (resolved === DB_PATH || resolved === `${DB_PATH}-wal` || resolved === `${DB_PATH}-shm`) return null;
  return resolved;
}

// ── Request handler ───────────────────────────────────────────────────────

refreshIdeaIds();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // ── GET /api/check ─────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/check') {
    const meta      = getMeta();
    const processed = new Set(meta.processedFiles || []);
    const actual    = getMdFiles();
    const newFiles  = actual.filter(f => !processed.has(f));

    return sendJSON(res, 200, {
      needsUpdate:   newFiles.length > 0,
      newFiles,
      currentCount:  meta.totalIdeas || 0,
      lastGenerated: meta.generatedAt || null,
      lastFileDate:  meta.lastFileDate || null,
    });
  }

  // ── POST /api/regenerate ──────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/regenerate') {
    const result = spawnSync(process.execPath, ['generate.js'], {
      cwd:      DIR,
      encoding: 'utf8',
      timeout:  30_000,
    });

    if (result.status !== 0 || result.error) {
      return sendJSON(res, 500, {
        ok:    false,
        error: result.stderr || (result.error && result.error.message) || 'Generator failed',
      });
    }

    // Read fresh meta from updated data.js
    const meta = getMeta();
    refreshIdeaIds();

    return sendJSON(res, 200, {
      ok:         true,
      totalIdeas: meta.totalIdeas,
      lastFileDate: meta.lastFileDate,
      log:        result.stdout,
    });
  }

  // ── GET /api/votes ───────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/votes') {
    const headers = {};
    const voterId = ensureVoterId(req, headers);

    return sendJSON(res, 200, {
      myRatings: getMyRatings(voterId),
      aggregates: getAllAggregates(),
      dims: DIMS,
    }, headers);
  }

  // ── POST /api/vote ───────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/vote') {
    const headers = {};
    const voterId = ensureVoterId(req, headers);

    if (isWriteRateLimited(getClientIp(req), voterId)) {
      return sendJSON(res, 429, {
        ok: false,
        error: 'Too many vote updates. Please wait a moment and try again.',
      }, headers);
    }

    return readJsonBody(req)
      .then((payload) => {
        const ideaId = typeof payload.ideaId === 'string' ? payload.ideaId : '';
        const dim = typeof payload.dim === 'string'
          ? payload.dim
          : (typeof payload.dimension === 'string' ? payload.dimension : '');
        const value = Number(payload.value);

        if (!ideaId || !IDEA_IDS.has(ideaId)) {
          return sendJSON(res, 400, { ok: false, error: 'Invalid idea ID' }, headers);
        }

        if (!DIM_SET.has(dim)) {
          return sendJSON(res, 400, { ok: false, error: 'Invalid metric dimension' }, headers);
        }

        if (!Number.isInteger(value) || value < 0 || value > 5) {
          return sendJSON(res, 400, { ok: false, error: 'Invalid value: expected integer 0-5' }, headers);
        }

        if (value === 0) {
          deleteVoteStmt.run(voterId, ideaId, dim);
        } else {
          upsertVoteStmt.run({
            voter_id: voterId,
            idea_id: ideaId,
            dimension: dim,
            value,
            updated_at: Date.now(),
          });
        }

        return sendJSON(res, 200, {
          ok: true,
          ideaId,
          myRating: getMyRatingForIdea(voterId, ideaId),
          aggregate: getAggregateForIdea(ideaId),
        }, headers);
      })
      .catch((error) => {
        const status = error.statusCode || 400;
        return sendJSON(res, status, { ok: false, error: error.message || 'Invalid request body' }, headers);
      });
  }

  // ── POST /api/votes/migrate ──────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/votes/migrate') {
    const headers = {};
    const voterId = ensureVoterId(req, headers);

    if (isWriteRateLimited(getClientIp(req), voterId)) {
      return sendJSON(res, 429, {
        ok: false,
        error: 'Too many vote updates. Please wait a moment and try again.',
      }, headers);
    }

    return readJsonBody(req, 256 * 1024)
      .then((payload) => {
        const ratings = payload && typeof payload.ratings === 'object' ? payload.ratings : null;
        if (!ratings) {
          return sendJSON(res, 400, { ok: false, error: 'Missing ratings payload' }, headers);
        }

        const entries = [];

        for (const [ideaId, rating] of Object.entries(ratings)) {
          if (!IDEA_IDS.has(ideaId) || !rating || typeof rating !== 'object') continue;

          for (const dim of DIMS) {
            const value = Number(rating[dim]);
            if (!Number.isInteger(value) || value < 1 || value > 5) continue;
            entries.push({ ideaId, dim, value });
          }
        }

        if (entries.length > 1200) {
          return sendJSON(res, 413, { ok: false, error: 'Migration payload too large' }, headers);
        }

        const result = migrateVotesTx(voterId, entries, Date.now());

        return sendJSON(res, 200, {
          ok: true,
          imported: result.imported,
          touchedIdeas: result.touched,
          myRatings: getMyRatings(voterId),
          aggregates: getAllAggregates(),
        }, headers);
      })
      .catch((error) => {
        const status = error.statusCode || 400;
        return sendJSON(res, status, { ok: false, error: error.message || 'Invalid request body' }, headers);
      });
  }

  // ── Static file serving ───────────────────────────────────────────────
  const filePath = safeFilePath(url.pathname);

  if (!filePath) {
    res.writeHead(404);
    return res.end('Not found');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type':  MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.js' ? 'no-store' : 'max-age=60',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Business Ideas Archive — Server ready  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n   ➜  http://localhost:${PORT}\n`);
  console.log('   The app will auto-detect new .md files on each page load.');
  console.log(`   Votes DB: ${DB_PATH}`);
  console.log('   Press Ctrl+C to stop.\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n✗  Port ${PORT} is already in use. Kill the other process or change PORT.\n`);
  } else {
    console.error('\n✗  Server error:', e.message);
  }
  process.exit(1);
});
