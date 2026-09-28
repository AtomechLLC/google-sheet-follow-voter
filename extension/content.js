// Runs inside docs.google.com/presentation/* tabs.
// Watches the URL for the current slide's object id and reports it to the paired Slide Pulse session.
(() => {
  const POLL_MS = 400;
  let sessions = [];          // [{ server, code, key, presentationId, title }]
  let followInEditor = false;
  let last = '';              // last "presentationId:objectId" we reported
  let inflight = false;
  let badge = null;

  function loadSettings() {
    chrome.storage.sync.get({ sessions: [], followInEditor: false }, (v) => {
      sessions = v.sessions || [];
      followInEditor = Boolean(v.followInEditor);
      last = '';
      tick();
    });
  }
  chrome.storage.onChanged.addListener(loadSettings);
  loadSettings();

  function showBadge(text, ok) {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'slide-pulse-badge';
      Object.assign(badge.style, {
        position: 'fixed', right: '12px', bottom: '12px', zIndex: 2147483647,
        font: '600 12px system-ui, sans-serif', padding: '6px 10px', borderRadius: '999px',
        color: '#fff', background: '#2a78d6', boxShadow: '0 2px 8px rgba(0,0,0,.3)',
        opacity: '0', transition: 'opacity .3s', pointerEvents: 'none',
      });
      document.documentElement.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.background = ok ? '#2a78d6' : '#d03b3b';
    badge.style.opacity = '1';
    clearTimeout(badge._t);
    badge._t = setTimeout(() => (badge.style.opacity = '0'), ok ? 1500 : 6000);
  }

  async function report(session, info) {
    inflight = true;
    try {
      const res = await fetch(`${session.server}/api/ext/session/${session.code}/slide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-key': session.key },
        body: JSON.stringify({ objectId: info.objectId, presentationId: info.presentationId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      showBadge(`Slide Pulse: slide ${data.index + 1} of ${data.slideCount}`, true);
    } catch (err) {
      last = ''; // retry on next tick
      showBadge(`Slide Pulse: ${err.message}`, false);
    } finally {
      inflight = false;
    }
  }

  function tick() {
    if (inflight || !sessions.length) return;
    const info = parseSlidesUrl(location.href);
    if (!info || !info.objectId) return;
    if (info.mode !== 'present' && !followInEditor) return;
    const session = sessions.find((s) => s.presentationId === info.presentationId);
    if (!session) return;
    const sig = `${info.presentationId}:${info.objectId}`;
    if (sig === last) return;
    last = sig;
    report(session, info);
  }

  setInterval(tick, POLL_MS);
  window.addEventListener('hashchange', tick);
  window.addEventListener('popstate', tick);
})();
