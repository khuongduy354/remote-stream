import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { desktopEntries, executable, selectDesktop } from './desktop-entries.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
export function desktopAvailable() {
  return ['Xvfb', 'xauth', 'dbus-run-session'].every(cmd => executable(cmd)) && desktopEntries().length > 0;
}
function stopGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000); timer.unref();
}

export async function createDesktop({ id, width, height, state, baseEnv, onExit, desktopId }) {
  const selected = selectDesktop(desktopId);
  const isI3 = ['i3', 'i3-with-shmlog'].includes(path.basename(selected.args[0]));
  const dir = path.join(state, 'desktops', id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const auth = path.join(dir, 'Xauthority'), config = path.join(dir, 'i3.config');
  const cookie = randomBytes(16).toString('hex');
  let xserver, desktop, audioModule, closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    stopGroup(desktop); stopGroup(xserver);
    if (audioModule) { try { run('pactl', ['unload-module', audioModule]); } catch {} }
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await writeFile(auth, '', { mode: 0o600 });
    run('xauth', ['-f', auth, 'add', ':0', '.', cookie]);
    xserver = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-auth', auth, '-noreset'],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    let error = ''; xserver.stderr.on('data', d => { error = (error + d).slice(-2000); });
    const display = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(Error('Virtual display timed out')), 8000);
      const finish = (err, value) => { clearTimeout(timer); err ? reject(err) : resolve(value); };
      xserver.once('error', e => finish(e));
      xserver.once('exit', () => finish(Error(`Virtual display failed: ${error}`)));
      xserver.stdio[3].on('data', chunk => {
        text += chunk;
        if (/^\d+\n/.test(text)) finish(null, ':' + text.trim());
      });
    });
    run('xauth', ['-f', auth, 'add', display, '.', cookie]);
    const env = { ...baseEnv, DISPLAY: display, XAUTHORITY: auth, XDG_SESSION_TYPE: 'x11', REMOTE_STREAM_SESSION_DIR: dir, XDG_CURRENT_DESKTOP: selected.desktopNames, XDG_SESSION_DESKTOP: selected.id, DESKTOP_SESSION: selected.id };
    delete env.DBUS_SESSION_BUS_ADDRESS; delete env.SESSION_MANAGER; delete env.I3SOCK;
    delete env.WAYLAND_DISPLAY; delete env.DESKTOP_STARTUP_ID;
    delete env.XDG_SESSION_ID; delete env.XDG_SEAT; delete env.XDG_VTNR;
    const sink = `remote_stream_${id}`;
    try {
      audioModule = run('pactl', ['load-module', 'module-null-sink', `sink_name=${sink}`, `sink_properties=device.description=RemoteStream-${id}`]);
      env.PULSE_SINK = sink; env.PULSE_SOURCE = `${sink}.monitor`;
    } catch { /* A desktop without audio remains usable. Never capture the host monitor as fallback. */ }
    let terminal = 'i3-sensible-terminal';
    for (const candidate of ['alacritty', 'kitty', 'xfce4-terminal', 'xterm']) { try { run('which', [candidate]); terminal = candidate; break; } catch {} }
    if (isI3) await writeFile(config, `# Isolated desktop: do not load host autostart commands.\nset $mod Mod4\nfont pango:monospace 11\nfloating_modifier $mod\nbindsym $mod+Return exec ${terminal}\nbindsym $mod+Shift+q kill\nbindsym $mod+d exec i3-dmenu-desktop\nbindsym $mod+f fullscreen toggle\nbindsym $mod+Shift+space floating toggle\nbindsym $mod+h focus left\nbindsym $mod+j focus down\nbindsym $mod+k focus up\nbindsym $mod+l focus right\n${Array.from({ length: 9 }, (_, n) => `bindsym $mod+${n + 1} workspace ${n + 1}`).join('\n')}\nexec ${terminal}\n`, { mode: 0o600 });
    const args = isI3 ? [...selected.args, '-c', config] : selected.args;
    desktop = spawn('dbus-run-session', ['--', ...args], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let desktopError = '', spawnError;
    desktop.stderr.on('data', d => { desktopError = (desktopError + d).slice(-1000); });
    desktop.on('error', e => { spawnError = e; });
    await delay(350);
    if (spawnError || desktop.exitCode !== null || xserver.exitCode !== null) throw Error(spawnError?.message || `Desktop failed: ${desktopError || error}`);
    xserver.on('exit', () => { if (!closing) onExit('Virtual display stopped'); });
    desktop.on('exit', () => { if (!closing) onExit('Desktop stopped'); });
    return { env, display, desktopId: selected.id, desktopName: selected.name, audioSource: audioModule ? `${sink}.monitor` : null, close };
  } catch (e) { await close(); throw e; }
}
