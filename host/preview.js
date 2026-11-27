import { spawn } from 'node:child_process';
const cache = new WeakMap();

// Small, infrequent snapshots do not attach a viewer or take control of a desktop.
export function desktopPreview(session) {
  const previous = cache.get(session);
  if (previous && Date.now() - previous.at < 6000) return previous.promise;
  const promise = new Promise((resolve, reject) => {
    const c = session.media;
    const source = c.source === 'test'
      ? ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1']
      : ['-f', 'x11grab', '-framerate', '10', '-video_size', `${c.screen.width}x${c.screen.height}`, '-i', c.display];
    const child = spawn(c.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...source,
      '-frames:v', '1', '-an', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease', '-c:v', 'mjpeg', '-q:v', '6', '-threads', '1', '-f', 'image2pipe', 'pipe:1'],
    { env: session.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let length = 0, error = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Preview timed out')); }, 4000);
    child.stdout.on('data', data => {
      length += data.length;
      if (length > 1024 * 1024) { child.kill('SIGKILL'); reject(Error('Preview too large')); }
      else chunks.push(data);
    });
    child.stderr.on('data', data => { error = (error + data).slice(-500); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !length) reject(Error(error || 'Preview unavailable'));
      else resolve({ image: Buffer.concat(chunks).toString('base64') });
    });
  });
  cache.set(session, { at: Date.now(), promise });
  return promise;
}
