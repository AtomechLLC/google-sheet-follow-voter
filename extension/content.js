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
  let latestTarget = null;    // newest slide index the session asked for
  let latestState = null;
  let followTimer = null;
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

  let badgeHoldUntil = 0; // a failure message stays visible; routine updates don't replace it
  function showBadge(text, ok) {
    if (ok && Date.now() < badgeHoldUntil) return;
    if (!ok) badgeHoldUntil = Date.now() + 6000;
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

  let report = async function report(session, info) {
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
    if (info.presenterView) return; // only the slideshow window reports; the notes window's URL can lag
    if (info.mode !== 'present' && !followInEditor) return;
    const session = sessions.find((s) => s.presentationId === info.presentationId);
    if (!session) return;
    const sig = `${info.presentationId}:${info.objectId}`;
    if (sig === last) return;
    last = sig;
    report(session, info);
  }

  // ---------- update check: warn once per page when the site serves a newer extension ----------
  let updateChecked = false;
  async function checkForUpdate(session) {
    if (updateChecked) return;
    updateChecked = true;
    try {
      const res = await fetch(`${session.server}/api/ext/version`);
      const { version } = await res.json();
      if (version && isNewer(version, chrome.runtime.getManifest().version)) {
        showBadge(`Slide Pulse: update available (${version}). Download it from the dashboard.`, false);
      }
    } catch {}
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
    url.search = new URLSearchParams({ code: session.code, role: 'teacher', key: session.key, name: `${instructorName || 'Presenter'} (Slides)`, ext: chrome.runtime.getManifest().version }).toString();
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => checkForUpdate(session);
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== 'session' || !msg.session) return;
      slidesById = new Map(msg.session.slides.map((sl) => [sl.objectId, sl.idx]));
      slidesByIdx = new Map(msg.session.slides.map((sl) => [sl.idx, sl.objectId]));
      latestTarget = msg.session.currentSlide;
      latestState = msg.session;
      // Coalesce bursts (someone holding the arrow key): act once on the newest target.
      clearTimeout(followTimer);
      followTimer = setTimeout(followServer, 300);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      setTimeout(() => { if (socketKey && !socket) { socketKey = ''; syncRemote(); } }, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  let lastJumped = null; // target we last typed into this window (for windows whose URL has no slide id)

  // The presenter-view window announces itself so the slideshow window never reloads while it is open
  // (a reload breaks presenter view). Same origin, so a BroadcastChannel reaches both windows.
  let presenterSeenAt = 0;
  const channel = (() => { try { return new BroadcastChannel('slide-pulse-presenter'); } catch { return null; } })();
  if (channel) {
    channel.onmessage = (e) => { if (e.data?.presentationId === parseSlidesUrl(location.href)?.presentationId) presenterSeenAt = Date.now(); };
    setInterval(() => {
      const info = parseSlidesUrl(location.href);
      if (info?.presenterView) channel.postMessage({ presentationId: info.presentationId });
    }, 1000);
  }
  const presenterViewOpen = () => Date.now() - presenterSeenAt < 3500;

  function followServer() {
    if (latestTarget === null || inflight) return;
    if (navigating && Date.now() < navigating.until) return; // finish the current move first; it re-checks when done
    const info = parseSlidesUrl(location.href);
    if (!info) return;
    const target = latestTarget;
    const objectId = slidesByIdx.get(target);
    if (!objectId) return;
    const here = info.objectId && !info.presenterView ? slidesById.get(info.objectId) : undefined;
    if (here === target) { lastJumped = target; return; }
    // A window that does not show the slide id in its URL (presenter view) acts on every new target.
    if (here === undefined && lastJumped === target) return;
    const who = latestState?.changedBy ? `${latestState.changedBy}: moving to` : 'Moving to';
    showBadge(`Slide Pulse: ${who} slide ${target + 1}…`, true);
    last = `${info.presentationId}:${objectId}`; // don't report our own move back
    lastJumped = target;
    navigateTo(here, target, objectId, info);
  }

  /** Dispatch a key press once per document (top document plus same-origin iframes). */
  function pressKey(key, code, keyCode) {
    const targets = [
      document.activeElement || document.body,
      ...Array.from(document.querySelectorAll('iframe')).map((f) => { try { return f.contentDocument?.body; } catch { return null; } }),
    ].filter(Boolean);
    for (const t of targets) {
      for (const type of ['keydown', 'keyup']) {
        t.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true }));
      }
    }
  }

  /**
   * Move this window to slide `to` (0-based) by typing its number followed by Enter, which Google
   * Slides treats as "go to slide N" in Present mode and presenter view. Exact, no reload, no
   * animation steps, and harmless if the presentation and presenter-view windows both do it.
   * In the editor, or if typing does not take, load the slide's URL instead.
   */
  function navigateTo(from, to, objectId, info) {
    navigating = { target: to, until: Date.now() + 4000 };
    const done = (moved) => {
      navigating = null;
      last = `${info.presentationId}:${objectId}`;
      if (moved) showBadge(`Slide Pulse: on slide ${to + 1}${latestState?.changedBy ? ` (${latestState.changedBy})` : ''}`, true);
      if (latestTarget !== to) followServer(); // the target moved on while we were busy
    };
    const loadUrl = () => {
      const u = new URL(location.href);
      if (info.mode === 'present') u.searchParams.set('slide', `id.${objectId}`);
      else u.hash = `slide=id.${objectId}`;
      location.assign(u.toString());
    };
    if (info.mode !== 'present') return loadUrl();

    const keys = [...String(to + 1), 'Enter'];
    // Preferred: real keystrokes via the background worker (debugger protocol). If that is
    // unavailable (e.g. DevTools already attached), fall back to synthetic DOM key events.
    const typeSynthetic = () => {
      let i = 0;
      const next = () => {
        if (i < keys.length) {
          const k = keys[i++];
          k === 'Enter' ? pressKey('Enter', 'Enter', 13) : pressKey(k, `Digit${k}`, 48 + Number(k));
          return setTimeout(next, 60);
        }
        started = Date.now();
        setTimeout(verify, 150);
      };
      next();
    };
    const typeNext = () => {
      let answered = false;
      try {
        chrome.runtime.sendMessage({ type: 'typeKeys', keys }, (res) => {
          answered = true;
          if (chrome.runtime.lastError || !res?.ok) return typeSynthetic();
          started = Date.now();
          setTimeout(verify, 150);
        });
      } catch { typeSynthetic(); return; }
      setTimeout(() => { if (!answered) typeSynthetic(); }, 2500);
    };
    let started = Date.now();
    const verify = () => {
      const now = parseSlidesUrl(location.href)?.objectId;
      if (now === objectId) return done(true);
      if (!info.objectId || info.presenterView) return done(true); // no reliable URL here (presenter view): trust the jump
      if (Date.now() - started < 1500) return setTimeout(verify, 100);
      // Typing did not take. Reloading would break presenter view, so only do it for a plain slideshow window.
      if (info.presenterView || window.opener || presenterViewOpen()) {
        showBadge(`Slide Pulse: could not move this window to slide ${to + 1} (keys ignored)`, false);
        return done(false);
      }
      loadUrl();
    };
    typeNext();
  }

  // Diagnostics for the popup ("what does this window think?").
  let lastReport = null;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'status') return;
    const info = parseSlidesUrl(location.href);
    const session = info ? sessions.find((x) => x.presentationId === info.presentationId) : null;
    sendResponse({
      url: location.href,
      mode: info ? (info.presenterView ? 'presenter view (notes window)' : info.mode) : 'not a Slides page',
      presentationId: info?.presentationId || null,
      paired: Boolean(session),
      pairedTitle: session?.title || null,
      slideId: info?.objectId || null,
      slideIndex: info?.objectId ? slidesById.get(info.objectId) : undefined,
      knownSlides: slidesById.size,
      socket: socket ? (socket.readyState === 1 ? 'connected' : 'connecting') : 'not connected',
      remote, paused, followInEditor,
      serverSlide: latestTarget,
      lastReport,
      version: chrome.runtime.getManifest().version,
    });
  });
  const origReport = report;
  report = async (session, info) => { lastReport = `${info.objectId} at ${new Date().toLocaleTimeString()}`; return origReport(session, info); };

  setInterval(tick, POLL_MS);
  setInterval(syncRemote, 1000);
  window.addEventListener('hashchange', tick);
  window.addEventListener('popstate', tick);
})();
