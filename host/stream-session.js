import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { ffmpegArgs } from './media.js';
import { MP4Parser } from './mp4.js';

const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
export function validInput(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type === 'release' || m.type === 'heartbeat') return true;
  if (m.type === 'move') return [m.x, m.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1);
  if (m.type === 'button') return [0, 1, 2].includes(m.button) && typeof m.down === 'boolean';
  if (m.type === 'key') return typeof m.code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(m.code) && typeof m.down === 'boolean';
  if (m.type === 'wheel') return [m.dx, m.dy].every(n => Number.isFinite(n) && Math.abs(n) <= 1000);
  return false;
}

// Each instance owns its input process, controller and encoders. No host-global input state.
export class StreamSession {
  constructor({ id, name, media, env, inputPath, kind = 'host' }) {
    Object.assign(this, { id, name, media, env, inputPath, kind });
    this.viewers = new Map(); this.controller = null; this.inputReady = false; this.inputProcess = null;
    this.error = ''; this.closed = false; this.tokens = { view: randomBytes(32).toString('hex'), control: randomBytes(32).toString('hex') };
    this.watch = setInterval(() => {
      const viewer = this.viewers.get(this.controller);
      if (viewer?.input && Date.now() - viewer.lastInputAt > 3000) { this.grant(null); viewer.input.close(1001, 'Input heartbeat lost'); }
    }, 1000);
  }
  role(token) { return token === this.tokens.control ? 'control' : token === this.tokens.view ? 'view' : null; }
  status(privateFields = false) {
    return { id: this.id, name: this.name, kind: this.kind, display: this.media.display,
      connected: this.viewers.size > 0, inputReady: this.inputReady, allowed: !!this.controller && this.inputReady,
      lastError: this.error, controller: this.controller, ...this.media,
      viewers: [...this.viewers.values()].map(v => ({ id: v.id, name: v.name, role: v.role, requesting: v.requesting, controlling: this.controller === v.id })),
      ...(privateFields ? { tokens: this.tokens } : {}) };
  }
  write(event) {
    const child = this.inputProcess;
    if (!this.inputReady || !child || child.stdin.destroyed) return;
    if (child.stdin.writableLength > 16384) { this.inputReady = false; this.grant(null); child.kill(); return; }
    child.stdin.write(JSON.stringify(event) + '\n');
  }
  release() { this.write({ type: 'release' }); }
  permissions() {
    for (const viewer of this.viewers.values()) send(viewer.input, { type: 'permission', allowed: this.controller === viewer.id && this.inputReady,
      controller: this.viewers.get(this.controller)?.name || null, canRequest: viewer.role === 'control', requesting: viewer.requesting });
  }
  grant(id) {
    const next = this.viewers.get(id);
    if (id && (!next || next.role !== 'control' || next.input?.readyState !== WebSocket.OPEN)) throw Error('Select a connected control-capable viewer');
    // Release every held key/button before ownership changes.
    this.release(); this.controller = id || null;
    if (next) next.requesting = false;
    this.permissions();
  }
  startInput() {
    if (this.inputProcess || this.media.source === 'test' || this.closed) return;
    const child = spawn('python3', ['-u', this.inputPath], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.inputProcess = child;
    child.stdin.on('error', () => {});
    child.stdout.once('data', () => { if (this.inputProcess === child && !this.closed) { this.inputReady = true; this.permissions(); } });
    child.stderr.on('data', d => { this.error = 'Input: ' + d.toString().slice(-1000); });
    child.on('error', e => { this.error = e.message; });
    child.on('close', () => { if (this.inputProcess === child) { this.inputProcess = null; this.inputReady = false; this.grant(null); } });
  }
  attachInput(ws, viewer) {
    viewer.input = ws; viewer.lastInputAt = Date.now(); this.startInput();
    if (!this.controller && viewer.role === 'control') this.grant(viewer.id);
    else this.permissions();
    let count = 0, windowAt = Date.now();
    ws.on('message', (data, binary) => {
      if (Date.now() - windowAt > 1000) { count = 0; windowAt = Date.now(); }
      if (++count > 250 || binary) return ws.close(1008, 'Input limit exceeded');
      try {
        const m = JSON.parse(data); viewer.lastInputAt = Date.now();
        if (m?.type === 'request-control') {
          if (viewer.role !== 'control') return ws.close(1008, 'View-only link');
          viewer.requesting = true;
          if (!this.controller) this.grant(viewer.id); else this.permissions();
          return;
        }
        if (m?.type === 'yield-control') { if (this.controller === viewer.id) this.grant(null); return; }
        if (!validInput(m)) return ws.close(1008, 'Invalid input event');
        // Even release events from observers must not affect the controller.
        if (this.controller === viewer.id) this.write(m);
      } catch { ws.close(1008, 'Invalid input JSON'); }
    });
    ws.on('close', () => { if (viewer.input === ws) { if (this.controller === viewer.id) this.grant(null); viewer.input = null; } });
  }
  addViewer(ws, target, media, role, name) {
    const viewer = { id: randomBytes(24).toString('hex'), ws, role, name: name || `Viewer ${this.viewers.size + 1}`, input: null, requesting: false };
    this.viewers.set(viewer.id, viewer); this.error = '';
    send(ws, { type: 'hello', viewer: viewer.id, session: this.id, name: this.name, role });
    const child = spawn(media.ffmpeg, ffmpegArgs(media), { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    viewer.child = child;
    const startedAt = Date.now(), maxLag = Math.max(3000, target * 2 + 1000);
    let sequence = 0, ack = 0, lastAckAt = Date.now(), errors = '';
    const parser = new MP4Parser((init, codec) => {
      send(ws, { type: 'init', mime: `video/mp4; codecs="${codec}${media.audio ? ',mp4a.40.2' : ''}"`, startedAt, maxLag,
        width: media.width, height: media.height, fps: media.fps, screen: media.screen, encoder: media.encoder, audio: media.audio });
      if (ws.readyState === WebSocket.OPEN) ws.send(init);
    }, fragment => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount + fragment.length > 8 * 1024 * 1024 || Date.now() - lastAckAt > maxLag) {
        send(ws, { type: 'error', message: 'Network too slow; stream reset without lowering quality.' }); ws.close(1013, 'Network too slow');
        const kill = setTimeout(() => ws.terminate(), 1000); kill.unref(); return;
      }
      sequence++; send(ws, { type: 'fragment', sequence }); ws.send(fragment);
    });
    child.stdout.on('data', chunk => { try { parser.push(chunk); } catch (e) { this.error = e.message; ws.close(1011, 'Invalid media stream'); } });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4096); });
    child.on('error', e => { this.error = e.message; send(ws, { type: 'error', message: this.error }); ws.close(1011, 'FFmpeg failed'); });
    child.on('close', code => {
      if (ws.readyState === WebSocket.OPEN) { this.error = `FFmpeg exited (${code}): ${errors.slice(-1200)}`; send(ws, { type: 'error', message: this.error }); ws.close(1011, 'FFmpeg stopped'); }
    });
    ws.on('message', (data, binary) => {
      if (binary) return ws.close(1008, 'Expected JSON');
      try {
        const m = JSON.parse(data);
        if (m.type === 'ack' && Number.isInteger(m.sequence) && m.sequence > ack && m.sequence <= sequence) { ack = m.sequence; lastAckAt = Date.now(); }
        if (m.type === 'ping' && Number.isFinite(m.at)) send(ws, { type: 'pong', at: m.at, serverTime: Date.now() });
      } catch { ws.close(1008, 'Invalid JSON'); }
    });
    const watch = setInterval(() => { if (Date.now() - lastAckAt > Math.max(maxLag, 10000)) ws.terminate(); }, 1000);
    ws.on('close', () => {
      clearInterval(watch); child.kill('SIGTERM');
      const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000); kill.unref();
      if (this.controller === viewer.id) this.grant(null);
      this.viewers.delete(viewer.id); viewer.input?.close(1000, 'Video disconnected'); this.permissions();
    });
    return viewer;
  }
  disconnect(id) { const v = this.viewers.get(id); if (v) { v.ws.terminate(); v.input?.terminate(); } }
  rotate() { this.tokens = { view: randomBytes(32).toString('hex'), control: randomBytes(32).toString('hex') }; for (const id of this.viewers.keys()) this.disconnect(id); this.grant(null); }
  close() {
    this.closed = true; clearInterval(this.watch); this.grant(null);
    for (const id of this.viewers.keys()) this.disconnect(id);
    const child = this.inputProcess; child?.stdin.end();
    if (child) { const timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref(); }
  }
}
