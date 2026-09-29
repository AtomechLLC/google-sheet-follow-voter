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
  let numberByIdx = new Map(); // idx -> Google's slide number (counts skipped slides)
  let navigating = null;      // { target, until } while we move the tab ourselves
  let latestTarget = null;    // newest slide index the session asked for
  let latestState = null;
  let followTimer = null;
  let last = '';              // last "presentationId:objectId" we reported
  let inflight = false;
  let badge = null;

  /**
   * Where are we? Newer Google Slides presents inside the editor tab: the URL stays /edit?slide=…
   * while the slideshow is on screen. So "presenting" is decided by the page, not only the path:
   * a /present* path, fullscreen, or the slideshow viewer being present in the DOM.
   */
  function currentInfo() {
    const info = parseSlidesUrl(location.href);
    if (!info) return null;
    const shown = frameObjectId();
    if (shown) info.objectId = shown;
    // Presenter view (speaker notes) is a /present?token=… page titled "Presenter view - …".
    if (!info.presenterView && (/^presenter view\b/i.test(document.title) || document.querySelector('.punch-viewer-speakernotes-body'))) {
      info.presenterView = true;
      info.mode = 'present';
    }
    let why = info.mode === 'present' ? 'url' : null;
    if (!why && document.fullscreenElement) why = 'fullscreen';
    if (!why && document.querySelector('.punch-viewer-content, .punch-viewer-container, .punch-viewer-svgpage, .punch-present-iframe, [class*="punch-viewer-"]')) why = 'viewer';
    if (why) info.mode = 'present';
    info.presentingBecause = why;
    return info;
  }

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
    const info = currentInfo();
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
    const info = currentInfo();
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
    ws.onopen = () => { checkForUpdate(session); syncDebuggerHold(); };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type !== 'session' || !msg.session) return;
      slidesById = new Map(msg.session.slides.map((sl) => [sl.objectId, sl.idx]));
      slidesByIdx = new Map(msg.session.slides.map((sl) => [sl.idx, sl.objectId]));
      numberByIdx = new Map(msg.session.slides.map((sl) => [sl.idx, sl.number || sl.idx + 1]));
      latestTarget = msg.session.currentSlide;
      latestState = msg.session;
      // Coalesce bursts (someone holding the arrow key): act once on the newest target. A move
      // already under way notices the new target itself (see superseded()).
      clearTimeout(followTimer);
      followTimer = setTimeout(followServer, 40);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      setTimeout(() => { if (socketKey && !socket) { socketKey = ''; syncRemote(); } }, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  let lastJumped = null; // target we last typed into this window (for windows whose URL has no slide id)

  // Is a presenter-view window open? (Reloading the slideshow window would break it.) On real
  // Google Slides presenter view is an about:blank popup where this script never runs, so ask the
  // background worker, which finds it by its "Presenter view - …" title without attaching.
  const presenterViewOpen = () => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'hasPresenter' }, (res) => resolve(!chrome.runtime.lastError && Boolean(res?.open)));
    } catch { resolve(false); }
    setTimeout(() => resolve(false), 1000);
  });

  // Keep the debugger attached while this tab presents with remote control on (see background.js):
  // Chrome's bar then appears once at the start instead of flashing over the slide on each move.
  let debuggerHeld = false;
  function syncDebuggerHold() {
    const info = currentInfo();
    const want = Boolean(socket && info && info.mode === 'present' && !info.presenterView);
    if (want === debuggerHeld && !want) return;
    debuggerHeld = want;
    try { chrome.runtime.sendMessage({ type: 'holdDebugger', on: want }, () => void chrome.runtime.lastError); } catch {}
  }

  function followServer() {
    if (latestTarget === null || inflight) return;
    if (navigating && Date.now() < navigating.until) return; // finish the current move first; it re-checks when done
    const info = currentInfo();
    if (!info) return;
    const target = latestTarget;
    const objectId = slidesByIdx.get(target);
    if (!objectId) return;
    if (info.presenterView) return; // the presenter-view window only announces itself; the slideshow window drives
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
   * The in-tab slideshow (newer Google Slides, URL stays /edit) is a same-origin
   * iframe.punch-present-iframe whose own URL is a /present?…&slide=id.X page. On real Slides its
   * ?slide= changes ~50 ms after the picture does, while the editor's address bar trails it by
   * another ~200 ms, and the address bar can also move on its own (hash changes) while the
   * slideshow stays put. So the iframe is the truth; the iframe is removed when the slideshow ends.
   */
  function frameObjectId() {
    const f = document.querySelector('iframe.punch-present-iframe');
    if (!f) return null;
    try {
      const raw = new URL(f.contentWindow.location.href).searchParams.get('slide') || '';
      return raw.replace(/^id\./, '') || null;
    } catch { return null; }
  }

  /** Current slide id: the in-tab slideshow's own URL, else the ?slide= query, else the #slide= hash. */
  function urlObjectId() {
    const shown = frameObjectId();
    if (shown) return shown;
    const u = new URL(location.href);
    const q = u.searchParams.get('slide');
    const raw = q || new URLSearchParams(u.hash.replace(/^#/, '')).get('slide') || '';
    return raw.replace(/^id\./, '') || null;
  }

  /** True once the session has asked for a different slide than the move in progress. */
  const superseded = () => Boolean(navigating && !navigating.test && latestTarget !== null && latestTarget !== navigating.target);

  /**
   * Poll until the slideshow shows objectId and still does 500 ms later; gives up after ms without
   * reaching it. Resolves 'superseded' as soon as a newer target arrives, so a phone tapping Next
   * quickly is not queued behind each move's verification (the old wait held every move ~0.9 s on
   * the in-tab slideshow and the projector fell further behind with each tap).
   */
  const waitHold = (objectId, ms) => new Promise((resolve) => {
    const started = Date.now();
    let reachedAt = 0;
    const poll = () => {
      if (superseded()) return resolve('superseded');
      if (urlObjectId() === objectId) {
        reachedAt ||= Date.now();
        if (Date.now() - reachedAt >= 500) return resolve(true);
      } else {
        reachedAt = 0;
        if (Date.now() - started >= ms) return resolve(false);
      }
      setTimeout(poll, 25);
    };
    poll();
  });

  /** Ask the background worker to click "Slide N" in the presenter-view window's slide list. */
  const presenterJump = (number) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'presenterJump', number, title: document.title }, (res) => {
        if (chrome.runtime.lastError) return resolve(chrome.runtime.lastError.message);
        resolve(res?.ok ? true : (res?.reason || 'none'));
      });
    } catch (err) { resolve(err.message); }
    setTimeout(() => resolve('timed out'), 4000);
  });

  /** Type keys as real keystrokes through the background worker; resolves false if unavailable. */
  const realKeys = (keys) => new Promise((resolve) => {
    let answered = false;
    try {
      chrome.runtime.sendMessage({ type: 'typeKeys', keys }, (res) => {
        answered = true;
        resolve(!chrome.runtime.lastError && Boolean(res?.ok) ? true : (res?.error || chrome.runtime.lastError?.message || 'no response'));
      });
    } catch (err) { resolve(err.message); }
    setTimeout(() => { if (!answered) resolve('timed out'); }, 2500);
  });

  /**
   * Generic stepper: `press(dir)` moves one slide forward (+1) or back (-1). The target is a slide
   * ID; the imported order only supplies the first guess at direction. After each press the ID in
   * the address bar is peeked: if the slideshow moved away from the target (a reordered deck), the
   * direction is reversed. Stops when several presses change nothing.
   */
  const extendLock = () => { if (navigating) navigating.until = Date.now() + 6000; };

  async function stepToward(from, to, objectId, info, press, what) {
    let presses = 0, stalled = 0, lastSeen = urlObjectId(), flipped = false, unknownSeen = 0;
    const startIdx = lastSeen ? slidesById.get(lastSeen) : from;
    // Never wander: at most twice the expected distance plus a few presses for animation builds.
    const maxPresses = startIdx === undefined ? 12 : Math.abs(to - startIdx) * 2 + 8;
    const distance = (id) => { const i = id ? slidesById.get(id) : undefined; return i === undefined ? null : Math.abs(to - i); };
    let dir = startIdx === undefined || to > startIdx ? 1 : -1;
    let prevDist = distance(lastSeen);
    logMove(`stepping with ${what} from slide ${startIdx === undefined ? '?' : startIdx + 1} (${dir > 0 ? 'forward' : 'back'}, max ${maxPresses} presses)`);
    while (presses < maxPresses) {
      if (superseded()) return 'superseded';
      const now = urlObjectId();
      if (now === objectId) return waitHold(objectId, 0);
      if (now !== lastSeen) {
        stalled = 0; lastSeen = now;
        const d = distance(now);
        if (d === null) {
          // A slide the session does not know (deck edited since import?). Two of those in a row: stop.
          if (++unknownSeen >= 2) { logMove(`reached slides the session does not know (${now}); re-import the deck`); return false; }
        } else {
          unknownSeen = 0;
          if (prevDist !== null && d > prevDist) {
            if (flipped) { logMove('moving away from the target again; stopping'); return false; }
            dir = -dir; flipped = true; logMove('moved away from the target; reversing direction');
          }
          prevDist = d;
        }
      } else if (presses) stalled++;
      if (stalled >= 3 && !flipped) { dir = -dir; flipped = true; stalled = 0; logMove('no movement; trying the other direction'); }
      else if (stalled >= 3) { logMove(`${what} stopped moving the slideshow after ${presses} presses`); return false; }
      const ok = await press(dir);
      if (ok !== true) { logMove(`${what} unavailable: ${ok}`); return false; }
      presses++;
      extendLock();
      await new Promise((r) => setTimeout(r, 220));
    }
    logMove(`${what}: gave up after ${presses} presses without reaching the slide`);
    return false;
  }

  const arrowSteps = (from, to, objectId, info) =>
    stepToward(from, to, objectId, info, (dir) => realKeys([dir > 0 ? 'ArrowRight' : 'ArrowLeft']), 'real arrow-key presses');

  /**
   * Move this window to slide `to` (0-based) by typing its number followed by Enter, which Google
   * Slides treats as "go to slide N" in Present mode and presenter view. Exact, no reload, no
   * animation steps, and harmless if the presentation and presenter-view windows both do it.
   * In the editor, or if typing does not take, load the slide's URL instead.
   */
  let moveLog = [];               // what the last move tried, for the popup's test button
  let onMoveDone = null;
  const logMove = (m) => { moveLog.push(`${new Date().toLocaleTimeString()} ${m}`); };

  /** Google's own Previous/Next controls in Present mode and presenter view (found by label). */
  function findNavButton(direction) {
    const want = direction > 0 ? /next/i : /prev/i;
    const docs = [document, ...Array.from(document.querySelectorAll('iframe')).map((f) => { try { return f.contentDocument; } catch { return null; } })].filter(Boolean);
    for (const d of docs) {
      let loose = null;
      for (const el of d.querySelectorAll('[aria-label], [title], [data-tooltip]')) {
        const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-tooltip') || ''}`.trim();
        if (!want.test(label)) continue;
        if (/slide/i.test(label)) return el;
        if (!loose && /^(next|previous|prev)$/i.test(label)) loose = el;
      }
      if (loose) return loose;
    }
    return null;
  }

  /** Step with Google's own Previous/Next controls (same peeking stepper, clicks instead of keys). */
  function clickSteps(from, to, objectId, info) {
    const btnNext = findNavButton(1), btnPrev = findNavButton(-1);
    if (!btnNext && !btnPrev) { logMove('no Previous/Next control found to click'); return Promise.resolve(false); }
    const press = async (dir) => {
      const btn = dir > 0 ? btnNext : btnPrev;
      if (!btn) return 'needed control not found';
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      btn.click();
      return true;
    };
    return stepToward(from, to, objectId, info, press, `"${(btnNext || btnPrev).getAttribute('aria-label') || 'control'}" clicks`);
  }

  function navigateTo(from, to, objectId, info, test = false) {
    navigating = { target: to, until: Date.now() + 8000, test };
    moveLog = [];
    logMove(`move from ${from === undefined ? '?' : from + 1} to ${to + 1} (${info.presenterView ? 'presenter view' : info.mode}${frameObjectId() ? ', in-tab slideshow' : ''})`);
    const done = (moved) => {
      navigating = null;
      last = `${info.presentationId}:${objectId}`;
      logMove(moved ? 'done: slide reached' : 'done: NOT moved');
      if (moved) showBadge(`Slide Pulse: on slide ${to + 1}${latestState?.changedBy ? ` (${latestState.changedBy})` : ''}`, true);
      if (onMoveDone) { const cb = onMoveDone; onMoveDone = null; cb(moved); }
      if (latestTarget !== to) followServer(); // the target moved on while we were busy
    };
    // A newer target arrived mid-move: drop this one (no fallbacks) and head for the newest.
    const abandon = () => {
      navigating = null;
      logMove(`newer target (slide ${latestTarget + 1}) arrived; going there instead`);
      followServer();
      if (!navigating) setTimeout(followServer, 250); // e.g. a report was in flight: try again shortly
    };
    const loadUrl = async () => {
      const u = new URL(location.href);
      // Reloading would break presenter view, so only do it for a plain slideshow window.
      if (info.presenterView || (await presenterViewOpen())) {
        logMove('presenter view is open: not reloading');
        showBadge(`Slide Pulse: could not move this window to slide ${to + 1}`, false);
        return done(false);
      }
      if (/\/d\/[^/]+\/present/.test(u.pathname)) {
        logMove('falling back to loading the slide URL (reload)');
        u.searchParams.set('slide', `id.${objectId}`);
        location.assign(u.toString());
      } else if (info.mode !== 'present') {
        // Plain editor: it follows the hash, no reload needed.
        logMove('editor: navigating by URL hash');
        location.hash = `slide=id.${objectId}`;
        setTimeout(() => done(urlObjectId() === objectId), 800);
      } else {
        // In-tab slideshow on the /edit URL: a reload would end the slideshow and a hash change only
        // moves the editor's address bar, so there is nothing safe left to try.
        logMove('no safe fallback for the in-tab slideshow');
        showBadge(`Slide Pulse: could not move this window to slide ${to + 1}`, false);
        return done(false);
      }
    };
    if (info.mode !== 'present') return loadUrl();

    // Order: one arrow press for Next/Previous -> typed slide number (exact, one shot) -> presenter
    // view's slide list -> arrow-key stepping -> clicking Google's controls. (A URL hash change is
    // NOT used on the in-tab slideshow: the editor follows it and rewrites the address bar while
    // the slideshow on screen stays put.) Every wait gives way to a newer target.
    const googleNumber = numberByIdx.get(to) || to + 1; // what Google calls this slide (skipped slides count)
    const keys = [...String(googleNumber), 'Enter'];
    const oneStep = from !== undefined && Math.abs(to - from) === 1;
    const noSlideInUrl = !info.objectId || info.presenterView; // nothing to verify against: trust the jump

    const run = async () => {
      if (oneStep) {
        // Next/Previous: one real arrow press. On real Slides the picture changes ~130 ms after the
        // press (~260 ms if the debugger had to attach first). If the slide has not changed by
        // 700 ms (an animation build took the press, say), type the number instead; the typed
        // number is absolute, so a late arrow press cannot make it overshoot.
        const arrow = to > from ? 'ArrowRight' : 'ArrowLeft';
        const ok1 = await realKeys([arrow]);
        if (ok1 === true) {
          logMove(`pressed ${arrow} as a real keystroke`);
          const r = await waitHold(objectId, 700);
          if (r === 'superseded') return abandon();
          if (r) return done(true);
          logMove('arrow press did not reach the slide; typing the number');
        }
      }
      if (superseded()) return abandon();
      // Preferred: real keystrokes via the background worker (debugger protocol). If that is
      // unavailable (e.g. DevTools already attached), fall back to synthetic DOM key events.
      const ok = await realKeys(keys);
      if (ok === true) logMove(`typed "${keys.join(' ')}" as real keystrokes`);
      else {
        logMove(`real keystrokes unavailable: ${ok}`);
        logMove('typing with simulated DOM key events');
        for (const k of keys) {
          k === 'Enter' ? pressKey('Enter', 'Enter', 13) : pressKey(k, `Digit${k}`, 48 + Number(k));
          await new Promise((r) => setTimeout(r, 60));
        }
      }
      if (noSlideInUrl) return done(true);
      const typed = await waitHold(objectId, 1500);
      if (typed === 'superseded') return abandon();
      if (typed) return done(true);

      const now = urlObjectId();
      const landed = now ? slidesById.get(now) : undefined;
      logMove(`after typing ${googleNumber}: URL shows ${now ? (landed === undefined ? `unknown slide ${now}` : `slide ${landed + 1} (Google #${numberByIdx.get(landed)})`) : 'no slide'}`);
      if (superseded()) return abandon();

      const pv = await presenterJump(googleNumber);
      if (pv === true) {
        logMove(`clicked "Slide ${googleNumber}" in the presenter view list`);
        const r = await waitHold(objectId, 2500);
        if (r === 'superseded') return abandon();
        if (r) return done(true);
      } else if (pv !== 'none') logMove(`presenter view list: ${pv}`);
      if (superseded()) return abandon();

      for (const steps of [arrowSteps, clickSteps]) {
        const r = await steps(from, to, objectId, info);
        if (r === 'superseded') return abandon();
        if (r === true) return done(true);
      }
      loadUrl();
    };
    run().catch((err) => { logMove(`error: ${err.message}`); done(false); });
  }

  // Diagnostics for the popup ("what does this window think?").
  let lastReport = null;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'testJump') {
      const info = currentInfo();
      const session = info ? sessions.find((x) => x.presentationId === info.presentationId) : null;
      if (!info || !session) return sendResponse({ ok: false, log: ['This window is not a paired Google Slides presentation.'] });
      if (!slidesByIdx.size) return sendResponse({ ok: false, log: ['Not connected to the session yet (no slide list). Is Remote control on and the session live?'] });
      const here = info.objectId ? slidesById.get(info.objectId) : undefined;
      const to = here === 1 ? 0 : 1; // toggle between slide 1 and 2
      const objectId = slidesByIdx.get(to);
      const timer = setTimeout(() => { onMoveDone = null; sendResponse({ ok: false, log: [...moveLog, 'timed out (a reload may have happened; check the slide)'] }); }, 6000);
      onMoveDone = (moved) => { clearTimeout(timer); sendResponse({ ok: moved, log: moveLog }); };
      navigateTo(here, to, objectId, info, true);
      return true;
    }
    if (msg?.type !== 'status') return;
    const info = currentInfo();
    const session = info ? sessions.find((x) => x.presentationId === info.presentationId) : null;
    sendResponse({
      url: location.href,
      mode: info ? (info.presenterView ? 'presenter view (notes window)' : info.mode === 'present' ? `presenting (detected by ${info.presentingBecause})` : 'editor (not presenting)') : 'not a Slides page',
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
      googleSlideNumber: info?.objectId && slidesById.get(info.objectId) !== undefined ? numberByIdx.get(slidesById.get(info.objectId)) : undefined,
      lastMove: moveLog.join(' | ') || null,
      version: chrome.runtime.getManifest().version,
    });
  });
  const origReport = report;
  report = async (session, info) => { lastReport = `${info.objectId} at ${new Date().toLocaleTimeString()}`; return origReport(session, info); };

  setInterval(tick, POLL_MS);
  setInterval(syncRemote, 1000);
  setInterval(syncDebuggerHold, 1000);
  window.addEventListener('hashchange', tick);
  window.addEventListener('popstate', tick);
})();
