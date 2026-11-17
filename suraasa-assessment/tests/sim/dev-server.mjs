/**
 * Local preview: the real site, the real server code and the real Sheet script,
 * with Google Sheets and the AI replaced by stand-ins. Nothing leaves this computer.
 *   npm run build && npm run dev      then open http://localhost:4173
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorld } from './world.mjs';
import { respond } from '../../api/rpc.js';

const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function startServer({ port = 4173, quiet = false } = {}) {
  const world = makeWorld();
  world.deps.now = () => Date.now() + world.skew;
  world.skew = 0;
  world.deps.random = Math.random;
  world.failTurns = 0; // tests set this to make the next N "turn" requests fail like a dropped connection
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/rpc' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      let body = {};
      try { body = JSON.parse(raw); } catch { /* empty body */ }
      if (body.action === 'turn' && world.failTurns > 0) { world.failTurns--; res.writeHead(503); res.end('upstream down'); return; }
      const out = await respond(body, world.deps);
      res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out.json));
      return;
    }
    const file = path.join(DIST, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => {
    if (!quiet) console.log(`\nLocal preview: http://localhost:${port}\nSign in as Super Admin with\n  Email: ${world.admin.email}\n  Access code: ${world.admin.code}\n\nGoogle Sheets and the AI are simulated here. The teacher gives stock replies and scores are a fixed pattern.\n`);
    resolve({ server, world, url: `http://localhost:${port}` });
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer({ port: Number(process.env.PORT) || 4173 });
