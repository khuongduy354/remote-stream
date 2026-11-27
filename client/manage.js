const $ = id => document.getElementById(id);
const secret = new URLSearchParams(location.hash.slice(1)).get('key');
if (secret) { sessionStorage.setItem('dashboard-key', secret); history.replaceState(null, '', location.pathname); }
const key = secret || sessionStorage.getItem('dashboard-key') || '';
const cards = new Map();
let state = { sessions: [], origins: [] }, busy = false, refreshing = false, sharing = null, confirmAction = null, previewRunning = false, stateRequest = 0;
const title = session => session.kind === 'host' ? 'Main screen' : session.name;
const sessionById = id => state.sessions.find(s => s.id === id);
function notice(message, error = false) {
  $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = !message;
  for (const item of document.querySelectorAll('.dialog-status')) item.hidden = true;
  const active = [...document.querySelectorAll('dialog[open]')].at(-1);
  if (active && message) {
    let status = active.querySelector('.dialog-status');
    if (!status) { status = document.createElement('p'); status.className = 'dialog-status'; status.setAttribute('role', 'status'); active.append(status); }
    status.textContent = message; status.hidden = false; status.classList.toggle('error', error);
  }
}
async function api(path, data) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${key}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Something went wrong. Try again.');
  return result;
}
function invite(session, role = 'control', address = state.origins[0]) {
  const url = new URL('/', address); url.searchParams.set('session', session.id); url.hash = new URLSearchParams({ token: session.tokens[role] }).toString(); return url.href;
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button').forEach(button => { button.disabled = value || button.dataset.unavailable === 'true'; });
}
async function mutate(request, message = 'Updating…', route = '/api/command') {
  if (busy) return null;
  setBusy(true); notice(message);
  try {
    const result = await api(route, request);
    await refresh(true);
    notice(request.action === 'create' ? 'Work desktop ready. Open it to start working.' : '');
    return result;
  } catch (e) { notice(e.message, true); return null; }
  finally { setBusy(false); }
}
function unavailable(button, value) { button.dataset.unavailable = String(value); button.disabled = busy || value; }
function confirmation(heading, message, label, action) {
  $('confirm-title').textContent = heading; $('confirm-message').textContent = message; $('confirm-action').textContent = label;
  confirmAction = action; $('confirm-dialog').showModal();
}
function makeCard(session) {
  const card = document.createElement('article'); card.className = 'screen'; card.dataset.session = session.id;
  card.innerHTML = `<div class="screen-head"><div><h2></h2><p class="screen-type"></p></div><span class="badge">Ready</span></div>
    <div class="preview"><span class="preview-error">Loading preview…</span><img alt="" hidden><span class="preview-label">Screen preview</span></div>
    <div class="screen-body"><p class="description"></p><div class="screen-actions"><a class="primary open-screen" target="_blank" rel="noopener">Open</a><button class="share-screen">Share</button></div></div>
    <details class="screen-details"><summary>People & settings <span class="detail-count"></span></summary><div class="detail-content"><ul class="people"></ul><label class="audio-setting"><input type="checkbox"> Share this screen’s audio</label><p class="technical"></p><button class="danger quiet end-screen">End desktop…</button></div></details>`;
  card.querySelector('.share-screen').onclick = () => openShare(session.id);
  card.querySelector('.badge').onclick = () => { if (sessionById(session.id)?.viewers.some(v => v.requesting)) card.querySelector('details').open = true; };
  card.querySelector('.audio-setting input').onchange = async event => {
    if (busy) { event.target.checked = sessionById(session.id).audio; return; }
    await mutate({ action: 'audio', session: session.id, enabled: event.target.checked }, 'Updating this screen’s audio…');
    event.target.checked = !!sessionById(session.id)?.audio;
  };
  card.querySelector('.end-screen').onclick = () => confirmation(`End ${title(sessionById(session.id))}?`, 'Apps on this work desktop will close. Save any work you want to keep. Other screens stay running.', 'End desktop', async () => !!await mutate({ action: 'end', session: session.id }, 'Closing desktop…'));
  $('screens').append(card);
  const entry = { card, objectURL: null, viewers: null, previewAt: 0 };
  cards.set(session.id, entry); return entry;
}
function updatePeople(entry, session) {
  const fingerprint = JSON.stringify([session.viewers, session.inputReady]);
  if (entry.viewers === fingerprint) return;
  entry.viewers = fingerprint;
  const list = entry.card.querySelector('.people'); list.replaceChildren();
  if (!session.viewers.length) { const empty = document.createElement('li'); empty.className = 'empty-people'; empty.textContent = 'Nobody is connected. Share an invitation to let someone join.'; list.append(empty); return; }
  for (const viewer of session.viewers) {
    const row = document.createElement('li'); row.className = 'person';
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = viewer.name.slice(0, 1).toUpperCase(); avatar.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div'); text.className = 'person-text';
    const name = document.createElement('strong'); name.textContent = viewer.name;
    const role = document.createElement('small'); role.textContent = viewer.controlling ? 'Controlling this screen' : viewer.requesting ? 'Asking for control' : viewer.role === 'view' ? 'Watching only' : 'Can request control';
    text.append(name, role); row.append(avatar, text);
    if (viewer.role === 'control') {
      const button = document.createElement('button'); button.textContent = viewer.controlling ? 'Release' : 'Give control';
      button.setAttribute('aria-label', viewer.controlling ? `Release control from ${viewer.name}` : `Give control to ${viewer.name}`);
      button.onclick = () => mutate({ action: viewer.controlling ? 'revoke' : 'grant', session: session.id, viewer: viewer.id }, 'Updating control…');
      row.append(button);
    }
    const disconnect = document.createElement('button'); disconnect.className = 'icon-button'; disconnect.textContent = '×'; disconnect.setAttribute('aria-label', `Disconnect ${viewer.name}`);
    disconnect.onclick = () => mutate({ action: 'disconnect', session: session.id, viewer: viewer.id }, 'Disconnecting viewer…'); row.append(disconnect); list.append(row);
  }
}
function render() {
  $('screens').querySelector('.loading')?.remove();
  $('screens').hidden = !state.running; $('offline').hidden = !!state.running;
  $('server-settings').hidden = !state.serviceAvailable;
  $('start-server').hidden = !state.serviceAvailable;
  unavailable($('new-desktop'), !state.running || !state.virtualAvailable || state.sessions.length >= 4);
  $('new-desktop').title = !state.virtualAvailable && state.running ? 'Virtual desktop tools are missing on this computer.' : '';
  unavailable($('stop-server'), !state.running);
  for (const [id, entry] of cards) if (!sessionById(id)) { entry.card.remove(); if (entry.objectURL) URL.revokeObjectURL(entry.objectURL); cards.delete(id); }
  for (const session of state.sessions) {
    const entry = cards.get(session.id) || makeCard(session), card = entry.card, host = session.kind === 'host';
    card.querySelector('h2').textContent = title(session);
    card.querySelector('.screen-type').textContent = host ? 'Your existing desktop' : `${session.desktopName || 'Independent'} · separate work desktop`;
    card.querySelector('.description').textContent = host ? 'The screen already running on your computer. Share this screen for games or existing apps.' : 'A separate screen for your work. Its mouse and keyboard won’t affect the main screen.';
    const requesting = session.viewers.some(v => v.requesting), badge = card.querySelector('.badge');
    badge.textContent = requesting ? 'Control requested' : session.connected ? 'In use' : 'Ready'; badge.classList.toggle('request', requesting);
    card.querySelector('.open-screen').href = invite(session);
    card.querySelector('.open-screen').setAttribute('aria-label', `Open ${title(session)}`);
    card.querySelector('.share-screen').setAttribute('aria-label', `Share ${title(session)}`);
    card.querySelector('.detail-count').textContent = `${session.viewers.length} connected`;
    const audio = card.querySelector('.audio-setting input'); audio.checked = !!session.audio; audio.disabled = busy || !session.audioSource;
    card.querySelector('.technical').textContent = `${session.screen.width} × ${session.screen.height}. ` + (host ? 'Uses your main graphics display. Local input also controls this screen. Game streaming latency and gamepads are not optimized yet.' : 'Software graphics. Shares this computer’s files and Linux account. Closing a viewer keeps apps running.') + (session.lastError ? ` ${session.lastError}` : '');
    card.querySelector('.end-screen').hidden = host;
    updatePeople(entry, session);
  }
  let empty = $('screens').querySelector('.blank-screen');
  if (state.sessions.length === 1 && state.sessions[0].kind === 'host') {
    if (!empty) { empty = document.createElement('div'); empty.className = 'blank-screen'; empty.innerHTML = '<div class="empty-icon" aria-hidden="true"></div><h2>Your work can have its own screen</h2><p>Create a work desktop above. You can work there while someone else uses the main screen.</p>'; $('screens').append(empty); }
  } else empty?.remove();
  if (sharing && !sessionById(sharing)) { $('share-dialog').close(); sharing = null; }
  if (sharing) updateShare();
}
async function refresh(force = false) {
  if (refreshing && !force) return;
  refreshing = true;
  const request = ++stateRequest;
  try { const next = await api('/api/state'); if (request === stateRequest) { state = next; render(); } }
  catch (e) { if (request === stateRequest) notice(e.message, true); }
  finally { if (request === stateRequest) refreshing = false; }
}
async function previews() {
  if (previewRunning || document.hidden || !key || !state.running) return;
  previewRunning = true;
  try {
    for (const session of state.sessions) {
      const entry = cards.get(session.id);
      if (!entry || Date.now() - entry.previewAt < 8000) continue;
      entry.previewAt = Date.now();
      try {
        const response = await fetch(`/api/preview?session=${encodeURIComponent(session.id)}`, { headers: { Authorization: `Bearer ${key}` } });
        if (!response.ok) throw Error('Preview unavailable');
        const blob = await response.blob();
        if (cards.get(session.id) !== entry) continue;
        const old = entry.objectURL; entry.objectURL = URL.createObjectURL(blob);
        const img = entry.card.querySelector('img'); img.src = entry.objectURL; img.alt = `${title(session)} screen preview`; img.hidden = false;
        entry.card.querySelector('.preview-error').hidden = true;
        if (old) URL.revokeObjectURL(old);
      } catch { if (!entry.objectURL) entry.card.querySelector('.preview-error').textContent = 'Preview unavailable · you can still open this screen'; }
    }
  } finally { previewRunning = false; }
}
function openShare(id) {
  sharing = id;
  const selected = $('network').value;
  $('network').replaceChildren(...state.origins.map(address => { const option = document.createElement('option'); option.value = address; option.textContent = address; return option; }));
  if (state.origins.includes(selected)) $('network').value = selected;
  $('share-dialog').querySelector('details').open = false;
  $('copy-status').textContent = 'Only this screen is shared.';
  updateShare(); $('share-dialog').showModal();
}
function updateShare() {
  const session = sessionById(sharing); if (!session) return;
  $('share-title').textContent = `Share ${title(session)}`;
  $('share-description').textContent = session.kind === 'host' ? 'They’ll join your existing desktop. Your work desktops stay separate.' : 'They’ll join this work desktop. Your other screens stay separate.';
  const role = document.querySelector('[name="share-role"]:checked').value;
  $('invite-link').value = invite(session, role, $('network').value || state.origins[0]);
}
for (const radio of document.querySelectorAll('[name="share-role"]')) radio.onchange = () => { updateShare(); $('copy-status').textContent = 'Only this screen is shared.'; };
$('network').onchange = updateShare;
$('copy-invite').onclick = async () => {
  const text = $('invite-link').value;
  try {
    if (window.webkit?.messageHandlers?.clipboard) window.webkit.messageHandlers.clipboard.postMessage(text);
    else await navigator.clipboard.writeText(text);
    $('copy-status').textContent = 'Invitation copied. Send it to the person joining.';
  } catch { $('share-dialog').querySelector('details').open = true; $('invite-link').select(); $('copy-status').textContent = 'Select and copy the invitation link below.'; }
};
$('new-desktop').onclick = () => {
  const count = state.sessions.filter(s => s.kind === 'virtual').length;
  $('desktop-environment').replaceChildren(...(state.desktopOptions || []).map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; return option; }));
  $('desktop-name').value = count ? `Work desktop ${count + 1}` : 'Work desktop';
  $('create-dialog').querySelector('details').open = false;
  $('create-dialog').showModal(); $('desktop-name').select();
};
$('create-form').onsubmit = async event => {
  event.preventDefault();
  const name = $('desktop-name').value.trim(); if (!name) { $('desktop-name').focus(); return; }
  const [width, height] = $('desktop-size').value.split('x').map(Number);
  if (await mutate({ action: 'create', name, width, height, desktop: $('desktop-environment').value }, 'Creating your work desktop…')) { $('create-dialog').close(); void previews(); }
};
$('revoke-invites').onclick = () => confirmation('Revoke invitations?', 'Everyone on this screen will disconnect. Old invitation links will stop working.', 'Revoke invitations', async () => !!await mutate({ action: 'rotate', session: sharing }, 'Revoking invitations…'));
$('stop-server').onclick = () => confirmation('Stop all desktops?', 'All work desktops and their apps will close. Save your work first. The main screen itself stays running.', 'Stop server', async () => !!await mutate({ action: 'stop' }, 'Stopping server…', '/api/service'));
$('start-server').onclick = async () => { await mutate({ action: 'start' }, 'Starting server…', '/api/service'); setTimeout(() => refresh(), 800); };
$('confirm-form').onsubmit = async event => { event.preventDefault(); if (confirmAction && await confirmAction()) $('confirm-dialog').close(); };
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => { if (!busy) button.closest('dialog').close(); };
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('share-dialog').addEventListener('close', () => { sharing = null; });
if (!key) { notice('Open Remote Stream from your application launcher to manage screens.', true); unavailable($('new-desktop'), true); $('screens').replaceChildren(); }
else { await refresh(); void previews(); setInterval(() => { if (!document.hidden && !busy) void refresh(); }, 2500); setInterval(previews, 4000); }
