import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { startHost, until } from './helpers.js';

const host = await startHost({ FPS: '20', WIDTH: '1280', HEIGHT: '720' });
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true });
try {
  const state = await host.command({ action: 'create', name: 'Browser work', width: 1280, height: 720 });
  assert.equal(state.error, undefined, state.error);
  const session = state.sessions.find(s => s.id === state.created);
  const errors = [], pages = [];
  async function pageFor(role) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${host.origin}/?session=${session.id}#token=${session.tokens[role]}`);
    pages.push(page);
    await page.waitForFunction(() => document.querySelector('video').currentTime > 1, null, { timeout: 20000 });
    return page;
  }
  const first = await pageFor('control');
  await first.waitForFunction(() => document.querySelector('#permission').textContent === 'CONTROL ENABLED');
  const second = await pageFor('control');
  assert.equal(await second.locator('#permission').textContent(), 'VIEW ONLY');
  await second.locator('#request').click();
  await until(async () => (await host.command({ action: 'status' })).sessions.find(s => s.id === session.id).viewers.some(v => v.requesting), 'Browser control request not received');
  let latest = (await host.command({ action: 'status' })).sessions.find(s => s.id === session.id);
  const requesting = latest.viewers.find(v => v.requesting);
  await host.command({ action: 'grant', session: session.id, viewer: requesting.id });
  await second.waitForFunction(() => document.querySelector('#permission').textContent === 'CONTROL ENABLED');
  assert.equal(await first.locator('#permission').textContent(), 'VIEW ONLY');
  await second.locator('#yield').click();
  await second.waitForFunction(() => document.querySelector('#permission').textContent === 'VIEW ONLY');
  const observer = await pageFor('view');
  assert.equal(await observer.locator('#request').isDisabled(), true);
  await observer.locator('#resolution').selectOption('640x480');
  await observer.waitForFunction(() => { const v = document.querySelector('video'); return v.videoWidth === 640 && v.videoHeight === 480 && v.currentTime > 1; }, null, { timeout: 20000 });
  await observer.locator('#buffer').selectOption('2000');
  await observer.waitForFunction(() => document.querySelector('video').currentTime > 1, null, { timeout: 20000 });
  await observer.locator('#disconnect').click();
  assert.equal(await observer.locator('#connection').textContent(), 'Disconnected');
  await observer.locator('#connect').click();
  await observer.waitForFunction(() => document.querySelector('video').currentTime > 1, null, { timeout: 20000 });
  await observer.screenshot({ path: '/tmp/remote-stream-session-browser.png' });
  const noInvite = await browser.newPage();
  await noInvite.goto(host.origin);
  assert.equal(await noInvite.locator('#connection').textContent(), 'Invitation required');
  assert.deepEqual(errors, []);
  console.log('PASS: three browser viewers, playback, request/handoff/release control, view-only, resize, buffer, reconnect, missing invitation.');
} finally { await browser.close(); await host.close(); }
