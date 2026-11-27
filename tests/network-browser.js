import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.TEST_URL;
if (!base || !new URL(base).hash.includes('token=')) throw Error('Set TEST_URL to a current invitation link from the host panel');
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true });
try {
  const page = await browser.newPage();
  let hold = false, pending = [], connections = 0, activeRoute;
  await page.routeWebSocket('**/ws/video?*', route => {
    connections++; activeRoute = route;
    const server = route.connectToServer();
    server.onMessage(message => {
      if (hold) pending.push({ route, message });
      else route.send(message);
    });
  });
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('video').currentTime > 3, null, { timeout: 20000 });
  const read = () => page.evaluate(() => {
    const v = document.querySelector('video');
    const stats = Object.fromEntries([...document.querySelectorAll('.stat')].map(e => [e.querySelector('span').textContent, e.querySelector('b').textContent]));
    return { time: v.currentTime, paused: v.paused, stats, width: v.videoWidth, height: v.videoHeight,
      audioBytes: v.webkitAudioDecodedByteCount, buffer: v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0 };
  });
  const before = await read();
  hold = true; await page.waitForTimeout(450);
  const during = await read();
  hold = false; for (const item of pending) item.route.send(item.message); pending = [];
  await page.waitForTimeout(1500);
  const after = await read();
  assert.ok(during.time - before.time > .3, 'Playback advances during temporary interruption');
  assert.equal(after.stats.Rebuffers, before.stats.Rebuffers);
  assert.equal(connections, 1);
  console.log('450 ms delivery interruption: PASS', JSON.stringify(after));
  // Longer than server acknowledgement deadline: old stream must close and restart.
  hold = true; await page.waitForTimeout(4200); pending = []; hold = false;
  await page.waitForFunction(() => document.querySelector('video').currentTime > 2 && document.querySelector('#connection').textContent === 'Streaming', null, { timeout: 20000 });
  assert.ok(connections >= 2);
  const recovered = await read();
  assert.equal(recovered.width, 1280); assert.equal(recovered.height, 720); assert.ok(recovered.buffer < 3.1);
  console.log('Prolonged interruption recovery: PASS', JSON.stringify(recovered));
  await page.locator('#disconnect').click();
} finally { await browser.close(); }
