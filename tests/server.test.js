import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = async () => { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(r => s.close(r)); return port; };
test('open access, origin, single viewer, AAC media, congestion reset and reconnect', { timeout: 25000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'remote-stream-test-'));
  const port = await freePort(), origin = `http://localhost:${port}`;
  const host = spawn(process.execPath, ['host/server.js'], { env: { ...process.env, PORT: String(port), STATE_DIR: dir, SOURCE: 'test', AUDIO: '1', PUBLIC_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; host.stdout.on('data', d => logs += d); host.stderr.on('data', d => logs += d);
  const sockets = [];
  function ws(cookie, customOrigin = origin, route = '/ws/video') {
    const socket = new WebSocket(`ws://localhost:${port}${route}`, { origin: customOrigin, headers: cookie ? { Cookie: cookie } : {} });
    socket.on('error', () => {}); sockets.push(socket); return socket;
  }
  async function rejected(socket, expected) {
    const [, response] = await once(socket, 'unexpected-response');
    assert.equal(response.statusCode, expected); response.resume(); socket.terminate();
  }
  try {
    for (let i = 0; i < 80 && !logs.includes('Remote Stream:'); i++) await sleep(100);
    assert.match(logs, /Remote Stream:/, logs);
    assert.equal((await fetch(origin + '/api/status')).status, 200);
    assert.equal((await fetch(origin + '/api/login', { method: 'POST' })).status, 404);
    await assert.rejects(access(path.join(dir, 'token')), { code: 'ENOENT' });
    const cookie = null;
    await rejected(ws(null, 'https://attacker.invalid'), 403);
    await rejected(ws(null, origin, '/ws/input'), 409);
    for (const query of ['width=640', 'width=641&height=480', 'width=99999&height=480', 'width=abc&height=480']) {
      await rejected(ws(null, origin, `/ws/video?${query}`), 400);
    }
    const first = ws(cookie);
    let init, binaries = 0;
    first.on('message', (data, binary) => { if (binary) binaries++; else { const message = JSON.parse(data); if (message.type === 'init') init = message; } });
    await once(first, 'open');
    await rejected(ws(cookie), 409);
    const [code] = await once(first, 'close');
    assert.equal(code, 1013); assert.ok(binaries > 2); assert.match(init.mime, /mp4a\.40\.2/);
    await sleep(200);
    const second = ws(cookie, origin, '/ws/video?width=640&height=480'); let fragments = 0, resized;
    second.on('message', (data, binary) => { if (!binary) { const m = JSON.parse(data); if (m.type === 'init') resized = m; if (m.type === 'fragment') { fragments++; second.send(JSON.stringify({ type: 'ack', sequence: m.sequence })); } } });
    await once(second, 'open'); await sleep(1800); assert.ok(fragments >= 3);
    assert.equal(resized.width, 640); assert.equal(resized.height, 480);
    const status = await (await fetch(origin + '/api/status')).json();
    assert.equal(status.width, 640); assert.equal(status.height, 480);
    second.close(); await once(second, 'close');
  } finally {
    for (const socket of sockets) socket.terminate();
    host.kill('SIGTERM'); await once(host, 'close'); await rm(dir, { recursive: true, force: true });
  }
});
