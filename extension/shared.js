// Pure helpers shared by content.js and popup.js (loaded as classic scripts).

/** Parse a Google Slides URL into { presentationId, objectId, mode }. */
function parseSlidesUrl(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  const m = u.pathname.match(/\/presentation\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)\/?([a-z]*)/);
  if (!m) return null;
  const presentationId = m[1];
  const mode = m[2] === 'present' ? 'present' : 'edit';
  // Present mode: ?slide=id.g123abc_0_5   Editor: #slide=id.g123abc_0_5
  const raw = u.searchParams.get('slide') || new URLSearchParams(u.hash.replace(/^#/, '')).get('slide') || '';
  const objectId = raw.replace(/^id\./, '') || null;
  return { presentationId, objectId, mode };
}

/** Parse a pasted dashboard link into { server, code, key }. */
function parseDashboardLink(text) {
  let u;
  try { u = new URL(String(text).trim()); } catch { return null; }
  const m = u.pathname.match(/\/t\/([A-Za-z0-9]+)/);
  const key = u.searchParams.get('key');
  if (!m || !key) return null;
  return { server: u.origin, code: m[1].toUpperCase(), key };
}

/** True when version string a is newer than b (dotted integers). */
function isNewer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

if (typeof module !== 'undefined') module.exports = { parseSlidesUrl, parseDashboardLink, isNewer };
