import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.TEST_URL;
if (!base || !new URL(base).hash.includes('token=')) throw Error('Set TEST_URL to a current invitation link from the host panel');
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('video').currentTime > 3, null, { timeout: 20000 });
  await page.getByText('Stream details', { exact: true }).click();
  await page.getByText('Stream settings', { exact: true }).click();
  await page.waitForTimeout(5000);
  const first = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { width: v.videoWidth, height: v.videoHeight, time: v.currentTime, ready: v.readyState, stats: document.querySelector('#stats').innerText, notice: document.querySelector('#notice').innerText, audioBytes: v.webkitAudioDecodedByteCount, permission: document.querySelector('#permission').innerText };
  });
  assert.equal(first.width, 1280); assert.equal(first.height, 720); assert.equal(first.permission, 'CONTROL ENABLED');
  assert.equal(await page.locator('input[type=password]').count(), 0);
  if (process.env.TEST_AUDIO === '1') { assert.ok(first.audioBytes > 0, 'AAC audio decoded'); assert.match(first.stats, /H.264 \/ AAC/); }
  console.log('Desktop browser playback:', JSON.stringify(first));
  assert.match(await page.locator('#resolution option:checked').textContent(), /1280 × 720 \(16:9\)/);
  for (const [value, width, height, ratio] of [['640x480', 640, 480, '4:3'], ['1280x720', 1280, 720, '16:9']]) {
    await page.locator('#resolution').selectOption(value);
    await page.waitForFunction(({ width, height }) => {
      const v = document.querySelector('video');
      return v.videoWidth === width && v.videoHeight === height && v.currentTime > 1;
    }, { width, height }, { timeout: 20000 });
    assert.ok((await page.locator('#resolution option:checked').textContent()).includes(`(${ratio})`));
    console.log(`Resolution change: ${width}×${height} (${ratio}) PASS`);
  }
  await page.locator('#buffer').selectOption('2000');
  await page.waitForFunction(() => document.querySelector('video').currentTime > 2, null, { timeout: 20000 });
  const ahead = await page.evaluate(() => { const v = document.querySelector('video'); return v.buffered.end(v.buffered.length - 1) - v.currentTime; });
  assert.ok(ahead > 1.4 && ahead < 3, `2-second target: ${ahead}`);
  console.log('Buffer change: PASS', ahead.toFixed(2));
  await page.locator('#disconnect').click();
  await page.waitForTimeout(500);
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.querySelector('video').currentTime > 1, null, { timeout: 20000 });
  console.log('Reconnect with new decoder: PASS');
  await page.locator('#disconnect').click();
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
