#!/usr/bin/env node
/**
 * Tiny static server for local development.
 *
 *   node scripts/serve.mjs [port]
 *
 * Opening index.html directly from disk works fine too — this exists mainly
 * so edits to js/ and css/ show up on reload without fighting the browser's
 * file:// cache, which ignores ?v= query strings.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = parseInt(process.argv[2] || '5173', 10);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
    let filePath = path.join(ROOT, url === '/' ? 'index.html' : url);

    // Never serve anything outside the project directory.
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(filePath).catch(() => null);
    if (info && info.isDirectory()) filePath = path.join(filePath, 'index.html');

    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // Always revalidate so a reload picks up the latest edit.
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
    res.end(err.code === 'ENOENT' ? 'Not found' : `Error: ${err.message}`);
  }
}).listen(PORT, () => {
  console.log(`HKUST Timetable Planner → http://localhost:${PORT}`);
});
