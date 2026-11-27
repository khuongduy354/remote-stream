import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { startHost, until, rejected, sleep } from './helpers.js';
import { desktopAvailable } from '../host/desktops.js';

function inspect(host, session) {
  return JSON.parse(execFileSync('python3', ['-c', `from Xlib import display, XK
import json
d=display.Display()
p=d.screen().root.query_pointer()
k=d.keysym_to_keycode(XK.string_to_keysym('Shift_L'))
b=d.query_keymap()
print(json.dumps(dict(x=p.root_x,y=p.root_y,shift=bool(b[k//8] & (1 << (k%8))))))
d.close()`], { encoding: 'utf8', env: { ...process.env, DISPLAY: session.display, XAUTHORITY: path.join(host.dir, 'desktops', session.id, 'Xauthority') } }));
}
test('two real desktops: isolated input/audio, viewer permissions, handoff and lifecycle', { timeout: 45000, skip: !desktopAvailable() }, async () => {
  const host = await startHost();
  try {
    let state = await host.command({ action: 'create', name: 'Work A', width: 640, height: 480 });
    assert.equal(state.error, undefined, state.error);
    const a = state.sessions.find(s => s.id === state.created);
    state = await host.command({ action: 'create', name: 'Work B', width: 640, height: 480 });
    assert.equal(state.error, undefined, state.error);
    const b = state.sessions.find(s => s.id === state.created);
    assert.notEqual(a.display, b.display);
    if (a.audio && b.audio) assert.notEqual(a.audioSource, b.audioSource);
    const first = await host.connect(a, 'control', 'Alice');
    const second = await host.connect(b, 'control', 'Bob');
    const observer = await host.connect(a, 'view', 'Observer');
    const replacement = await host.connect(a, 'control', 'Carol');
    await until(() => first.info.permission?.allowed && second.info.permission?.allowed && replacement.info.permission, 'Input processes did not become ready');
    assert.equal(replacement.info.permission.allowed, false);
    first.send({ type: 'move', x: .2, y: .3 });
    second.send({ type: 'move', x: .8, y: .7 });
    await until(() => inspect(host, a).x === 128 && inspect(host, b).x === 511, 'Independent pointers not applied');
    first.send({ type: 'key', code: 'ShiftLeft', down: true });
    await until(() => inspect(host, a).shift, 'Key press not applied');
    assert.equal(inspect(host, b).shift, false);
    observer.send({ type: 'release' });
    observer.send({ type: 'move', x: .9, y: .9 });
    await sleep(150);
    assert.equal(inspect(host, a).shift, true, 'Observer released controller key');
    assert.equal(inspect(host, a).x, 128, 'Observer moved pointer');
    const denied = await host.command({ action: 'grant', session: a.id, viewer: observer.id });
    assert.match(denied.error, /control-capable/);
    replacement.send({ type: 'request-control' });
    await until(async () => (await host.command({ action: 'status' })).sessions.find(s => s.id === a.id).viewers.find(v => v.id === replacement.id).requesting, 'Control request missing');
    assert.equal((await host.command({ action: 'grant', session: a.id, viewer: replacement.id })).error, undefined);
    await until(() => replacement.info.permission?.allowed && !first.info.permission?.allowed && !inspect(host, a).shift, 'Handoff did not release held keys');
    first.send({ type: 'move', x: .1, y: .1 });
    replacement.send({ type: 'move', x: .6, y: .6 });
    await until(() => inspect(host, a).x === 383, 'New controller input missing');
    assert.equal(inspect(host, b).x, 511, 'Other desktop input changed');
    await rejected(host.ws('/ws/input', { session: b.id, token: b.tokens.control, viewer: replacement.id }), 409);
    await until(() => first.info.fragments > 1 && second.info.fragments > 1, 'Both desktops must stream');
    replacement.send({ type: 'key', code: 'ShiftLeft', down: true });
    await until(() => inspect(host, a).shift, 'Replacement key missing');
    replacement.video.close();
    await until(() => !inspect(host, a).shift, 'Disconnect left a held key');
    // Desktop lifetime is independent of viewers.
    first.video.close(); observer.video.close();
    await sleep(150);
    assert.ok((await host.command({ action: 'status' })).sessions.some(s => s.id === a.id));
    await host.command({ action: 'end', session: a.id });
    await rejected(host.ws('/ws/video', { session: a.id, token: a.tokens.control }), 403);
    assert.ok((await host.command({ action: 'status' })).sessions.some(s => s.id === b.id));
    assert.match((await host.command({ action: 'end', session: 'host' })).error, /cannot be ended/);
    await host.command({ action: 'end', session: b.id });
  } finally { await host.close(); }
});
