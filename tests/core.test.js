import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { MP4Parser } from '../host/mp4.js';
import { config, ffmpegArgs } from '../host/media.js';
import { bufferAhead, bufferAction, pointerPosition } from '../client/buffer.js';

test('real FFmpeg output survives arbitrary byte boundaries; fragments decode', () => {
  const c = config({ ...process.env, SOURCE: 'test' });
  const args = ffmpegArgs(c); args.splice(args.length - 1, 0, '-t', '1.2');
  const result = spawnSync(c.ffmpeg, args, { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  for (const chunkSize of [1, 7, 65536]) {
    let init, codec; const fragments = [];
    const parser = new MP4Parser((data, value) => { init = data; codec = value; }, data => fragments.push(data));
    for (let i = 0; i < result.stdout.length; i += chunkSize) parser.push(result.stdout.subarray(i, i + chunkSize));
    assert.match(codec, /^avc1\.[0-9a-f]{6}$/);
    assert.ok(fragments.length >= 3);
    assert.equal(parser.pending.length, 0);
    if (chunkSize === 65536) {
      const decode = spawnSync(c.ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-f', 'null', '-'], { input: Buffer.concat([init, ...fragments]) });
      assert.equal(decode.status, 0, decode.stderr.toString());
    }
  }
});
test('MP4 parser rejects unbounded, invalid, and incomplete fragment sequences', () => {
  const parser = () => new MP4Parser(() => {}, () => {}, 64);
  const box = (size, type) => { const b = Buffer.alloc(8); b.writeUInt32BE(size); b.write(type, 4); return b; };
  assert.throws(() => parser().push(box(0, 'mdat')), /Invalid/);
  assert.throws(() => parser().push(box(1000, 'mdat')), /Invalid/);
  assert.throws(() => parser().push(box(8, 'mdat')), /Missing moof/);
  const p = parser(); p.push(box(8, 'moof'));
  assert.throws(() => p.push(box(8, 'moof')), /Missing mdat/);
  const large = Buffer.alloc(16); large.writeUInt32BE(1); large.write('mdat', 4); large.writeBigUInt64BE(1000n, 8);
  assert.throws(() => parser().push(large), /exceeds/);
});
test('buffer controller waits, resumes, rebuffers, and caps latency', () => {
  const base = { target: 1, maxLag: 3, playing: false, drift: false };
  assert.equal(bufferAction({ ...base, ahead: .5 }).action, 'wait');
  assert.equal(bufferAction({ ...base, ahead: 1 }).action, 'play');
  assert.equal(bufferAction({ ...base, playing: true, ahead: .01 }).action, 'pause');
  assert.equal(bufferAction({ ...base, playing: true, ahead: 4 }).action, 'reset');
  assert.equal(bufferAction({ ...base, playing: true, ahead: 1.8, drift: true }).rate, 1.02);
  const ranges = { length: 2, start: i => [0, 3][i], end: i => [1, 5][i] };
  assert.equal(bufferAhead(ranges, 2), 0); assert.equal(bufferAhead(ranges, 4), 1);
});
test('pointer mapping rejects letterbox bars and preserves host coordinates', () => {
  const rect = { left: 0, top: 0, width: 1000, height: 1000 }, screen = { width: 1920, height: 1080 };
  assert.equal(pointerPosition(rect, screen, 500, 0), null);
  assert.deepEqual(pointerPosition(rect, screen, 500, 500), { x: .5, y: .5 });
});
