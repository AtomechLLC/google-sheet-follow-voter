// Service worker: types keystrokes into a tab through the debugger protocol. These are real,
// trusted key events (the same path a hardware keyboard takes), which Google Slides accepts
// where synthetic DOM events are ignored.
//
// While a tab is presenting with remote control on, the content script asks us to hold the
// debugger attached. Observed on real Google Slides: every attach shows Chrome's "started
// debugging this browser" bar, even over a fullscreen slideshow, and shrinks the slideshow's
// viewport (1440 -> 1384 px) so the projected slide visibly resizes; attaching per move and
// detaching 4 s later made the slide jump on every remote move after a pause, and the attach
// added ~70-130 ms to that move. Held, the bar appears once when presenting starts.
const attached = new Map(); // tabId -> detach timer
const held = new Set();     // tabs the content script wants kept attached
const canceled = new Set(); // tabs where the user clicked Cancel on Chrome's bar: don't hold again

const VK = { Enter: 13, ArrowLeft: 37, ArrowRight: 39 };
function keyParams(key) {
  if (/^\d$/.test(key)) return { key, code: `Digit${key}`, windowsVirtualKeyCode: 48 + Number(key), nativeVirtualKeyCode: 48 + Number(key), text: key, unmodifiedText: key };
  if (key === 'Enter') return { key, code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' };
  return { key, code: key, windowsVirtualKeyCode: VK[key] || 0, nativeVirtualKeyCode: VK[key] || 0 };
}

const send = (target, method, params) => new Promise((resolve, reject) => {
  chrome.debugger.sendCommand(target, method, params, (result) => {
    const err = chrome.runtime.lastError;
    err ? reject(new Error(err.message)) : resolve(result);
  });
});

async function attach(tabId) {
  if (attached.has(tabId)) { clearTimeout(attached.get(tabId)); attached.set(tabId, null); return; }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      // A restarted service worker forgets its sessions; the old one may still be attached.
      err && !/already attached/i.test(err.message) ? reject(new Error(err.message)) : resolve();
    });
  });
  attached.set(tabId, null);
}

function scheduleDetach(tabId) {
  clearTimeout(attached.get(tabId));
  if (held.has(tabId)) return attached.set(tabId, null);
  attached.set(tabId, setTimeout(() => {
    attached.delete(tabId);
    chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
  }, 4000));
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  clearTimeout(attached.get(tabId));
  attached.delete(tabId);
  held.delete(tabId);
  if (reason === 'canceled_by_user') canceled.add(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => { held.delete(tabId); canceled.delete(tabId); });

/** Keep (on) or stop keeping (off) the debugger attached to a presenting tab. */
async function hold(tabId, on) {
  if (!on) {
    canceled.delete(tabId); // a new presentation may hold again
    if (held.delete(tabId)) scheduleDetach(tabId);
    return 'released';
  }
  if (canceled.has(tabId)) return 'canceled by user';
  held.add(tabId);
  await attach(tabId);
  return 'held';
}

async function typeKeys(tabId, keys) {
  await attach(tabId);
  try {
    for (let i = 0; i < keys.length; i++) {
      const p = keyParams(keys[i]);
      await send({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', ...p });
      await send({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', ...p });
      // Google Slides buffers typed digits; 40 ms apart is plenty (was 120 ms, plus 120 ms after Enter).
      if (i < keys.length - 1) await new Promise((r) => setTimeout(r, 40));
    }
  } finally {
    scheduleDetach(tabId);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender.tab?.id) return;
  if (msg?.type === 'holdDebugger') {
    hold(sender.tab.id, Boolean(msg.on))
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => { held.delete(sender.tab.id); sendResponse({ ok: false, error: err.message }); });
    return true;
  }
  if (msg?.type !== 'typeKeys') return;
  typeKeys(sender.tab.id, msg.keys)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // async response
});

// ---------- presenter view (an about:blank popup the content script cannot run in) ----------
const getTargets = () => new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));

async function findPresenterTarget() {
  const targets = await getTargets();
  return targets.find((t) => t.type === 'page' && /presenter view/i.test(t.title || '')) || null;
}

async function withTarget(target, fn) {
  const id = { targetId: target.id };
  const already = attachedTargets.has(target.id);
  if (!already) {
    await new Promise((resolve, reject) => chrome.debugger.attach(id, '1.3', () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve())));
    attachedTargets.add(target.id);
  }
  try { return await fn(id); }
  finally {
    setTimeout(() => { attachedTargets.delete(target.id); chrome.debugger.detach(id, () => void chrome.runtime.lastError); }, 2500);
  }
}
const attachedTargets = new Set();

const evalIn = (id, expression) => send(id, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Trusted click at page coordinates inside the target. */
async function clickAt(id, x, y) {
  await send(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await send(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** Centre of the presenter view's "Slide selector" listbox, or null. */
const SELECTOR_RECT_JS = `(() => {
  const el = document.querySelector('[role="listbox"][aria-label="Slide selector"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const b = el.getBoundingClientRect();
  return b.width && b.height ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
})()`;

/** Centre of the "Slide N" entry in the open selector menu, or null. */
const OPTION_RECT_JS = (n) => `(() => {
  const re = new RegExp('^\\s*Slide ' + ${n} + '(\\b|:)');
  const items = Array.from(document.querySelectorAll('.goog-menuitem, [role="option"], [role="menuitem"]'))
    .filter((e) => !e.closest('[aria-label="Slide selector"]') && re.test((e.textContent || '').trim()));
  const el = items.find((e) => e.getBoundingClientRect().height > 0) || null;
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const b = el.getBoundingClientRect();
  return { x: b.x + Math.min(40, b.width / 2), y: b.y + b.height / 2 };
})()`;

/** Jump using presenter view's own Slide selector (exact, Google numbering). */
async function presenterSelectorJump(id, n) {
  const sel = await evalIn(id, SELECTOR_RECT_JS);
  if (!sel) return 'no Slide selector';
  await clickAt(id, sel.x, sel.y);
  let opt = null;
  for (let i = 0; i < 8 && !opt; i++) { await sleep(150); opt = await evalIn(id, OPTION_RECT_JS(n)); }
  if (!opt) {
    await send(id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send(id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    return `no "Slide ${n}" entry in the Slide selector`;
  }
  await clickAt(id, opt.x, opt.y);
  return true;
}

// Fallback: click "Slide N" wherever it appears in the presenter view (older layouts).
const PRESENTER_JUMP_JS = (n) => `(() => {
  const label = new RegExp('^\\s*Slide ' + ${n} + '(\\b|:)');
  const items = () => Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li, div, span')).filter((e) => e.children.length <= 3 && label.test(e.textContent || ''));
  const click = (e) => { for (const t of ['mousedown', 'mouseup', 'click']) e.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })); };
  let found = items();
  if (!found.length) {
    const opener = Array.from(document.querySelectorAll('[role="button"], button, [role="combobox"], [aria-haspopup]')).find((e) => /^\\s*Slide \\d+/.test(e.textContent || ''));
    if (opener) click(opener);
    found = items();
  }
  if (!found.length) return 'no "Slide ${n}" item in the presenter view';
  click(found[found.length - 1]);
  return true;
})()`;

// Summary of the presenter view's controls, for diagnostics.
const PRESENTER_DUMP_JS = `(() => {
  const els = Array.from(document.querySelectorAll('button, [role], [aria-label], select, input, a'));
  const rows = els.slice(0, 250).map((e) => [e.tagName.toLowerCase(), e.getAttribute('role') || '', e.getAttribute('aria-label') || '', (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60), e.className && typeof e.className === 'string' ? e.className.slice(0, 60) : ''].join(' | '));
  return 'title: ' + document.title + '\\nurl: ' + location.href + '\\nelements: ' + els.length + '\\n' + rows.join('\\n');
})()`;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'hasPresenter') {
    findPresenterTarget().then((t) => sendResponse({ open: Boolean(t) }), () => sendResponse({ open: false }));
    return true;
  }
  if (msg?.type === 'presenterJump') {
    (async () => {
      const target = await findPresenterTarget();
      if (!target) return sendResponse({ ok: false, reason: 'none' });
      const result = await withTarget(target, async (id) => {
        const viaSelector = await presenterSelectorJump(id, Number(msg.number));
        if (viaSelector === true) return true;
        const viaText = await evalIn(id, PRESENTER_JUMP_JS(Number(msg.number)));
        return viaText === true ? true : `${viaSelector}; ${viaText}`;
      });
      sendResponse(result === true ? { ok: true } : { ok: false, reason: String(result) });
    })().catch((err) => sendResponse({ ok: false, reason: err.message }));
    return true;
  }
  if (msg?.type === 'presenterDump') {
    (async () => {
      const target = await findPresenterTarget();
      if (!target) return sendResponse({ ok: false, text: 'No presenter-view window found (open Presenter view in Google Slides first).' });
      const text = await withTarget(target, (id) => evalIn(id, PRESENTER_DUMP_JS));
      sendResponse({ ok: true, text: String(text) });
    })().catch((err) => sendResponse({ ok: false, text: err.message }));
    return true;
  }
});
