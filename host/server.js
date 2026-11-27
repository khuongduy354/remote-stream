import http from 'node:http';
import net from 'node:net';
import { readFile, mkdir, chmod, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { config, ffmpegArgs, number, withResolution } from './media.js';
import { MP4Parser } from './mp4.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const state = path.resolve(process.env.STATE_DIR || path.join(root, '.state'));
await mkdir(state, { recursive: true, mode: 0o700 });
await chmod(state, 0o700);
const c = config();
const bind = process.env.BIND || '127.0.0.1', port = number(process.env.PORT, 8787, 1024, 65535);
if (!['127.0.0.1', 'localhost', '::1'].includes(bind) && !process.env.PUBLIC_ORIGIN) throw Error('Set PUBLIC_ORIGIN to the exact viewer origin for LAN/VPN use');
const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
const origins = new Set([origin, `http://localhost:${port}`, `http://127.0.0.1:${port}`, ...(process.env.EXTRA_ORIGINS || '').split(',').filter(Boolean)]);
let video = null, input = null, inputProcess = null, inputReady = false, allowed = false, stopping = false;
let lastError = '', lastInputAt = 0;
const inputPath = path.join(root, 'host/input.py');

function send(ws, data) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function writeInput(event) {
  if (!inputReady || !inputProcess || inputProcess.stdin.destroyed) return;
  if (inputProcess.stdin.writableLength > 16384) { input?.close(1013, 'Input queue full'); revoke(); return; }
  inputProcess.stdin.write(JSON.stringify(event) + '\n');
}
function release() { writeInput({ type: 'release' }); }
function permission() { send(input, { type: 'permission', allowed: allowed && inputReady }); }
function revoke() { allowed = false; release(); permission(); }
function startInput() {
  if (inputProcess || c.source === 'test') return;
  const child = spawn('python3', ['-u', inputPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  inputProcess = child;
  child.stdin.on('error', () => {});
  child.stdout.once('data', () => { if (inputProcess === child) { inputReady = true; permission(); } });
  child.stderr.on('data', d => { lastError = 'Input: ' + d.toString().slice(-1000); });
  child.on('error', e => { lastError = e.message; revoke(); });
  child.on('close', () => { if (inputProcess === child) { inputProcess = null; inputReady = false; revoke(); } });
}
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body));
}
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/buffer.js', ['buffer.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; media-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const active = video?.mediaConfig || c;
      return json(res, 200, { width: active.width, height: active.height, fps: c.fps, encoder: c.encoder, audio: c.audio, source: c.source,
        screen: c.screen, allowed: allowed && inputReady, connected: !!video, error: lastError });
    }
    const asset = assets.get(url.pathname);
    if (!asset || req.method !== 'GET') return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' });
    res.end(await readFile(path.join(root, 'client', asset[0])));
  } catch (e) { if (!res.headersSent) json(res, 500, { error: 'Request failed' }); else res.end(); }
});
server.requestTimeout = 10_000; server.headersTimeout = 10_000;
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, origin);
  const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
  if (req.headers.origin && !origins.has(req.headers.origin)) return reject('403 Forbidden');
  if (!['/ws/video', '/ws/input'].includes(url.pathname)) return reject('404 Not Found');
  if (url.pathname === '/ws/video' && video) return reject('409 Conflict');
  if (url.pathname === '/ws/input' && (input || !video || video.peer !== req.socket.remoteAddress)) return reject('409 Conflict');
  let target, mediaConfig;
  try {
    target = number(url.searchParams.get('buffer') ?? undefined, 1000, 100, 5000);
    mediaConfig = withResolution(c, url.searchParams);
  } catch { return reject('400 Bad Request'); }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.on('error', () => {}); ws.peer = req.socket.remoteAddress;
    if (url.pathname === '/ws/video') startVideo(ws, target, mediaConfig);
    else attachInput(ws);
  });
});
function startVideo(ws, target, c) {
  video = ws; lastError = ''; release(); allowed = true;
  ws.mediaConfig = c;
  const child = spawn(c.ffmpeg, ffmpegArgs(c), { stdio: ['ignore', 'pipe', 'pipe'] });
  ws.child = child;
  const startedAt = Date.now(), maxLag = Math.max(3000, target * 2 + 1000);
  let sequence = 0, ack = 0, lastAckAt = Date.now(), errors = '';
  const parser = new MP4Parser((init, codec) => {
    send(ws, { type: 'init', mime: `video/mp4; codecs="${codec}${c.audio ? ',mp4a.40.2' : ''}"`, startedAt, maxLag,
      width: c.width, height: c.height, fps: c.fps, screen: c.screen, encoder: c.encoder, audio: c.audio });
    if (ws.readyState === WebSocket.OPEN) ws.send(init);
  }, fragment => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount + fragment.length > 8 * 1024 * 1024 || Date.now() - lastAckAt > maxLag) {
      send(ws, { type: 'error', message: 'Network too slow; stream reset without lowering quality.' }); ws.close(1013, 'Network too slow');
      const kill = setTimeout(() => ws.terminate(), 1000); kill.unref(); return;
    }
    sequence++;
    send(ws, { type: 'fragment', sequence }); ws.send(fragment);
  });
  child.stdout.on('data', chunk => { try { parser.push(chunk); } catch (e) { lastError = e.message; ws.close(1011, 'Invalid media stream'); } });
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4096); });
  child.on('error', e => { lastError = e.message; send(ws, { type: 'error', message: lastError }); ws.close(1011, 'FFmpeg failed'); });
  child.on('close', code => {
    if (video === ws && ws.readyState === WebSocket.OPEN) {
      lastError = `FFmpeg exited (${code}): ${errors.slice(-1200)}`;
      send(ws, { type: 'error', message: lastError }); ws.close(1011, 'FFmpeg stopped');
    }
  });
  ws.on('message', (data, binary) => {
    if (binary) return ws.close(1008, 'Expected JSON');
    try {
      const m = JSON.parse(data);
      if (m.type === 'ack' && Number.isInteger(m.sequence) && m.sequence > ack && m.sequence <= sequence) { ack = m.sequence; lastAckAt = Date.now(); }
      if (m.type === 'ping' && Number.isFinite(m.at)) send(ws, { type: 'pong', at: m.at, serverTime: Date.now() });
    } catch { ws.close(1008, 'Invalid JSON'); }
  });
  const watch = setInterval(() => {
    if (Date.now() - lastAckAt > Math.max(maxLag, 10000)) ws.terminate();
  }, 1000);
  ws.on('close', () => {
    clearInterval(watch); child.kill('SIGTERM');
    const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000); kill.unref();
    if (video === ws) { video = null; revoke(); input?.close(1000, 'Video disconnected'); }
  });
}
function validInput(m) {
  if (m.type === 'release' || m.type === 'heartbeat') return true;
  if (m.type === 'move') return [m.x, m.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1);
  if (m.type === 'button') return [0, 1, 2].includes(m.button) && typeof m.down === 'boolean';
  if (m.type === 'key') return typeof m.code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(m.code) && typeof m.down === 'boolean';
  if (m.type === 'wheel') return [m.dx, m.dy].every(n => Number.isFinite(n) && Math.abs(n) <= 1000);
  return false;
}
function attachInput(ws) {
  input = ws; startInput(); permission(); lastInputAt = Date.now();
  let count = 0, windowAt = Date.now();
  ws.on('message', (data, binary) => {
    if (Date.now() - windowAt > 1000) { count = 0; windowAt = Date.now(); }
    if (++count > 250 || binary) return ws.close(1008, 'Input limit exceeded');
    try {
      const m = JSON.parse(data);
      if (!validInput(m)) return ws.close(1008, 'Invalid input event');
      lastInputAt = Date.now();
      if (m.type === 'release') release();
      else if (allowed && video?.peer === ws.peer) writeInput(m);
    } catch { ws.close(1008, 'Invalid input JSON'); }
  });
  ws.on('close', () => { if (input === ws) { revoke(); input = null; } });
}
const heartbeat = setInterval(() => {
  if (input && Date.now() - lastInputAt > 3000) { revoke(); input.close(1001, 'Input heartbeat lost'); }
}, 1000);

// Local host status and optional emergency input override. Never exposed over HTTP.
const socketPath = path.join(state, 'control.sock');
const control = net.createServer(socket => {
  socket.setTimeout(2000, () => socket.destroy());
  let command = '';
  socket.on('error', () => {});
  socket.on('data', data => {
    command += data;
    if (command.length > 128) return socket.destroy();
    if (!command.includes('\n')) return;
    switch (command.trim()) {
      case 'allow': if (input && inputReady) { allowed = true; permission(); } break;
      case 'revoke': revoke(); break;
      case 'status': break;
      default: return socket.end('Use allow, revoke or status\n');
    }
    socket.end(JSON.stringify({ connected: !!video, inputReady, allowed, lastError }) + '\n');
  });
});
// Do not unlink an active instance's control socket.
try {
  await new Promise((resolve, reject) => { const probe = net.connect(socketPath); probe.once('connect', () => { probe.destroy(); reject(Error('Another instance is running')); }); probe.once('error', e => ['ENOENT', 'ECONNREFUSED'].includes(e.code) ? resolve() : reject(e)); });
  await unlink(socketPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
  await new Promise((resolve, reject) => { control.once('error', reject); control.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); });
  console.log(`Remote Stream: ${origin}\n${c.width}×${c.height} ${c.fps} FPS · ${c.encoder} · audio ${c.audio ? 'on' : 'off'}\nOpen access. Remote control enabled when a viewer connects.`);
} catch (e) { console.error(e.message); control.close(); process.exit(1); }
async function shutdown() {
  if (stopping) return; stopping = true; clearInterval(heartbeat); revoke();
  video?.terminate(); input?.terminate(); inputProcess?.stdin.end();
  server.close(); control.close();
  await unlink(socketPath).catch(() => {});
  setTimeout(() => { inputProcess?.kill('SIGTERM'); process.exit(0); }, 500).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
