const $ = (s) => document.querySelector(s);
const msg = (text, cls = '') => { $('#msg').textContent = text; $('#msg').className = `msg ${cls}`; };

function render(sessions) {
  $('#list').innerHTML = sessions.map((s, i) => `
    <li><div><b>${esc(s.title)}</b><small>${esc(s.code)} · ${esc(s.server.replace(/^https?:\/\//, ''))}</small></div>
    <button class="link" data-i="${i}">Remove</button></li>`).join('');
}
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

chrome.storage.sync.get({ sessions: [], followInEditor: false }, (v) => {
  render(v.sessions);
  $('#editor').checked = Boolean(v.followInEditor);
});

$('#editor').addEventListener('change', () => chrome.storage.sync.set({ followInEditor: $('#editor').checked }));

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
        msg(`Paired “${data.title}”. Open the deck and start presenting.`, 'ok');
      });
    });
  } catch (err) {
    msg(err.message, 'err');
  }
});
