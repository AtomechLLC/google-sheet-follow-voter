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
      await new Promise((r) => setTimeout(r, 40));
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
