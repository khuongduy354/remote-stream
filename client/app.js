import { bufferAhead, bufferAction, pointerPosition } from './buffer.js';
const $ = id => document.getElementById(id);
const video = $('video'); video.disableRemotePlayback = true;
let wanted = false, generation = 0, ws, input, media, sourceBuffer, objectURL;
let queue = [], queuedBytes = 0, metadata, sequence = 0, started = false, playing = false, control = false;
let bytes = 0, previousBytes = 0, bitrate = 0, rebufferings = 0, retries = 0, reconnectTimer;
let rendered = 0, previousRendered = 0, renderedFPS = 0, lastProgressAt = 0, lastTime = 0;
let streamError = '', clockOffset = 0, clockReady = false, pendingMove = null, dragging = false, heartbeatTimer, capabilityFailure = false;
const LIMIT = 16 * 1024 * 1024;
const invitation = new URLSearchParams(location.hash.slice(1));
const sessionId = new URLSearchParams(location.search).get('session') || 'host';
const token = invitation.get('token') || '';
let viewerId = null;
const credentials = () => new URLSearchParams({ session: sessionId, token });
const target = () => Number($('buffer').value) / 1000;
function resolutionLabel(width, height) {
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  return `${width} × ${height} (${width / divisor}:${height / divisor})`;
}
const note = message => { $('notice').textContent = message; };
const state = message => { $('connection').textContent = message; };
function setControl(value) { control = value; if (!value) { pendingMove = null; dragging = false; } $('permission').textContent = value ? 'CONTROL ENABLED' : 'VIEW ONLY'; $('yield').disabled = !value; }
function sendInput(event) {
  if (input?.readyState === WebSocket.OPEN && (control || ['release', 'heartbeat'].includes(event.type))) {
    if (input.bufferedAmount > 8192) { input.close(); setControl(false); return; }
    input.send(JSON.stringify(event));
  }
}
function cleanup() {
  generation++;
  clearInterval(heartbeatTimer);
  sendInput({ type: 'release' }); input?.close(); input = null;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  video.pause(); video.removeAttribute('src'); video.load();
  if (objectURL) URL.revokeObjectURL(objectURL);
  media = sourceBuffer = objectURL = null;
  queue = []; queuedBytes = 0; started = playing = false; setControl(false);
  pendingMove = null; dragging = false;
}
function retry(message) {
  if (!wanted || reconnectTimer) return;
  cleanup(); state('Reconnecting'); note(message);
  const wait = Math.min(10000, 500 * 2 ** Math.min(retries++, 5));
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (wanted) connect(); }, wait);
}
function stop(message = 'Disconnected') {
  wanted = false; clearTimeout(reconnectTimer); reconnectTimer = null; cleanup(); state(message);
  $('connect').disabled = false; $('disconnect').disabled = true; $('placeholder').hidden = false;
}
function drain() {
  if (!sourceBuffer || sourceBuffer.updating || media?.readyState !== 'open') return;
  try {
    if (sourceBuffer.buffered.length && video.currentTime - sourceBuffer.buffered.start(0) > 4) {
      sourceBuffer.remove(0, video.currentTime - 2); return;
    }
    if (queue.length) {
      const chunk = queue.shift(); queuedBytes -= chunk.byteLength; sourceBuffer.appendBuffer(chunk);
    }
  } catch (e) { retry(`Media buffer reset: ${e.name}. Increase buffer or check host.`); }
}
function setup(info, currentGeneration) {
  metadata = info;
  if (!$('resolution').value) $('resolution').options[0].textContent = `Host default: ${resolutionLabel(info.width, info.height)}`;
  const Media = [window.MediaSource, window.ManagedMediaSource].find(M => M?.isTypeSupported(info.mime));
  if (!Media) { capabilityFailure = true; stop('Unsupported codec'); note(`Browser cannot play ${info.mime}. Try current Chrome with H.264 support.`); return; }
  media = new Media();
  const currentMedia = media;
  currentMedia.addEventListener('sourceopen', () => {
    if (currentGeneration !== generation) return;
    try {
      sourceBuffer = currentMedia.addSourceBuffer(info.mime);
      sourceBuffer.addEventListener('updateend', () => { if (currentGeneration === generation) drain(); });
      sourceBuffer.addEventListener('error', () => { if (currentGeneration === generation) retry('Decoder error; restarting at fresh initialization segment.'); });
      drain();
    } catch (e) { capabilityFailure = true; stop('Unsupported decoder'); note(e.message); }
  }, { once: true });
  objectURL = URL.createObjectURL(media); video.src = objectURL;
  $('viewer').style.aspectRatio = `${info.width}/${info.height}`;
}
function attachInput(currentGeneration) {
  const params = credentials(); params.set('viewer', viewerId);
  input = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/input?${params}`);
  input.onmessage = e => { if (currentGeneration !== generation) return; const m = JSON.parse(e.data); if (m.type === 'permission') { setControl(m.allowed); $('request').disabled = !m.canRequest || m.allowed || m.requesting; $('request').textContent = m.requesting ? 'Control requested' : 'Request control'; $('controller').textContent = m.controller ? `${m.controller} controls this desktop` : 'No remote controller'; } };
  input.onclose = () => { if (currentGeneration === generation) { setControl(false); note('Input channel closed. Reconnect video to restore input.'); } };
  heartbeatTimer = setInterval(() => sendInput({ type: 'heartbeat' }), 1000);
}
function connect() {
  if (!token) { stop('Invitation required'); note('Open a share link from the Remote Stream host panel.'); return; }
  cleanup(); wanted = true; capabilityFailure = false;
  const currentGeneration = generation;
  streamError = ''; bytes = previousBytes = rendered = previousRendered = 0; metadata = null; sequence = 0; clockReady = false;
  lastProgressAt = performance.now(); lastTime = 0;
  $('connect').disabled = true; $('disconnect').disabled = false; state('Connecting');
  const params = credentials(); params.set('buffer', target() * 1000); params.set('name', $('viewer-name').value.trim().slice(0, 40) || 'Guest');
  if ($('resolution').value) {
    const [width, height] = $('resolution').value.split('x');
    params.set('width', width); params.set('height', height);
  }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/video?${params}`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { if (currentGeneration !== generation) return; state('Buffering'); ws.send(JSON.stringify({ type: 'ping', at: Date.now() })); };
  ws.onmessage = e => {
    if (currentGeneration !== generation) return;
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.type === 'hello') { viewerId = m.viewer; $('session-name').textContent = m.name; attachInput(currentGeneration); }
      if (m.type === 'init') setup(m, currentGeneration);
      if (m.type === 'fragment') sequence = m.sequence;
      if (m.type === 'error') { streamError = m.message; note(m.message); }
      if (m.type === 'pong') { clockOffset = m.serverTime - (m.at + Date.now()) / 2; clockReady = true; }
      return;
    }
    if (!metadata || capabilityFailure) return;
    bytes += e.data.byteLength;
    if (queuedBytes + e.data.byteLength > LIMIT || queue.length >= 100) return retry('Client queue full. Network or decoder cannot sustain this stream.');
    queue.push(e.data); queuedBytes += e.data.byteLength;
    if (sequence) ws.send(JSON.stringify({ type: 'ack', sequence }));
    drain();
  };
  ws.onclose = e => { if (currentGeneration === generation && wanted) retry(streamError || `Connection lost (${e.code}). Retrying; quality stays fixed. Check host if this repeats.`); };
  ws.onerror = () => note('Connection failed. Check invitation, host status, or viewer limit.');
}
video.addEventListener('error', () => { if (wanted && metadata) retry('Video playback failed. Restarting decoder.'); });
video.addEventListener('waiting', () => { if (started && playing) { rebufferings++; playing = false; video.pause(); state('Rebuffering'); } });
video.addEventListener('pause', () => sendInput({ type: 'release' }));
function frames() { rendered++; if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frames); }
if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frames);
setInterval(() => {
  if (!wanted || !sourceBuffer || !metadata) return;
  const ahead = bufferAhead(video.buffered, video.currentTime);
  const decision = bufferAction({ ahead, target: target(), maxLag: metadata.maxLag / 1000, playing, drift: $('drift').checked });
  if (decision.action === 'reset') return retry('Latency limit exceeded; restarting at a clean decoding boundary.');
  if (decision.action === 'pause') { if (playing) rebufferings++; playing = false; video.pause(); state('Rebuffering'); }
  if (decision.action === 'play' && !playing) {
    playing = true;
    video.play().then(() => { started = true; retries = 0; $('placeholder').hidden = true; state('Streaming'); note(control ? 'Connected. Click the desktop to use mouse and keyboard.' : 'Viewing desktop. The host manages control permissions.'); }).catch(() => {
      playing = false; note('Playback needs a gesture. Click the video to continue.');
    });
  }
  video.playbackRate = decision.rate;
  if (video.currentTime !== lastTime) { lastProgressAt = performance.now(); lastTime = video.currentTime; }
  // Total timeline age also includes transport backlog, which buffered-ahead alone misses.
  const timelineAge = clockReady ? (Date.now() + clockOffset - metadata.startedAt) / 1000 - video.currentTime : 0;
  if (started && (timelineAge > metadata.maxLag / 1000 + 2 || performance.now() - lastProgressAt > metadata.maxLag + 3000)) retry('Stream fell behind or stalled. Resynchronizing without reducing quality.');
}, 100);
setInterval(() => {
  bitrate = (bytes - previousBytes) * 8 / 1e6; previousBytes = bytes;
  renderedFPS = rendered - previousRendered; previousRendered = rendered;
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', at: Date.now() }));
  const quality = video.getVideoPlaybackQuality?.();
  const ahead = bufferAhead(video.buffered, video.currentTime);
  const age = metadata && clockReady ? Math.max(0, Date.now() + clockOffset - metadata.startedAt - video.currentTime * 1000) : null;
  const values = [ ['Received bitrate', `${bitrate.toFixed(2)} Mb/s`], ['Rendered FPS', video.requestVideoFrameCallback ? String(renderedFPS) : 'Unavailable'],
    ['Buffer ahead', `${Math.round(ahead * 1000)} ms`], ['Timeline delay (est.)', age === null ? '—' : `${Math.round(age)} ms`],
    ['Dropped frames', quality ? String(quality.droppedVideoFrames) : 'Unavailable'], ['Rebuffers', String(rebufferings)],
    ['Resolution', metadata ? resolutionLabel(metadata.width, metadata.height) : '—'], ['Encoder', metadata?.encoder || '—'],
    ['Codec', metadata ? (metadata.audio ? 'H.264 / AAC' : 'H.264') : '—'], ['Link capacity', 'Not measured'] ];
  $('stats').replaceChildren(...values.map(([name, value]) => {
    const box = document.createElement('div'); box.className = 'stat';
    const label = document.createElement('span'); label.textContent = name;
    const text = document.createElement('b'); text.textContent = value; box.append(label, text); return box;
  }));
}, 1000);
$('connect').onclick = () => { rebufferings = 0; retries = 0; connect(); };
$('disconnect').onclick = () => stop();
$('request').onclick = () => { if (input?.readyState === WebSocket.OPEN) input.send(JSON.stringify({ type: 'request-control' })); };
$('yield').onclick = () => { if (input?.readyState === WebSocket.OPEN) input.send(JSON.stringify({ type: 'yield-control' })); };
$('viewer-name').onchange = () => { if (wanted) { stop(); connect(); } };
$('buffer').onchange = () => { if (wanted) { clearTimeout(reconnectTimer); reconnectTimer = null; connect(); } };
$('resolution').onchange = () => {
  if (wanted) {
    note('Changing stream resolution…');
    clearTimeout(reconnectTimer); reconnectTimer = null; connect();
  }
};
$('sound').onclick = () => { video.muted = !video.muted; $('sound').textContent = video.muted ? 'Enable sound' : 'Mute sound'; };
$('fullscreen').onclick = () => { const action = document.fullscreenElement ? document.exitFullscreen() : $('viewer').requestFullscreen?.(); action?.catch(e => note(e.message)); };
video.onclick = () => { video.focus(); if (wanted && !playing && bufferAhead(video.buffered, video.currentTime) >= target()) video.play().catch(e => note(e.message)); };
video.oncontextmenu = event => { if (control) event.preventDefault(); };
function position(event) {
  if (!metadata) return null;
  // Account for video frame fitting inside the element, then padding inside that frame.
  const rect = video.getBoundingClientRect(), factor = Math.min(rect.width / metadata.width, rect.height / metadata.height);
  const frame = { left: rect.left + (rect.width - metadata.width * factor) / 2, top: rect.top + (rect.height - metadata.height * factor) / 2,
    width: metadata.width * factor, height: metadata.height * factor };
  return pointerPosition(frame, metadata.screen, event.clientX, event.clientY);
}
video.onpointermove = event => { if (!control) return; const p = position(event); if (p) pendingMove = { type: 'move', ...p }; };
setInterval(() => { if (pendingMove) { sendInput(pendingMove); pendingMove = null; } }, 16);
video.onpointerdown = event => {
  if (!control) return;
  const p = position(event); if (!p) return;
  event.preventDefault(); video.focus(); video.setPointerCapture(event.pointerId); dragging = true;
  pendingMove = null; sendInput({ type: 'move', ...p }); sendInput({ type: 'button', button: event.button, down: true });
};
video.onpointerup = event => {
  if (!dragging) return;
  const p = position(event); if (p) sendInput({ type: 'move', ...p }); pendingMove = null;
  sendInput({ type: 'button', button: event.button, down: false }); dragging = false;
};
video.onpointercancel = video.onlostpointercapture = () => { dragging = false; sendInput({ type: 'release' }); };
video.addEventListener('wheel', event => {
  if (!control) return; event.preventDefault();
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 500 : 1;
  sendInput({ type: 'wheel', dx: Math.max(-1000, Math.min(1000, event.deltaX * scale)), dy: Math.max(-1000, Math.min(1000, event.deltaY * scale)) });
}, { passive: false });
for (const name of ['keydown', 'keyup']) video.addEventListener(name, event => {
  if (!control) return; event.preventDefault(); if (event.repeat) return;
  sendInput({ type: 'key', code: event.code, down: name === 'keydown' });
});
video.onblur = () => sendInput({ type: 'release' });
window.addEventListener('blur', () => sendInput({ type: 'release' }));
document.addEventListener('visibilitychange', () => { if (document.hidden && wanted) stop('Paused while hidden'); });
window.addEventListener('pagehide', () => stop());
connect();
