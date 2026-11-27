import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { desktopEntries, execArguments, selectDesktop } from '../host/desktop-entries.js';

test('session discovery honors installed entries, user overrides and hidden/unavailable desktops', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'remote-stream-entries-'));
  try {
    const user = path.join(dir, 'user'), system = path.join(dir, 'system'); mkdirSync(user); mkdirSync(system);
    const entry = (directory, id, text) => writeFileSync(path.join(directory, id + '.desktop'), '[Desktop Entry]\n' + text);
    entry(system, 'i3', 'Name=i3\nExec=/bin/true\nDesktopNames=i3;\n');
    entry(system, 'xfce', 'Name=Xfce\nExec=/bin/true --xfce\nDesktopNames=XFCE;\n');
    entry(system, 'missing', 'Name=Missing\nExec=/bin/true\nTryExec=/no/such/binary\n');
    entry(system, 'hidden', 'Name=Hidden\nExec=/bin/true\n');
    entry(user, 'hidden', 'Hidden=true\n');
    entry(system, 'broken', 'Name=Broken\nExec="unclosed\n');
    const entries = desktopEntries({ directories: [user, system] });
    assert.deepEqual(entries.map(e => e.id), ['i3', 'xfce']);
    assert.equal(selectDesktop(undefined, entries).id, 'i3');
    assert.deepEqual(selectDesktop('xfce', entries).args, ['/bin/true', '--xfce']);
    assert.equal(selectDesktop('xfce', entries).desktopNames, 'XFCE');
    assert.throws(() => selectDesktop('/bin/sh', entries), /not installed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('desktop Exec preserves argv and expands field codes without shell evaluation', () => {
  assert.deepEqual(execArguments('"/path with spaces/desktop" --name %c %% %f %i %k', { Name: 'A desktop', Icon: 'icon', file: '/entry.desktop' }),
    ['/path with spaces/desktop', '--name', 'A desktop', '%', '--icon', 'icon', '/entry.desktop']);
  assert.deepEqual(execArguments('/bin/echo "$(touch /tmp/not-executed)"'), ['/bin/echo', '$(touch /tmp/not-executed)']);
  assert.throws(() => execArguments('/bin/echo %Z'), /Unsupported/);
});
