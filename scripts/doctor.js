import { spawnSync } from 'node:child_process';
import { config, ffmpegArgs } from '../host/media.js';
console.log(`OS: ${process.platform}; session: ${process.env.XDG_SESSION_TYPE || 'unknown'}; DISPLAY: ${process.env.DISPLAY || 'unset'}`);
const c = config();
console.log(JSON.stringify(c, null, 2));
const args = ffmpegArgs({ ...c, source: 'test', audio: false });
args.splice(args.length - 1, 0, '-t', '2');
const result = spawnSync(c.ffmpeg, args, { timeout: 15000, maxBuffer: 32 * 1024 * 1024 });
console.log(`Encoder probe: ${result.status === 0 ? 'PASS' : 'FAIL'}; ${result.stdout?.length || 0} bytes`);
if (result.status !== 0) { console.error(result.stderr?.toString()); process.exitCode = 1; }
