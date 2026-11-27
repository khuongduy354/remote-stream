import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startHost, startDashboard } from './helpers.js';

test('local dashboard requires owner key, rejects foreign origins/hosts, and returns private previews', { timeout: 20000 }, async () => {
  const host = await startHost(); let dashboard;
  try {
    dashboard = await startDashboard(host);
    assert.equal((await fetch(dashboard.origin + '/api/state')).status, 403);
    assert.equal((await fetch(dashboard.origin + '/api/state', { headers: { Authorization: 'Bearer wrong' } })).status, 403);
    assert.equal((await fetch(dashboard.origin + '/api/state', { headers: { ...dashboard.headers, Origin: 'https://attacker.invalid' } })).status, 403);
    const forgedHost = await new Promise((resolve, reject) => { const request = http.get(dashboard.origin + '/api/state', { headers: { ...dashboard.headers, Host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
    assert.equal(forgedHost, 403);
    const state = await (await fetch(dashboard.origin + '/api/state', { headers: dashboard.headers })).json();
    assert.equal(state.running, true); assert.equal(state.sessions[0].id, 'host');
    assert.equal((await fetch(dashboard.origin + '/api/state', { headers: { Authorization: `Bearer ${state.sessions[0].tokens.control}` } })).status, 403, 'Viewer token cannot administer host');
    assert.equal((await fetch(host.origin + '/api/command', { method: 'POST', headers: dashboard.headers, body: JSON.stringify({ action: 'end', session: 'host' }) })).status, 404, 'Management must not be exposed on streaming listener');
    assert.equal((await fetch(dashboard.origin + '/api/command', { method: 'POST', headers: dashboard.headers, body: JSON.stringify({ action: 'bad-command' }) })).status, 400);
    const image = await fetch(dashboard.origin + '/api/preview?session=host', { headers: dashboard.headers });
    assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/jpeg');
    const bytes = Buffer.from(await image.arrayBuffer()); assert.equal(bytes.readUInt16BE(0), 0xffd8);
    const after = await host.command({ action: 'status' });
    assert.equal(after.sessions[0].viewers.length, 0, 'Previews must not connect a viewer or take control');
  } finally { await dashboard?.close(); await host.close(); }
});
