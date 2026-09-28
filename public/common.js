// Shared helpers for all pages.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function codeFromPath() {
  const m = location.pathname.match(/\/[tsp]\/([A-Za-z0-9]+)/);
  return m ? m[1].toUpperCase() : null;
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
export function toast(msg, ms = 1800) {
  let el = $('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** WebSocket with automatic reconnect. onMessage(msg) receives parsed JSON. */
export function connectLive({ code, role, key, name, student, onMessage, onStatus = () => {} }) {
  let ws;
  let delay = 500;
  let closed = false;
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ code, role });
    if (key) params.set('key', key);
    if (name) params.set('name', name);
    if (student) params.set('student', student);
    ws = new WebSocket(`${proto}://${location.host}/ws?${params}`);
    ws.onopen = () => { delay = 500; onStatus('online'); };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => {
      onStatus('offline');
      if (closed) return;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 8000);
    };
    ws.onerror = () => ws.close();
  };
  open();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ws.readyState !== WebSocket.OPEN) {
      try { ws.close(); } catch {}
    }
  });
  return { close: () => { closed = true; ws.close(); } };
}

export function studentId() {
  const KEY = 'slidepulse.student';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '');
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { prompt('Copy this link:', text); }
}
