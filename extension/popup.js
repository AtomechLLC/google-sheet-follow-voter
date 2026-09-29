const $ = (s) => document.querySelector(s);
const msg = (text, cls = '') => { $('#msg').textContent = text; $('#msg').className = `msg ${cls}`; };

function render(sessions) {
  $('#list').innerHTML = sessions.map((s, i) => `
    <li><div><b>${esc(s.title)}</b><small>${esc(s.code)} · ${esc(s.server.replace(/^https?:\/\//, ''))}</small></div>
    <button class="link" data-i="${i}">Remove</button></li>`).join('');
}
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const myVersion = chrome.runtime.getManifest().version;
$('#ver').textContent = `v${myVersion}`;
$('#ver-footer').textContent = `v${myVersion}`;
$('#ver-status').textContent = 'checking for updates…';

/** Ask each paired site whether it serves a newer extension. */
async function checkUpdates(sessions) {
  const servers = [...new Set(sessions.map((s) => s.server))];
  const status = $('#ver-status');
  if (!servers.length) { status.textContent = 'pair a presentation to check for updates'; return; }
  let checked = false;
  for (const server of servers) {
    try {
      const { version, downloadUrl } = await (await fetch(`${server}/api/ext/version`)).json();
      checked = true;
      if (version && isNewer(version, myVersion)) {
        const el = $('#update');
        el.style.display = '';
        el.innerHTML = `Update available: v${esc(version)}. <a href="${esc(downloadUrl || server + '/extension.zip')}" target="_blank" rel="noopener">Download</a>, unzip over your extension folder, then click ↻ on chrome://extensions.`;
        status.innerHTML = `<span style="color:#d03b3b">v${esc(version)} available</span>`;
        return;
      }
      status.innerHTML = `<span style="color:#0a7a2f">up to date</span> (site serves v${esc(version)})`;
    } catch {}
  }
  if (!checked) status.textContent = 'could not reach the site to check for updates';
}

chrome.storage.sync.get({ sessions: [], followInEditor: false, paused: false, remote: true, instructorName: '' }, (v) => {
  render(v.sessions);
  checkUpdates(v.sessions);
  $('#editor').checked = Boolean(v.followInEditor);
  $('#paused').checked = Boolean(v.paused);
  $('#remote').checked = Boolean(v.remote);
  $('#name').value = v.instructorName || '';
});
$('#remote').addEventListener('change', () => chrome.storage.sync.set({ remote: $('#remote').checked }));

$('#editor').addEventListener('change', () => chrome.storage.sync.set({ followInEditor: $('#editor').checked }));
$('#paused').addEventListener('change', () => chrome.storage.sync.set({ paused: $('#paused').checked }));
$('#name').addEventListener('change', () => chrome.storage.sync.set({ instructorName: $('#name').value.trim().slice(0, 40) }));

$('#list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (!b) return;
  chrome.storage.sync.get({ sessions: [] }, (v) => {
    const sessions = v.sessions.filter((_, i) => i !== Number(b.dataset.i));
    chrome.storage.sync.set({ sessions }, () => render(sessions));
  });
});

$('#pair').addEventListener('click', async () => {
  const parsed = parseDashboardLink($('#link').value);
  if (!parsed) return msg('That is not a dashboard link. It looks like https://server/t/CODE?key=…', 'err');
  msg('Checking…');
  try {
    const res = await fetch(`${parsed.server}/api/ext/session/${parsed.code}`, { headers: { 'x-session-key': parsed.key } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.demo) throw new Error('Demo sessions have no Google Slides deck to follow.');
    chrome.storage.sync.get({ sessions: [] }, (v) => {
      const sessions = v.sessions.filter((s) => s.presentationId !== data.presentationId);
      sessions.unshift({ ...parsed, presentationId: data.presentationId, title: data.title });
      chrome.storage.sync.set({ sessions }, () => {
        render(sessions);
        $('#link').value = '';
        msg(`Paired “${data.title}”${data.role === 'cohost' ? ' as co-instructor' : ''}. Open the deck and start presenting.`, 'ok');
      });
    });
  } catch (err) {
    msg(err.message, 'err');
  }
});

// Diagnostics: ask the content script in the active tab what it sees.
document.querySelector('details')?.addEventListener('toggle', async (e) => {
  if (!e.target.open) return;
  const out = $('#diag');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('no active tab');
    chrome.tabs.sendMessage(tab.id, { type: 'status' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        out.textContent = 'No answer from this tab. If it is a Google Slides page, reload the tab: tabs opened before the extension was updated still run the old code.';
        return;
      }
      out.textContent = Object.entries(res).map(([k, v]) => `${k}: ${v === undefined ? '(unknown)' : JSON.stringify(v)}`).join('\n');
    });
  } catch (err) { out.textContent = err.message; }
});

$('#test-jump')?.addEventListener('click', async () => {
  const out = $('#test-log'); out.style.display = ''; out.textContent = 'Testing… watch the presentation window.';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { type: 'testJump' }, (res) => {
    if (chrome.runtime.lastError || !res) { out.textContent = 'No answer from this tab. Reload the Google Slides tab (tabs opened before the extension was updated still run the old code), start the slideshow, then try again.'; return; }
    out.textContent = (res.ok ? 'MOVED ✔\n' : 'DID NOT MOVE ✘\n') + res.log.join('\n');
  });
});

let lastStatus = null, lastTest = null, lastDump = null;
const askTab = (msg) => new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => tab ? chrome.tabs.sendMessage(tab.id, msg, (res) => r(chrome.runtime.lastError ? null : res)) : r(null)));
const askBg = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (res) => r(chrome.runtime.lastError ? { ok: false, text: chrome.runtime.lastError.message } : res)));

$('#inspect-pv')?.addEventListener('click', async () => {
  const out = $('#test-log'); out.style.display = ''; out.textContent = 'Looking for the presenter-view window…';
  const res = await askBg({ type: 'presenterDump' });
  lastDump = res?.text || '';
  out.textContent = lastDump;
});

$('#copy-logs')?.addEventListener('click', async () => {
  const status = await askTab({ type: 'status' });
  const parts = [
    `Slide Pulse Follower v${myVersion} — ${new Date().toISOString()}`,
    '--- diagnostics ---',
    status ? Object.entries(status).map(([k, v]) => `${k}: ${v === undefined ? '(unknown)' : JSON.stringify(v)}`).join('\n') : '(no answer from the active tab; reload the Google Slides tab)',
    '--- last test ---',
    $('#test-log').textContent || '(none)',
  ];
  if (lastDump) parts.push('--- presenter view ---', lastDump);
  const text = parts.join('\n');
  try { await navigator.clipboard.writeText(text); msg('Logs copied. Paste them into the chat.', 'ok'); }
  catch { $('#test-log').style.display = ''; $('#test-log').textContent = text; msg('Could not access the clipboard; select the text below and copy it.', 'err'); }
});
