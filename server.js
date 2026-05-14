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

const PORT = 3737;
const DIR  = __dirname;

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

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':                'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'null', // file:// and localhost only
    'Cache-Control':               'no-store',
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

// Prevent path traversal — only serve files within DIR
function safeFilePath(urlPathname) {
  const rel      = urlPathname === '/' ? 'index.html' : urlPathname.slice(1);
  const resolved = path.resolve(DIR, rel);
  // Must stay within the project directory
  if (!resolved.startsWith(DIR + path.sep) && resolved !== DIR) return null;
  // Block access to .md source files and Node scripts from the browser
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.md') return null;
  return resolved;
}

// ── Request handler ───────────────────────────────────────────────────────

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

    return sendJSON(res, 200, {
      ok:         true,
      totalIdeas: meta.totalIdeas,
      lastFileDate: meta.lastFileDate,
      log:        result.stdout,
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
