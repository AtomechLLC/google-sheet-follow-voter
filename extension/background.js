// Service worker: types keystrokes into a tab through the debugger protocol. These are real,
// trusted key events (the same path a hardware keyboard takes), which Google Slides accepts
// where synthetic DOM events are ignored. Attached only while typing, then released.
const attached = new Map(); // tabId -> detach timer

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
      err ? reject(new Error(err.message)) : resolve();
    });
  });
  attached.set(tabId, null);
}

function scheduleDetach(tabId) {
  clearTimeout(attached.get(tabId));
  attached.set(tabId, setTimeout(() => {
    attached.delete(tabId);
    chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
  }, 2500));
}

chrome.debugger.onDetach.addListener(({ tabId }) => { clearTimeout(attached.get(tabId)); attached.delete(tabId); });

async function typeKeys(tabId, keys) {
  await attach(tabId);
  try {
    for (const key of keys) {
      const p = keyParams(key);
      await send({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', ...p });
      await send({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', ...p });
      await new Promise((r) => setTimeout(r, 120));
    }
  } finally {
    scheduleDetach(tabId);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'typeKeys' || !sender.tab?.id) return;
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

// Click "Slide N" in the presenter view's slide list. Works with the list open or closed:
// tries the item directly, and if none is found opens the current-slide control first.
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
  if (msg?.type === 'presenterJump') {
    (async () => {
      const target = await findPresenterTarget();
      if (!target) return sendResponse({ ok: false, reason: 'none' });
      const result = await withTarget(target, (id) => evalIn(id, PRESENTER_JUMP_JS(Number(msg.number))));
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
