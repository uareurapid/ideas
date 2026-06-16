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

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    if (process.env[key] != null) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3737);
const HOST = process.env.HOST || '0.0.0.0';
const DIR  = __dirname;

const DB_PATH = process.env.VOTES_DB_PATH
  ? path.resolve(process.env.VOTES_DB_PATH)
  : path.join(DIR, 'votes.sqlite');

const COOKIE_NAME      = process.env.VOTER_COOKIE_NAME || 'biz_voter';
const COOKIE_MAX_AGE_S = Number(process.env.VOTER_COOKIE_MAX_AGE_S || 60 * 60 * 24 * 365);
const COOKIE_SECURE    = process.env.VOTER_COOKIE_SECURE === '1';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_COOKIE_NAME = process.env.ADMIN_COOKIE_NAME || 'biz_admin';
const ADMIN_SESSION_TTL_S = Number(process.env.ADMIN_SESSION_TTL_S || 60 * 60 * 12);
const ADMIN_COOKIE_SECURE = process.env.ADMIN_COOKIE_SECURE === '1' || COOKIE_SECURE;
const ADMIN_SESSION_CLEANUP_MS = Number(process.env.ADMIN_SESSION_CLEANUP_MS || 10 * 60 * 1000);

const RATE_LIMIT_WINDOW_MS = Number(process.env.VOTE_RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX_WRITES = Number(process.env.VOTE_RATE_LIMIT_MAX_WRITES || 90);

const SUBMISSION_WINDOW_MS = Number(process.env.SUBMISSION_WINDOW_MS || 24 * 60 * 60 * 1000);
const SUBMISSION_DAILY_LIMIT = Number(process.env.SUBMISSION_DAILY_LIMIT || 1);
const SUBMISSION_TITLE_MAX = Number(process.env.SUBMISSION_TITLE_MAX || 140);
const SUBMISSION_NICK_MAX = Number(process.env.SUBMISSION_NICK_MAX || 40);
const SUBMISSION_DESC_MAX = Number(process.env.SUBMISSION_DESC_MAX || 1600);
const SUBMISSION_CONTACT_MAX = Number(process.env.SUBMISSION_CONTACT_MAX || 120);

const DIMS = ['feasibility', 'speed', 'gap', 'demand'];
const DIM_SET = new Set(DIMS);
const CATEGORY_SET = new Set(['general', 'developer', 'mobile']);
const SUBMISSION_STATUS_SET = new Set(['pending_approval', 'approved', 'rejected']);

const writeBuckets = new Map();
const adminSessions = new Map();
let lastAdminSessionCleanup = 0;
let IDEA_IDS = new Set();

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

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

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  voter_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('general', 'developer', 'mobile')),
  contact TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'rejected')),
  submitted_at INTEGER NOT NULL,
  approved_at INTEGER,
  approved_by TEXT,
  rejected_at INTEGER,
  rejected_by TEXT,
  rejection_reason TEXT,
  published_as_idea_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_category ON submissions(category);
CREATE INDEX IF NOT EXISTS idx_submissions_voter_submitted_at ON submissions(voter_id, submitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_published_idea_id
  ON submissions(published_as_idea_id)
  WHERE published_as_idea_id IS NOT NULL;
`);

function submissionsSchemaHasMobileCategory() {
  const row = db.prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table' AND name = 'submissions'
    LIMIT 1
  `).get();

  const schemaSql = String((row && row.sql) || '').toLowerCase();
  return schemaSql.includes("'mobile'");
}

const migrateSubmissionsSchemaTx = db.transaction(() => {
  db.exec(`
    ALTER TABLE submissions RENAME TO submissions_legacy;

    CREATE TABLE submissions (
      id TEXT PRIMARY KEY,
      voter_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('general', 'developer', 'mobile')),
      contact TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'rejected')),
      submitted_at INTEGER NOT NULL,
      approved_at INTEGER,
      approved_by TEXT,
      rejected_at INTEGER,
      rejected_by TEXT,
      rejection_reason TEXT,
      published_as_idea_id TEXT
    );

    INSERT INTO submissions (
      id,
      voter_id,
      nickname,
      title,
      description,
      category,
      contact,
      status,
      submitted_at,
      approved_at,
      approved_by,
      rejected_at,
      rejected_by,
      rejection_reason,
      published_as_idea_id
    )
    SELECT
      id,
      voter_id,
      nickname,
      title,
      description,
      category,
      contact,
      status,
      submitted_at,
      approved_at,
      approved_by,
      rejected_at,
      rejected_by,
      rejection_reason,
      published_as_idea_id
    FROM submissions_legacy;

    DROP TABLE submissions_legacy;

    CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
    CREATE INDEX IF NOT EXISTS idx_submissions_category ON submissions(category);
    CREATE INDEX IF NOT EXISTS idx_submissions_voter_submitted_at ON submissions(voter_id, submitted_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_published_idea_id
      ON submissions(published_as_idea_id)
      WHERE published_as_idea_id IS NOT NULL;
  `);
});

if (!submissionsSchemaHasMobileCategory()) {
  migrateSubmissionsSchemaTx();
}

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

const countRecentSubmissionsStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM submissions
  WHERE voter_id = ? AND submitted_at >= ?
`);

const insertSubmissionStmt = db.prepare(`
  INSERT INTO submissions (
    id, voter_id, nickname, title, description, category, contact, status, submitted_at
  )
  VALUES (
    @id, @voter_id, @nickname, @title, @description, @category, @contact, @status, @submitted_at
  )
`);

const approvedIdeaIdsStmt = db.prepare(`
  SELECT published_as_idea_id
  FROM submissions
  WHERE status = 'approved' AND published_as_idea_id IS NOT NULL
`);

const approvedSubmissionIdeasStmt = db.prepare(`
  SELECT
    id,
    nickname,
    title,
    description,
    category,
    approved_at,
    submitted_at,
    published_as_idea_id
  FROM submissions
  WHERE status = 'approved' AND published_as_idea_id IS NOT NULL
  ORDER BY approved_at DESC, submitted_at DESC
  LIMIT ?
`);

const getSubmissionByIdStmt = db.prepare(`
  SELECT
    id,
    voter_id,
    nickname,
    title,
    description,
    category,
    contact,
    status,
    submitted_at,
    approved_at,
    approved_by,
    rejected_at,
    rejected_by,
    rejection_reason,
    published_as_idea_id
  FROM submissions
  WHERE id = ?
`);

const listSubmissionsAllStmt = db.prepare(`
  SELECT
    id,
    voter_id,
    nickname,
    title,
    description,
    category,
    contact,
    status,
    submitted_at,
    approved_at,
    approved_by,
    rejected_at,
    rejected_by,
    rejection_reason,
    published_as_idea_id
  FROM submissions
  ORDER BY submitted_at DESC
  LIMIT ? OFFSET ?
`);

const listSubmissionsByStatusStmt = db.prepare(`
  SELECT
    id,
    voter_id,
    nickname,
    title,
    description,
    category,
    contact,
    status,
    submitted_at,
    approved_at,
    approved_by,
    rejected_at,
    rejected_by,
    rejection_reason,
    published_as_idea_id
  FROM submissions
  WHERE status = ?
  ORDER BY submitted_at DESC
  LIMIT ? OFFSET ?
`);

const listSubmissionsByCategoryStmt = db.prepare(`
  SELECT
    id,
    voter_id,
    nickname,
    title,
    description,
    category,
    contact,
    status,
    submitted_at,
    approved_at,
    approved_by,
    rejected_at,
    rejected_by,
    rejection_reason,
    published_as_idea_id
  FROM submissions
  WHERE category = ?
  ORDER BY submitted_at DESC
  LIMIT ? OFFSET ?
`);

const listSubmissionsByStatusAndCategoryStmt = db.prepare(`
  SELECT
    id,
    voter_id,
    nickname,
    title,
    description,
    category,
    contact,
    status,
    submitted_at,
    approved_at,
    approved_by,
    rejected_at,
    rejected_by,
    rejection_reason,
    published_as_idea_id
  FROM submissions
  WHERE status = ? AND category = ?
  ORDER BY submitted_at DESC
  LIMIT ? OFFSET ?
`);

const countSubmissionsAllStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM submissions
`);

const countSubmissionsByStatusStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM submissions
  WHERE status = ?
`);

const countSubmissionsByCategoryStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM submissions
  WHERE category = ?
`);

const countSubmissionsByStatusAndCategoryStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM submissions
  WHERE status = ? AND category = ?
`);

const approveSubmissionStmt = db.prepare(`
  UPDATE submissions
  SET
    status = 'approved',
    approved_at = @approved_at,
    approved_by = @approved_by,
    rejected_at = NULL,
    rejected_by = NULL,
    rejection_reason = NULL,
    published_as_idea_id = @published_as_idea_id
  WHERE id = @id AND status = 'pending_approval'
`);

const rejectSubmissionStmt = db.prepare(`
  UPDATE submissions
  SET
    status = 'rejected',
    rejected_at = @rejected_at,
    rejected_by = @rejected_by,
    rejection_reason = @rejection_reason
  WHERE id = @id AND status = 'pending_approval'
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

function getApprovedIdeaIds() {
  return approvedIdeaIdsStmt
    .all()
    .map(row => row.published_as_idea_id)
    .filter(Boolean);
}

function refreshIdeaIds() {
  const generated = getIdeasData().map(idea => idea.id).filter(Boolean);
  IDEA_IDS = new Set([...generated, ...getApprovedIdeaIds()]);
}

function sanitizeSingleLine(value, maxLength) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';
  return text.slice(0, Math.max(1, maxLength));
}

function sanitizeMultiline(value, maxLength) {
  const text = String(value == null ? '' : value)
    .replace(/\r\n/g, '\n')
    .trim();

  if (!text) return '';
  return text.slice(0, Math.max(1, maxLength));
}

function normalizeCategory(value) {
  const category = sanitizeSingleLine(value, 24).toLowerCase();
  return CATEGORY_SET.has(category) ? category : '';
}

function formatDateYmd(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildSubmissionId() {
  return `sub_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function buildApprovedIdeaId(submission, takenIds) {
  const datePart = formatDateYmd(Date.now());
  const slug = slugify(submission.title).slice(0, 24) || 'visitor-idea';

  let candidate = `${datePart}-v-1-${slug}`;
  let n = 2;
  while (takenIds.has(candidate)) {
    candidate = `${datePart}-v-${n}-${slug}`;
    n += 1;
  }

  return candidate;
}

function submissionRowToIdea(row) {
  const publishTs = Number(row.approved_at) || Number(row.submitted_at) || Date.now();
  return {
    id: row.published_as_idea_id,
    date: formatDateYmd(publishTs),
    category: row.category,
    title: row.title,
    description: row.description,
    sourceFile: 'visitor-submissions',
    submittedBy: row.nickname,
    submittedAt: Number(row.submitted_at) || null,
    approvedAt: Number(row.approved_at) || null,
  };
}

function submissionRowToAdminDto(row) {
  return {
    id: row.id,
    voterId: row.voter_id,
    nickname: row.nickname,
    title: row.title,
    description: row.description,
    category: row.category,
    contact: row.contact,
    status: row.status,
    submittedAt: Number(row.submitted_at) || null,
    approvedAt: Number(row.approved_at) || null,
    approvedBy: row.approved_by || null,
    rejectedAt: Number(row.rejected_at) || null,
    rejectedBy: row.rejected_by || null,
    rejectionReason: row.rejection_reason || null,
    publishedIdeaId: row.published_as_idea_id || null,
  };
}

function toIntWithin(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const intVal = Math.floor(n);
  if (intVal < min) return min;
  if (intVal > max) return max;
  return intVal;
}

function hasAdminCredentials() {
  return Boolean(ADMIN_USERNAME && ADMIN_PASSWORD);
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function buildAdminCookie(token) {
  const parts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${ADMIN_SESSION_TTL_S}`,
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (ADMIN_COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

function buildClearAdminCookie() {
  const parts = [
    `${ADMIN_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (ADMIN_COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

function cleanupAdminSessions() {
  const now = Date.now();
  if (now - lastAdminSessionCleanup < ADMIN_SESSION_CLEANUP_MS) return;
  lastAdminSessionCleanup = now;

  for (const [token, session] of adminSessions.entries()) {
    if (!session || session.expiresAt <= now) adminSessions.delete(token);
  }
}

function createAdminSession(headers, username) {
  cleanupAdminSessions();
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + (ADMIN_SESSION_TTL_S * 1000);
  adminSessions.set(token, { username, expiresAt });
  headers['Set-Cookie'] = buildAdminCookie(token);
}

function getAdminSession(req) {
  cleanupAdminSessions();
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[ADMIN_COOKIE_NAME];
  if (!token) return null;

  const session = adminSessions.get(token);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return null;
  }

  return { token, username: session.username };
}

function clearAdminSession(req, headers) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[ADMIN_COOKIE_NAME];
  if (token) adminSessions.delete(token);
  headers['Set-Cookie'] = buildClearAdminCookie();
}

function requireAdminSession(req, res, headers) {
  const session = getAdminSession(req);
  if (!session) {
    sendJSON(res, 401, { ok: false, error: 'Admin authentication required' }, headers);
    return null;
  }

  return session;
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
  if (path.basename(resolved).startsWith('.env')) return null;
  if (resolved === DB_PATH || resolved === `${DB_PATH}-wal` || resolved === `${DB_PATH}-shm`) return null;
  return resolved;
}

// ── Request handler ───────────────────────────────────────────────────────

refreshIdeaIds();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const adminActionMatch = req.method === 'POST'
    ? url.pathname.match(/^\/api\/admin\/submissions\/([^/]+)\/(approve|reject)$/)
    : null;

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

  // ── GET /api/health ──────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      service: 'business-ideas-api',
      now: Date.now(),
      adminConfigured: hasAdminCredentials(),
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

  // ── GET /api/submissions/approved ───────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/submissions/approved') {
    const limit = toIntWithin(url.searchParams.get('limit'), 250, 1, 1000);
    const rows = approvedSubmissionIdeasStmt.all(limit);
    const ideas = rows
      .map(submissionRowToIdea)
      .filter(idea => idea.id && idea.title && idea.description && CATEGORY_SET.has(idea.category));

    return sendJSON(res, 200, {
      ideas,
      total: ideas.length,
    });
  }

  // ── POST /api/submissions ───────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/submissions') {
    const headers = {};
    const voterId = ensureVoterId(req, headers);

    if (isWriteRateLimited(getClientIp(req), voterId)) {
      return sendJSON(res, 429, {
        ok: false,
        error: 'Too many submission actions. Please wait a moment and try again.',
      }, headers);
    }

    return readJsonBody(req, 128 * 1024)
      .then((payload) => {
        const nickname = sanitizeSingleLine(payload.nickname, SUBMISSION_NICK_MAX);
        const title = sanitizeSingleLine(payload.title, SUBMISSION_TITLE_MAX);
        const description = sanitizeMultiline(payload.description, SUBMISSION_DESC_MAX);
        const category = normalizeCategory(payload.category);
        const contact = sanitizeSingleLine(payload.contact, SUBMISSION_CONTACT_MAX) || null;

        if (!nickname || nickname.length < 2) {
          return sendJSON(res, 400, { ok: false, error: 'Nickname is required (min 2 characters).' }, headers);
        }

        if (!title || title.length < 8) {
          return sendJSON(res, 400, { ok: false, error: 'Title is required (min 8 characters).' }, headers);
        }

        if (!description || description.length < 20) {
          return sendJSON(res, 400, { ok: false, error: 'Description is required (min 20 characters).' }, headers);
        }

        if (!category) {
          return sendJSON(res, 400, { ok: false, error: 'Category must be general, developer, or mobile.' }, headers);
        }

        const now = Date.now();
        const since = now - Math.max(60_000, SUBMISSION_WINDOW_MS);
        const recent = countRecentSubmissionsStmt.get(voterId, since);
        const submittedRecently = Number(recent && recent.total) || 0;

        if (submittedRecently >= Math.max(1, SUBMISSION_DAILY_LIMIT)) {
          return sendJSON(res, 429, {
            ok: false,
            error: 'Daily submission limit reached. Please try again tomorrow.',
          }, headers);
        }

        const id = buildSubmissionId();
        insertSubmissionStmt.run({
          id,
          voter_id: voterId,
          nickname,
          title,
          description,
          category,
          contact,
          status: 'pending_approval',
          submitted_at: now,
        });

        return sendJSON(res, 201, {
          ok: true,
          submission: {
            id,
            nickname,
            title,
            category,
            status: 'pending_approval',
            submittedAt: now,
          },
          remainingToday: Math.max(0, Math.max(1, SUBMISSION_DAILY_LIMIT) - submittedRecently - 1),
        }, headers);
      })
      .catch((error) => {
        const status = error.statusCode || 400;
        return sendJSON(res, status, { ok: false, error: error.message || 'Invalid request body' }, headers);
      });
  }

  // ── POST /api/admin/login ────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    const headers = {};

    if (!hasAdminCredentials()) {
      return sendJSON(res, 503, {
        ok: false,
        error: 'Admin credentials are not configured on the server.',
      }, headers);
    }

    return readJsonBody(req)
      .then((payload) => {
        const username = sanitizeSingleLine(payload.username, 120);
        const password = String(payload.password == null ? '' : payload.password);

        const validUser = constantTimeEqual(username, ADMIN_USERNAME);
        const validPass = constantTimeEqual(password, ADMIN_PASSWORD);
        if (!validUser || !validPass) {
          return sendJSON(res, 401, { ok: false, error: 'Invalid admin credentials' }, headers);
        }

        createAdminSession(headers, ADMIN_USERNAME);
        return sendJSON(res, 200, {
          ok: true,
          admin: { username: ADMIN_USERNAME },
        }, headers);
      })
      .catch((error) => {
        const status = error.statusCode || 400;
        return sendJSON(res, status, { ok: false, error: error.message || 'Invalid request body' }, headers);
      });
  }

  // ── POST /api/admin/logout ───────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    const headers = {};
    clearAdminSession(req, headers);
    return sendJSON(res, 200, { ok: true }, headers);
  }

  // ── GET /api/admin/me ────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/admin/me') {
    if (!hasAdminCredentials()) {
      return sendJSON(res, 200, {
        authenticated: false,
        configured: false,
      });
    }

    const session = getAdminSession(req);
    if (!session) {
      return sendJSON(res, 200, {
        authenticated: false,
        configured: true,
      });
    }

    return sendJSON(res, 200, {
      authenticated: true,
      configured: true,
      admin: { username: session.username },
    });
  }

  // ── GET /api/admin/submissions ───────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/admin/submissions') {
    const headers = {};
    const session = requireAdminSession(req, res, headers);
    if (!session) return;

    const status = sanitizeSingleLine(url.searchParams.get('status') || 'pending_approval', 24);
    const category = sanitizeSingleLine(url.searchParams.get('category') || 'all', 24).toLowerCase();
    const limit = toIntWithin(url.searchParams.get('limit'), 40, 1, 200);
    const offset = toIntWithin(url.searchParams.get('offset'), 0, 0, 20_000);

    if (status !== 'all' && !SUBMISSION_STATUS_SET.has(status)) {
      return sendJSON(res, 400, { ok: false, error: 'Invalid status filter' }, headers);
    }

    if (category !== 'all' && !CATEGORY_SET.has(category)) {
      return sendJSON(res, 400, { ok: false, error: 'Invalid category filter' }, headers);
    }

    let rows;
    let total;

    if (status === 'all' && category === 'all') {
      rows = listSubmissionsAllStmt.all(limit, offset);
      total = Number(countSubmissionsAllStmt.get().total) || 0;
    } else if (status === 'all') {
      rows = listSubmissionsByCategoryStmt.all(category, limit, offset);
      total = Number(countSubmissionsByCategoryStmt.get(category).total) || 0;
    } else if (category === 'all') {
      rows = listSubmissionsByStatusStmt.all(status, limit, offset);
      total = Number(countSubmissionsByStatusStmt.get(status).total) || 0;
    } else {
      rows = listSubmissionsByStatusAndCategoryStmt.all(status, category, limit, offset);
      total = Number(countSubmissionsByStatusAndCategoryStmt.get(status, category).total) || 0;
    }

    return sendJSON(res, 200, {
      ok: true,
      status,
      category,
      total,
      submissions: rows.map(submissionRowToAdminDto),
      admin: { username: session.username },
    }, headers);
  }

  // ── POST /api/admin/submissions/:id/(approve|reject) ────────────────
  if (adminActionMatch) {
    const headers = {};
    const session = requireAdminSession(req, res, headers);
    if (!session) return;

    const submissionId = decodeURIComponent(adminActionMatch[1]);
    const action = adminActionMatch[2];

    if (!submissionId || submissionId.length > 120) {
      return sendJSON(res, 400, { ok: false, error: 'Invalid submission ID' }, headers);
    }

    if (action === 'approve') {
      const target = getSubmissionByIdStmt.get(submissionId);
      if (!target) {
        return sendJSON(res, 404, { ok: false, error: 'Submission not found' }, headers);
      }
      if (target.status !== 'pending_approval') {
        return sendJSON(res, 409, { ok: false, error: `Submission is already ${target.status}` }, headers);
      }

      const takenIds = new Set(IDEA_IDS);
      const ideaId = target.published_as_idea_id || buildApprovedIdeaId(target, takenIds);
      const now = Date.now();

      const result = approveSubmissionStmt.run({
        id: submissionId,
        approved_at: now,
        approved_by: session.username,
        published_as_idea_id: ideaId,
      });

      if (!result.changes) {
        return sendJSON(res, 409, { ok: false, error: 'Submission can no longer be approved' }, headers);
      }

      refreshIdeaIds();
      const updated = getSubmissionByIdStmt.get(submissionId);
      return sendJSON(res, 200, {
        ok: true,
        submission: submissionRowToAdminDto(updated),
        idea: submissionRowToIdea(updated),
      }, headers);
    }

    return readJsonBody(req)
      .then((payload) => {
        const reason = sanitizeMultiline(payload.reason || '', 300);
        const now = Date.now();

        const target = getSubmissionByIdStmt.get(submissionId);
        if (!target) {
          return sendJSON(res, 404, { ok: false, error: 'Submission not found' }, headers);
        }

        if (target.status !== 'pending_approval') {
          return sendJSON(res, 409, { ok: false, error: `Submission is already ${target.status}` }, headers);
        }

        const result = rejectSubmissionStmt.run({
          id: submissionId,
          rejected_at: now,
          rejected_by: session.username,
          rejection_reason: reason || null,
        });

        if (!result.changes) {
          return sendJSON(res, 409, { ok: false, error: 'Submission can no longer be rejected' }, headers);
        }

        const updated = getSubmissionByIdStmt.get(submissionId);
        return sendJSON(res, 200, {
          ok: true,
          submission: submissionRowToAdminDto(updated),
        }, headers);
      })
      .catch((error) => {
        const status = error.statusCode || 400;
        return sendJSON(res, status, { ok: false, error: error.message || 'Invalid request body' }, headers);
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

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Business Ideas Archive — Server ready  ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n   ➜  http://${displayHost}:${PORT}\n`);
  console.log('   The app will auto-detect new .md files on each page load.');
  console.log(`   Votes DB: ${DB_PATH}`);
  console.log(`   Submissions daily limit: ${Math.max(1, SUBMISSION_DAILY_LIMIT)} per ${Math.round(Math.max(60_000, SUBMISSION_WINDOW_MS) / 3600000)}h window`);
  if (hasAdminCredentials()) {
    console.log(`   Admin user configured: ${ADMIN_USERNAME}`);
  } else {
    console.log('   Admin user configured: no (set ADMIN_USERNAME and ADMIN_PASSWORD to enable moderation login)');
  }
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
