import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const [action = 'status', session, viewer] = process.argv.slice(2);
if (!['status', 'create', 'end', 'grant', 'revoke', 'allow', 'disconnect', 'rotate'].includes(action)) throw Error('Use status, create NAME, end SESSION, grant SESSION VIEWER, revoke SESSION, allow SESSION, disconnect SESSION VIEWER or rotate SESSION');
const request = action === 'create' ? { action, name: session } : { action, session, viewer };
const socket = net.connect(path.join(process.env.STATE_DIR || path.join(root, '.state'), 'control.sock'));
let response = '';
socket.setTimeout(20000, () => { console.error('Control request timed out'); process.exitCode = 1; socket.destroy(); });
socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
socket.on('data', data => { response += data; });
socket.on('end', () => {
  try { const result = JSON.parse(response); console.log(JSON.stringify(result, null, 2)); if (result.error) process.exitCode = 1; }
  catch { console.error('Invalid control response'); process.exitCode = 1; }
});
socket.on('error', e => { console.error(e.message); process.exitCode = 1; });
