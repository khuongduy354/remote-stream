import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startHost, rejected, until } from './helpers.js';

test('invitation access, origin checks, multiple viewers, AAC, congestion and revocation', { timeout: 30000 }, async () => {
  const host = await startHost();
  try {
    const session = (await host.command({ action: 'status' })).sessions[0];
    const params = { session: 'host', token: session.tokens.control };
    assert.equal((await fetch(host.origin + '/api/status')).status, 403);
    assert.equal((await fetch(host.origin + '/api/login', { method: 'POST' })).status, 404);
    await rejected(host.ws('/ws/video'), 403);
    await rejected(host.ws('/ws/video', params, 'https://attacker.invalid'), 403);
    await rejected(host.ws('/ws/input', params), 409);
    for (const extra of [{ width: '640' }, { width: '641', height: '480' }, { width: '99999', height: '480' }]) await rejected(host.ws('/ws/video', { ...params, ...extra }), 400);
    const slow = await host.connect(session, 'control', 'Slow viewer', false);
    const observer = await host.connect(session, 'view', 'Observer');
    const slowClosed = once(slow.video, 'close');
    await until(() => observer.info.fragments >= 3, 'Observer did not receive media');
    assert.match(observer.info.init.mime, /mp4a\.40\.2/);
    assert.equal(observer.info.permission.allowed, false);
    const [code] = await slowClosed;
    assert.equal(code, 1013);
    assert.ok(slow.info.binaries > 2);
    const next = await host.connect(session);
    await until(() => next.info.fragments >= 3, 'Reconnect did not receive media');
    const status = await (await fetch(host.origin + '/api/status', { headers: { Authorization: `Bearer ${session.tokens.view}` } })).json();
    assert.equal(status.viewers.length, 2);
    assert.equal(status.tokens, undefined);
    assert.equal(status.width, 640);
    const rotated = await host.command({ action: 'rotate', session: 'host' });
    assert.notEqual(rotated.sessions[0].tokens.control, session.tokens.control);
    await rejected(host.ws('/ws/video', params), 403);
  } finally { await host.close(); }
});
