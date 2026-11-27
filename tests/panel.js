import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { startHost } from './helpers.js';
import { createDesktop } from '../host/desktops.js';
const host = await startHost();
let desktop;
try {
  desktop = await createDesktop({ id: 'panel-test', width: 1100, height: 1000, state: host.dir, baseEnv: process.env, onExit: () => {} });
  const child = spawn('python3', ['tests/panel-fixture.py'], { env: { ...desktop.env, STATE_DIR: host.dir, PUBLIC_ORIGIN: host.origin }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 40000);
  const [code] = await once(child, 'close'); clearTimeout(timeout);
  assert.equal(code, 0, output); console.log(output.trim());
} finally { await desktop?.close(); await host.close(); }
