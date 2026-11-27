import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = path.resolve(process.env.STATE_DIR || path.join(root, '.state'));
await mkdir(state, { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString('hex');
const infoPath = path.join(state, 'dashboard.json');
const serviceAvailable = process.env.SERVICE_MANAGEMENT !== '0';
const execute = promisify(execFile);
function control(request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path.join(state, 'control.sock')); let data = '';
    socket.setTimeout(20_000, () => { socket.destroy(); reject(Error('Host did not respond')); });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', chunk => { data += chunk; if (data.length > 2 * 1024 * 1024) { socket.destroy(); reject(Error('Response too large')); } });
    socket.on('end', () => { try { const value = JSON.parse(data); if (value.error) reject(Error(value.error)); else resolve(value); } catch (e) { reject(e); } });
  });
}
async function origins() {
  const values = [];
  try {
    for (const line of (await readFile(path.join(state, 'service.env'), 'utf8')).split('\n')) {
      if (/^(PUBLIC_ORIGIN|EXTRA_ORIGINS)=/.test(line)) values.push(...line.slice(line.indexOf('=') + 1).split(','));
    }
  } catch {}
  values.push(process.env.PUBLIC_ORIGIN || 'http://localhost:8787');
  return [...new Set(values.map(v => v.trim()).filter(v => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } }))];
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 4096) throw Error('Request too large'); }
  return JSON.parse(data);
}
const files = new Map([['/', ['manage.html', 'text/html']], ['/manage.js', ['manage.js', 'text/javascript']], ['/manage.css', ['manage.css', 'text/css']]]);
let origin;
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  // Loopback binding alone is not a CSRF or DNS-rebinding defense.
  if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: 'Invalid host' });
  if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Invalid origin' });
  try {
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/')) {
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 403, { error: 'Open Remote Stream from your application launcher.' });
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
      if (url.pathname === '/api/state' && req.method === 'GET') {
        const addresses = await origins();
        try { const current = await control({ action: 'status' }); return json(res, 200, { ...current, running: true, origins: current.origins || addresses, serviceAvailable }); }
        catch (e) { return json(res, 200, { running: false, sessions: [], origins: addresses, serviceAvailable, error: 'Desktop server is unavailable.' }); }
      }
      if (url.pathname === '/api/preview' && req.method === 'GET') {
        const result = await control({ action: 'preview', session: url.searchParams.get('session') });
        res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(Buffer.from(result.image, 'base64'));
      }
      if (url.pathname === '/api/command' && req.method === 'POST') {
        const request = await body(req);
        if (!['create', 'end', 'grant', 'revoke', 'disconnect', 'rotate', 'audio'].includes(request.action)) return json(res, 400, { error: 'Unknown action' });
        return json(res, 200, await control(request));
      }
      if (url.pathname === '/api/service' && req.method === 'POST' && serviceAvailable) {
        const request = await body(req);
        if (!['start', 'stop'].includes(request.action)) return json(res, 400, { error: 'Unknown service action' });
        await execute('systemctl', ['--user', request.action, 'remote-stream.service'], { timeout: 15_000 });
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Not found' });
    }
    const file = files.get(url.pathname);
    if (!file || req.method !== 'GET') return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': file[1] }); res.end(await readFile(path.join(root, 'client', file[0])));
  } catch (e) { if (!res.headersSent) json(res, 400, { error: e.message }); else res.end(); }
});
server.requestTimeout = 25_000; server.headersTimeout = 10_000;
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
origin = `http://127.0.0.1:${server.address().port}`;
await writeFile(infoPath, JSON.stringify({ origin, token, pid: process.pid }), { mode: 0o600 });
// Consumed through a private pipe by panel.py. Never log the invitation to the journal.
console.log(JSON.stringify({ origin, token }));
async function close() {
  server.close(); server.closeAllConnections();
  try { const current = JSON.parse(await readFile(infoPath, 'utf8')); if (current.pid === process.pid) await unlink(infoPath); } catch {}
}
process.on('SIGTERM', close); process.on('SIGINT', close);
