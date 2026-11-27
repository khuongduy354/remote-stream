import { accessSync, constants, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export function executable(command, env = process.env) {
  if (!command) return false;
  const candidates = command.includes('/') ? [command] : (env.PATH || '/usr/bin:/bin').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  return candidates.some(file => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } });
}

// Desktop Exec fields are argv, not shell scripts. Never run user selections through a shell.
export function execArguments(value, entry = {}) {
  const words = []; let word = '', quoted = false, started = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\') {
      if (++i === value.length) throw Error('Incomplete escape');
      word += value[i]; started = true;
    } else if (char === '"') { quoted = !quoted; started = true; }
    else if (/\s/.test(char) && !quoted) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  if (quoted) throw Error('Unclosed quote');
  if (started) words.push(word);
  const args = [];
  for (const value of words) {
    if (/^%[fFuUdDnNvm]$/.test(value)) continue;
    if (value === '%i') { if (entry.Icon) args.push('--icon', entry.Icon); continue; }
    args.push(value.replace(/%([%ck]|.)/g, (_, code) => {
      if (code === '%') return '%';
      if (code === 'c') return entry.Name || '';
      if (code === 'k') return entry.file || '';
      throw Error('Unsupported Exec field code');
    }));
  }
  if (!args[0]) throw Error('Missing executable');
  return args;
}

export function desktopEntries({ directories, env = process.env } = {}) {
  const roots = directories || [env.XDG_DATA_HOME || path.join(homedir(), '.local/share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')].map(dir => path.join(dir, 'xsessions'));
  const seen = new Set(), entries = [];
  for (const dir of roots) {
    let files; try { files = readdirSync(dir).sort(); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.desktop') || seen.has(file)) continue;
      seen.add(file);
      try {
        const entry = { file: path.join(dir, file) }; let section = '';
        for (const line of readFileSync(entry.file, 'utf8').split(/\r?\n/)) {
          const text = line.trim();
          if (text.startsWith('[')) { section = text; continue; }
          if (section !== '[Desktop Entry]' || text.startsWith('#')) continue;
          const separator = text.indexOf('=');
          if (separator > 0) entry[text.slice(0, separator)] = text.slice(separator + 1).replace(/\\([sntr\\])/g, (_, c) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[c]);
        }
        if (!entry.Name || !entry.Exec || entry.Hidden === 'true' || entry.NoDisplay === 'true' || entry.Terminal === 'true') continue;
        const args = execArguments(entry.Exec, entry);
        if (!executable(entry.TryExec || args[0], env) || !executable(args[0], env)) continue;
        const id = file.slice(0, -8);
        entries.push({ id, name: entry.Name, args, desktopNames: (entry.DesktopNames || id).split(';').filter(Boolean).join(':') });
      } catch { /* Invalid/unavailable session entries are not launchable choices. */ }
    }
  }
  return entries.sort((a, b) => a.id === 'i3' ? -1 : b.id === 'i3' ? 1 : a.name.localeCompare(b.name));
}

export function selectDesktop(id, entries = desktopEntries()) {
  const selected = id === undefined ? entries.find(entry => entry.id === 'i3') || entries[0] : entries.find(entry => entry.id === id);
  if (!selected) throw Error('Desktop is not installed. Choose one of the available X11 desktops.');
  return selected;
}
