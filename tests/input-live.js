// Opt-in live X11 test: briefly holds Right Shift, then verifies release.
// Does not move the pointer, click, or type text. Run when not using the host keyboard.
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
const origin = process.env.TEST_URL || 'http://localhost:8787';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const query = () => {
  const p = spawnSync('python3', ['-c', 'from Xlib import display,XK; d=display.Display(); k=d.keysym_to_keycode(XK.string_to_keysym("Shift_R")); print(int(bool(d.query_keymap()[k//8] & (1 << (k%8)))))'], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr); return p.stdout.trim() === '1';
};
const command = c => { const p = spawnSync(process.execPath, ['scripts/control.js', c], { encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr); return JSON.parse(p.stdout); };
assert.equal(query(), false, 'Right Shift must be released before testing');
const video = new WebSocket(origin.replace('http', 'ws') + '/ws/video', { origin });
video.on('message', (data, binary) => { if (!binary) { const m = JSON.parse(data); if (m.type === 'fragment') video.send(JSON.stringify({ type: 'ack', sequence: m.sequence })); } });
await once(video, 'open');
const input = new WebSocket(origin.replace('http', 'ws') + '/ws/input', { origin });
await once(input, 'open');
const send = event => input.send(JSON.stringify(event));
const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 500);
try {
  await sleep(300);
  send({ type: 'key', code: 'ShiftRight', down: true }); await sleep(100);
  assert.equal(query(), true, 'Input is enabled by default');
  send({ type: 'key', code: 'ShiftRight', down: false }); await sleep(100);
  assert.equal(command('allow').allowed, true);
  send({ type: 'key', code: 'ShiftRight', down: true }); await sleep(100);
  assert.equal(query(), true, 'Granted input reaches X11');
  command('revoke'); await sleep(100);
  assert.equal(query(), false, 'Revocation releases held key');
  command('allow'); send({ type: 'key', code: 'ShiftRight', down: true }); await sleep(100);
  assert.equal(query(), true);
  clearInterval(heartbeat); input.close(); await once(input, 'close'); await sleep(150);
  assert.equal(query(), false, 'Disconnect releases held key');
  console.log('Live X11: default control, key injection, revoke release, disconnect release PASS');
} finally { clearInterval(heartbeat); command('revoke'); input.terminate(); video.terminate(); }
