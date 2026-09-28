// Runs inside docs.google.com/presentation/* tabs.
// Watches the URL for the current slide's object id and reports it to the paired Slide Pulse session.
(() => {
  const POLL_MS = 400;
  let sessions = [];          // [{ server, code, key, presentationId, title }]
  let followInEditor = false;
  let paused = false;
  let remote = true;          // follow the session: co-instructors can move this Google Slides tab (default on)
  let instructorName = '';
  let socket = null;
  let socketKey = '';         // which session the socket belongs to
  let slidesById = new Map(); // objectId -> idx, from the session state
  let slidesByIdx = new Map(); // idx -> objectId
  let navigating = null;      // { target, until } while we move the tab ourselves
  let last = '';              // last "presentationId:objectId" we reported
  let inflight = false;
  let badge = null;

  function loadSettings() {
    chrome.storage.sync.get({ sessions: [], followInEditor: false, paused: false, remote: true, instructorName: '' }, (v) => {
      sessions = v.sessions || [];
      followInEditor = Boolean(v.followInEditor);
      paused = Boolean(v.paused);
      remote = Boolean(v.remote);
      instructorName = v.instructorName || '';
      // Note: `last` is deliberately kept, so a settings change never re-reports the
      // tab's slide and undoes a move a co-instructor just made.
      tick();
      syncRemote();
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
        body: JSON.stringify({ objectId: info.objectId, presentationId: info.presentationId, by: instructorName || undefined }),
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
    if (inflight || paused || !sessions.length) return;
    if (navigating && Date.now() < navigating.until) return; // we are moving the tab ourselves
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

  // ---------- remote control: let the session drive this tab ----------
  function currentSession() {
    const info = parseSlidesUrl(location.href);
    if (!info) return null;
    return { info, session: sessions.find((s) => s.presentationId === info.presentationId) || null };
  }

  function syncRemote() {
    const cur = currentSession();
    const wanted = remote && cur?.session && (cur.info.mode === 'present' || followInEditor) ? cur.session : null;
    const key = wanted ? `${wanted.server}|${wanted.code}` : '';
    if (key === socketKey) return;
    if (socket) { try { socket.close(); } catch {} socket = null; }
    socketKey = key;
    if (!wanted) return;
    openSocket(wanted);
  }

  function openSocket(session) {
    const url = new URL(session.server);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = new URLSearchParams({ code: session.code, role: 'teacher', key: session.key, name: `${instructorName || 'Presenter'} (Slides)` }).toString();
    const ws = new WebSocket(url);
    socket = ws;
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== 'session' || !msg.session) return;
      slidesById = new Map(msg.session.slides.map((sl) => [sl.objectId, sl.idx]));
      slidesByIdx = new Map(msg.session.slides.map((sl) => [sl.idx, sl.objectId]));
      followServer(msg.session);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      setTimeout(() => { if (socketKey && !socket) { socketKey = ''; syncRemote(); } }, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  function followServer(state) {
    const info = parseSlidesUrl(location.href);
    if (!info?.objectId || inflight) return;
    const here = slidesById.get(info.objectId);
    const target = state.currentSlide;
    if (here === undefined || here === target) return;
    if (navigating && navigating.target === target && Date.now() < navigating.until) return;
    const objectId = slidesByIdx.get(target);
    if (!objectId) return;
    const who = state.changedBy ? `${state.changedBy} moved to` : 'Moving to';
    showBadge(`Slide Pulse: ${who} slide ${target + 1}`, true);
    last = `${info.presentationId}:${objectId}`; // don't report our own move back
    navigateTo(here, target, objectId, info);
  }

  /** Try the keyboard first (no reload), verify, then fall back to loading the slide's URL. */
  function navigateTo(from, to, objectId, info) {
    const delta = to - from;
    navigating = { target: to, until: Date.now() + 2500 };
    const fallback = () => {
      const u = new URL(location.href);
      if (info.mode === 'present') u.searchParams.set('slide', `id.${objectId}`);
      else u.hash = `slide=id.${objectId}`;
      location.assign(u.toString());
    };
    if (Math.abs(delta) > 6) return fallback();
    const key = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
    const targets = [document.activeElement, document, ...Array.from(document.querySelectorAll('iframe')).map((f) => { try { return f.contentDocument; } catch { return null; } })].filter(Boolean);
    let n = 0;
    const press = () => {
      for (const t of targets) {
        for (const type of ['keydown', 'keyup']) {
          t.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: key === 'ArrowRight' ? 39 : 37, which: key === 'ArrowRight' ? 39 : 37, bubbles: true, cancelable: true }));
        }
      }
      if (++n < Math.abs(delta)) setTimeout(press, 150);
      else setTimeout(verify, 700);
    };
    const verify = () => {
      const now = parseSlidesUrl(location.href);
      if (now?.objectId === objectId) { navigating = null; last = `${info.presentationId}:${objectId}`; return; }
      fallback();
    };
    press();
  }

  setInterval(tick, POLL_MS);
  setInterval(syncRemote, 1000);
  window.addEventListener('hashchange', tick);
  window.addEventListener('popstate', tick);
})();
