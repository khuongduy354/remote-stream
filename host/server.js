import http from 'node:http';
import net from 'node:net';
import { readFile, mkdir, chmod, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { config, number, withResolution } from './media.js';
import { StreamSession } from './stream-session.js';
import { createDesktop, desktopAvailable } from './desktops.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = path.resolve(process.env.STATE_DIR || path.join(root, '.state'));
await mkdir(state, { recursive: true, mode: 0o700 }); await chmod(state, 0o700);
const bind = process.env.BIND || '127.0.0.1', port = number(process.env.PORT, 8787, 1024, 65535);
if (!['127.0.0.1', 'localhost', '::1'].includes(bind) && !process.env.PUBLIC_ORIGIN) throw Error('Set PUBLIC_ORIGIN to the exact viewer origin for LAN/VPN use');
const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
const origins = new Set([origin, `http://localhost:${port}`, `http://127.0.0.1:${port}`, ...(process.env.EXTRA_ORIGINS || '').split(',').filter(Boolean)]);
const sessions = new Map(), inputPath = path.join(root, 'host/input.py');
const base = config({ ...process.env, SOURCE: 'test' });
let stopping = false, hostError = '';
const virtualAvailable = desktopAvailable();
const socketPath = path.join(state, 'control.sock');
// Check ownership before allocating resources or unlinking another server's socket.
await new Promise((resolve, reject) => {
  const probe = net.connect(socketPath);
  probe.once('connect', () => { probe.destroy(); reject(Error('Another instance is running')); });
  probe.once('error', e => ['ENOENT', 'ECONNREFUSED'].includes(e.code) ? resolve() : reject(e));
});
try {
  sessions.set('host', new StreamSession({ id: 'host', name: 'Main desktop', media: config(), env: { ...process.env }, inputPath }));
} catch (e) { hostError = e.message; }

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/buffer.js', ['buffer.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; media-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const session = sessions.get(url.searchParams.get('session') || 'host');
      if (!session?.role(req.headers.authorization?.replace(/^Bearer /, ''))) return json(res, 403, { error: 'Open a share link from the host panel' });
      return json(res, 200, session.status());
    }
    const asset = assets.get(url.pathname);
    if (!asset || req.method !== 'GET') return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' }); res.end(await readFile(path.join(root, 'client', asset[0])));
  } catch { if (!res.headersSent) json(res, 500, { error: 'Request failed' }); else res.end(); }
});
server.requestTimeout = 10_000; server.headersTimeout = 10_000;
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const reject = status => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  let url;
  try { url = new URL(req.url, origin); } catch { return reject('400 Bad Request'); }
  if (stopping) return reject('503 Service Unavailable');
  if (req.headers.origin && !origins.has(req.headers.origin)) return reject('403 Forbidden');
  if (!['/ws/video', '/ws/input'].includes(url.pathname)) return reject('404 Not Found');
  const session = sessions.get(url.searchParams.get('session') || 'host');
  const role = session?.role(url.searchParams.get('token'));
  if (!role || session.closed) return reject('403 Forbidden');
  let target, media, viewer;
  if (url.pathname === '/ws/input') {
    viewer = session.viewers.get(url.searchParams.get('viewer'));
    if (!viewer || viewer.input || viewer.role !== role || viewer.ws.readyState !== WebSocket.OPEN) return reject('409 Conflict');
  } else {
    if (session.viewers.size >= 4) return reject('429 Too Many Requests');
    try { target = number(url.searchParams.get('buffer') ?? undefined, 1000, 100, 5000); media = withResolution(session.media, url.searchParams); }
    catch { return reject('400 Bad Request'); }
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.on('error', () => {});
    if (viewer) session.attachInput(ws, viewer);
    else session.addViewer(ws, target, media, role, (url.searchParams.get('name') || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 40));
  });
});
async function endSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id); session.close(); await session.desktop?.close();
}
function snapshot() {
  const entries = [...sessions.values()].map(s => s.status(true));
  return { connected: entries.some(s => s.connected), inputReady: entries.some(s => s.inputReady), allowed: entries.some(s => s.allowed),
    lastError: hostError, virtualAvailable, sessions: entries };
}
async function command(request) {
  if (stopping) throw Error('Server is stopping');
  const action = request.action || 'status', id = request.session || 'host';
  if (action === 'status') return snapshot();
  if (action === 'create') {
    if (!virtualAvailable) throw Error('Install Xvfb, i3, xauth and dbus-run-session first');
    if (sessions.size >= 4) throw Error('Maximum four desktops per host');
    const name = String(request.name || 'New desktop').trim().slice(0, 60);
    if (!name) throw Error('Enter a desktop name');
    const width = number(request.width, 1280, 640, 2560), height = number(request.height, 720, 480, 1440);
    if (width % 2 || height % 2) throw Error('Desktop dimensions must be even');
    const sessionId = randomBytes(8).toString('hex');
    const desktop = await createDesktop({ id: sessionId, width, height, state, baseEnv: process.env, onExit: () => { void endSession(sessionId); } });
    if (stopping) { await desktop.close(); throw Error('Server is stopping'); }
    const session = new StreamSession({ id: sessionId, name, kind: 'virtual', inputPath, env: desktop.env,
      media: { ...base, source: 'desktop', display: desktop.display, width, height, screen: { width, height }, audio: !!desktop.audioSource, audioSource: desktop.audioSource } });
    session.desktop = desktop; sessions.set(sessionId, session);
    return { ...snapshot(), created: sessionId };
  }
  const session = sessions.get(id);
  if (!session) throw Error('Desktop no longer exists');
  if (action === 'end') { if (id === 'host') throw Error('The main desktop cannot be ended here'); await endSession(id); }
  else if (action === 'grant') session.grant(request.viewer);
  else if (action === 'revoke') session.grant(null);
  else if (action === 'allow') {
    const viewer = [...session.viewers.values()].find(v => v.role === 'control' && v.input);
    if (!viewer) throw Error('No control-capable viewer connected'); session.grant(viewer.id);
  } else if (action === 'disconnect') session.disconnect(request.viewer);
  else if (action === 'rotate') session.rotate();
  else if (action === 'audio') {
    if (typeof request.enabled !== 'boolean') throw Error('Audio must be enabled or disabled');
    if (request.enabled && !session.media.audioSource) throw Error('This desktop has no audio sink');
    session.media.audio = request.enabled;
    for (const viewer of session.viewers.keys()) session.disconnect(viewer);
  }
  else throw Error('Unknown command');
  return snapshot();
}
// All creation, destruction, tokens and control grants stay on the owner-only Unix socket.
let commands = Promise.resolve();
const control = net.createServer(socket => {
  socket.setTimeout(30_000, () => socket.destroy()); let body = '', done = false;
  socket.on('error', () => {});
  socket.on('data', data => {
    if (done) return;
    body += data; if (body.length > 4096) return socket.destroy();
    if (!body.includes('\n')) return; done = true;
    const line = body.split('\n')[0];
    commands = commands.then(async () => {
      try { const request = line.startsWith('{') ? JSON.parse(line) : { action: line.trim() }; socket.end(JSON.stringify(await command(request)) + '\n'); }
      catch (e) { socket.end(JSON.stringify({ error: e.message }) + '\n'); }
    });
  });
});
try {
  await unlink(socketPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await new Promise((resolve, reject) => { control.once('error', reject); control.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); });
  console.log(`Remote Stream: ${origin}\nOpen the host panel to create desktops and share invitation links.`);
} catch (e) { console.error(e.message); await shutdown(); process.exitCode = 1; }
async function shutdown() {
  if (stopping) return; stopping = true;
  server.close(); control.close(); for (const ws of wss.clients) ws.terminate();
  await commands; await Promise.all([...sessions.keys()].map(endSession));
  await unlink(socketPath).catch(() => {});
  setTimeout(() => process.exit(process.exitCode || 0), 1500).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
