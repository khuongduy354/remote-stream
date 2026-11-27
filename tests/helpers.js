import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(fn, message, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await sleep(80); }
  throw Error(message);
}
export async function startHost(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'remote-stream-test-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['host/server.js'], { env: { ...process.env, PORT: String(port), STATE_DIR: dir,
    SOURCE: 'test', AUDIO: '1', WIDTH: '640', HEIGHT: '480', FPS: '10', PUBLIC_ORIGIN: origin, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  const sockets = [];
  const command = request => new Promise((resolve, reject) => {
    const s = net.connect(path.join(dir, 'control.sock')); let text = '';
    s.on('connect', () => s.write(JSON.stringify(request) + '\n')); s.on('error', reject);
    s.setTimeout(20000, () => { s.destroy(); reject(Error('Control timeout')); });
    s.on('data', d => text += d); s.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
  });
  const ws = (route, params = {}, customOrigin = origin) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${route}?${new URLSearchParams(params)}`, { origin: customOrigin });
    socket.on('error', () => {}); sockets.push(socket); return socket;
  };
  const connect = async (session, role = 'control', name = 'Test viewer', acknowledge = true) => {
    const params = { session: session.id, token: session.tokens[role], name, buffer: '100' };
    const video = ws('/ws/video', params), info = { binaries: 0, fragments: 0, permission: null };
    video.on('message', (d, binary) => {
      if (binary) { info.binaries++; return; }
      const m = JSON.parse(d);
      if (m.type === 'hello') info.hello = m;
      if (m.type === 'init') info.init = m;
      if (m.type === 'fragment') { info.fragments++; if (acknowledge) video.send(JSON.stringify({ type: 'ack', sequence: m.sequence })); }
    });
    await until(() => info.hello, 'No viewer handshake');
    const input = ws('/ws/input', { ...params, viewer: info.hello.viewer });
    input.on('message', d => { const m = JSON.parse(d); if (m.type === 'permission') info.permission = m; });
    await once(input, 'open');
    const heartbeat = setInterval(() => { if (input.readyState === WebSocket.OPEN) input.send(JSON.stringify({ type: 'heartbeat' })); }, 1000);
    input.on('close', () => clearInterval(heartbeat));
    return { video, input, info, id: info.hello.viewer, send: event => input.send(JSON.stringify(event)) };
  };
  const close = async () => {
    for (const s of sockets) s.terminate();
    if (child.exitCode === null) { const ended = once(child, 'close'); child.kill('SIGTERM'); await ended; }
    await rm(dir, { recursive: true, force: true });
  };
  try { await until(() => logs.includes('Remote Stream:') || child.exitCode !== null, 'Host startup timed out'); if (child.exitCode !== null) throw Error(logs); }
  catch (e) { await close(); throw e; }
  return { dir, origin, port, child, command, ws, connect, close, logs: () => logs };
}
export async function rejected(socket, expected) {
  const [, response] = await once(socket, 'unexpected-response');
  if (response.statusCode !== expected) throw Error(`Expected HTTP ${expected}; got ${response.statusCode}`);
  response.resume(); socket.terminate();
}
