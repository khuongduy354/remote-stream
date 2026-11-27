import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startHost, until, sleep } from './helpers.js';
import { desktopEntries } from '../host/desktop-entries.js';

const available = desktopEntries().some(entry => entry.id === 'xfce-macos');
test('xfce macos starts a real Xfce desktop with isolated settings, configured panels and working stream', { skip: !available, timeout: 45000 }, async () => {
  const host = await startHost();
  try {
    const result = await host.command({ action: 'create', name: 'xfce macos', desktop: 'xfce-macos', width: 1280, height: 720 });
    assert.equal(result.error, undefined, result.error);
    const session = result.sessions.find(s => s.id === result.created);
    const env = { ...process.env, DISPLAY: session.display, XAUTHORITY: path.join(host.dir, 'desktops', session.id, 'Xauthority') };
    let wm;
    const query = `from Xlib import display
import json
d=display.Display(); r=d.screen().root
p=r.get_full_property(d.intern_atom('_NET_SUPPORTING_WM_CHECK'),0)
if not p: print('{}')
else:
 w=d.create_resource_object('window',int(p.value[0])); n=w.get_full_property(d.intern_atom('_NET_WM_NAME'),0); pid=w.get_full_property(d.intern_atom('_NET_WM_PID'),0)
 print(json.dumps(dict(name=bytes(n.value).decode() if n else '',pid=int(pid.value[0]) if pid else None)))
d.close()`;
    await until(() => { wm = JSON.parse(execFileSync('python3', ['-c', query], { env, encoding: 'utf8' })); return /xfwm/i.test(wm.name || '') && wm.pid; }, 'Xfce window manager did not start', 18000);
    const childEnv = Object.fromEntries(readFileSync(`/proc/${wm.pid}/environ`, 'utf8').split('\0').filter(v => v.includes('=')).map(v => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]));
    assert.ok(childEnv.XDG_CONFIG_HOME.startsWith(path.join(host.dir, 'desktops', session.id)), 'Xfce must not use main user configuration');
    const property = (channel, name) => execFileSync('xfconf-query', ['-c', channel, '-p', name], { env: childEnv, encoding: 'utf8' }).trim();
    assert.equal(property('xfwm4', '/general/button_layout'), 'CHM|');
    assert.equal(property('xsettings', '/Net/ThemeName'), 'Adwaita');
    assert.equal(property('xfce4-panel', '/panels/panel-1/position'), 'p=6;x=0;y=0');
    assert.equal(property('xfce4-panel', '/panels/panel-2/position'), 'p=10;x=0;y=0');
    const viewer = await host.connect(session, 'control', 'Preset test');
    await until(() => viewer.info.permission?.allowed && viewer.info.fragments > 2, 'Preset desktop did not stream or accept control');
    await sleep(1800);
    const preview = await host.command({ action: 'preview', session: session.id });
    assert.ok(preview.image, preview.error);
    writeFileSync('/tmp/remote-stream-xfce-macos.jpg', Buffer.from(preview.image, 'base64'));
    await host.command({ action: 'end', session: session.id });
    assert.equal((await host.command({ action: 'status' })).sessions.length, 1);
  } finally { await host.close(); }
});
