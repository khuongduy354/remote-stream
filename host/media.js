import { spawnSync } from 'node:child_process';

export function number(value, fallback, min, max, integer = true) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw Error(`Expected ${min}–${max}, received ${value}`);
  return n;
}
export function withResolution(base, params) {
  if (!params.has('width') && !params.has('height')) return base;
  if (!params.has('width') || !params.has('height')) throw Error('Width and height are required together');
  const width = number(params.get('width'), base.width, 320, 3840);
  const height = number(params.get('height'), base.height, 240, 2160);
  if (width % 2 || height % 2) throw Error('Dimensions must be even');
  return { ...base, width, height, screen: base.source === 'test' ? { width, height } : base.screen };
}
export function config(env = process.env) {
  const encoderList = spawnSync(env.FFMPEG || 'ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (encoderList.status !== 0) throw Error('FFmpeg not found; set FFMPEG');
  const encoder = env.ENCODER || (encoderList.stdout.includes('libx264') ? 'libx264' : 'libopenh264');
  if (!['libx264', 'libopenh264', 'h264_vaapi', 'h264_nvenc', 'h264_qsv'].includes(encoder)) throw Error('Unsupported encoder');
  const width = number(env.WIDTH, 1280, 320, 3840), height = number(env.HEIGHT, 720, 240, 2160);
  if (width % 2 || height % 2) throw Error('Dimensions must be even');
  const source = env.SOURCE || 'desktop';
  if (!['desktop', 'test'].includes(source)) throw Error('SOURCE must be desktop or test');
  if (source === 'desktop' && (process.platform !== 'linux' || env.XDG_SESSION_TYPE === 'wayland')) throw Error('This prototype requires Linux/X11. SOURCE=test works without desktop capture.');
  let screen = { width, height };
  if (source === 'desktop') {
    const probe = spawnSync('python3', ['-c', 'from Xlib import display; import json; d=display.Display(); print(json.dumps(dict(width=d.screen().width_in_pixels,height=d.screen().height_in_pixels)))'], { encoding: 'utf8' });
    if (probe.status !== 0) throw Error('X11 unavailable; install python3-xlib and check DISPLAY');
    screen = JSON.parse(probe.stdout);
  }
  return { ffmpeg: env.FFMPEG || 'ffmpeg', encoder, width, height, source, screen,
    fps: number(env.FPS, 30, 10, 60), quality: number(env.QUALITY, 20, 0, 51),
    fragmentMs: number(env.FRAGMENT_MS, 250, 100, 1000), audio: env.AUDIO === '1',
    audioSource: env.AUDIO_SOURCE || '@DEFAULT_MONITOR@', display: env.DISPLAY || ':0',
    device: env.VAAPI_DEVICE || '/dev/dri/renderD128' };
}
export function ffmpegArgs(c) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];
  if (c.encoder === 'h264_vaapi') args.push('-vaapi_device', c.device);
  if (c.source === 'test') args.push('-re', '-f', 'lavfi', '-i', `testsrc2=size=${c.width}x${c.height}:rate=${c.fps}`);
  else args.push('-thread_queue_size', '64', '-f', 'x11grab', '-framerate', String(c.fps), '-video_size', `${c.screen.width}x${c.screen.height}`, '-i', c.display);
  if (c.audio) {
    if (c.source === 'test') args.push('-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
    else args.push('-thread_queue_size', '64', '-f', 'pulse', '-i', c.audioSource);
  }
  args.push('-map', '0:v:0');
  if (c.audio) args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-af', 'aresample=async=1:first_pts=0');
  const filter = `scale=${c.width}:${c.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${c.width}:${c.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  args.push('-vf', filter + (c.encoder === 'h264_vaapi' ? ',format=nv12,hwupload' : ',format=yuv420p'), '-c:v', c.encoder);
  if (c.encoder === 'libx264') args.push('-preset', 'veryfast', '-crf', String(c.quality), '-sc_threshold', '0');
  if (c.encoder === 'libopenh264') args.push('-rc_mode', 'off', '-qmin', String(c.quality), '-qmax', String(c.quality), '-allow_skip_frames', '0');
  if (c.encoder === 'h264_vaapi') args.push('-rc_mode', 'CQP', '-qp', String(c.quality));
  if (c.encoder === 'h264_nvenc') args.push('-rc', 'constqp', '-qp', String(c.quality));
  if (c.encoder === 'h264_qsv') args.push('-global_quality', String(c.quality));
  // Every fragment begins at an IDR; whole-stream restart is a safe resync boundary.
  args.push('-g', String(Math.max(1, Math.round(c.fps * c.fragmentMs / 1000))), '-bf', '0', '-fps_mode', 'cfr',
    '-movflags', '+empty_moov+default_base_moof+frag_keyframe', '-flush_packets', '1', '-f', 'mp4', 'pipe:1');
  return args;
}
