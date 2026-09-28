import { WebSocketServer } from 'ws';
import { Sessions, Votes, Questions } from './db.js';
import { translationInfo } from './translate.js';

/** Public state (safe for students). */
export function publicState(code) {
  const s = Sessions.get(code);
  if (!s) return null;
  return {
    code: s.code,
    title: s.title,
    status: s.status,
    statusMessage: s.status_message,
    slideCount: s.slide_count,
    currentSlide: s.current_slide,
    changedBy: s.changed_by,
    changedAt: s.changed_at,
    translation: translationInfo(),
    slides: Sessions.slides(code).map((sl) => ({
      idx: sl.idx,
      objectId: sl.object_id,
      title: sl.title,
      image: sl.image ? `/slides/${code}/${sl.image}` : null,
      notes: sl.notes || null,
    })),
  };
}

/** Aggregate state (teacher dashboard + projected view). */
export function resultsState(code) {
  return {
    counts: Votes.counts(code),
    participants: Votes.participants(code),
    questions: Questions.list(code),
  };
}

// code -> Set<ws>
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function broadcast(code, filter, msgFactory) {
  const room = rooms.get(code);
  if (!room) return;
  let cached;
  for (const ws of room) {
    if (filter && !filter(ws)) continue;
    cached ??= JSON.stringify(msgFactory());
    if (ws.readyState === ws.OPEN) ws.send(cached);
  }
}

/** Notify everyone that session metadata / current slide changed. */
export function broadcastSession(code) {
  broadcast(code, null, () => ({ type: 'session', session: publicState(code) }));
}

/** Instructors currently connected to the dashboard (names, deduplicated). */
export function instructorsOnline(code) {
  const names = [];
  for (const ws of rooms.get(code) || []) {
    if (ws.role === 'teacher' && ws.readyState === ws.OPEN) names.push(ws.name || 'Instructor');
  }
  return [...new Set(names)];
}

export function broadcastPresence(code) {
  broadcast(code, (ws) => ws.role === 'teacher', () => ({ type: 'presence', instructors: instructorsOnline(code) }));
}

/** Send a message to every open connection of one student (they may have several tabs). */
export function notifyStudent(code, studentId, msg) {
  broadcast(code, (ws) => ws.role === 'student' && ws.studentId === studentId, () => msg);
}

/** Notify teacher/present clients that votes or questions changed. */
export function broadcastResults(code) {
  broadcast(code, (ws) => ws.role !== 'student', () => ({ type: 'results', results: resultsState(code) }));
}

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const code = (url.searchParams.get('code') || '').toUpperCase();
    const role = url.searchParams.get('role') || 'student';
    const key = url.searchParams.get('key') || '';
    const session = Sessions.get(code);
    if (!session) {
      send(ws, { type: 'error', message: 'Session not found' });
      ws.close();
      return;
    }
    // Teacher connections must present the owner or co-instructor key; "present" (projected) is public.
    const isInstructor = role === 'teacher' && key && (key === session.key || key === session.cohost_key);
    ws.role = isInstructor ? 'teacher' : role === 'present' ? 'present' : 'student';
    ws.name = String(url.searchParams.get('name') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    ws.studentId = ws.role === 'student' ? String(url.searchParams.get('student') || '').slice(0, 64) : null;
    ws.code = code;
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));

    if (!rooms.has(code)) rooms.set(code, new Set());
    rooms.get(code).add(ws);

    send(ws, { type: 'session', session: publicState(code) });
    if (ws.role !== 'student') send(ws, { type: 'results', results: resultsState(code) });
    if (ws.role === 'teacher') broadcastPresence(code);

    ws.on('close', () => {
      const room = rooms.get(code);
      if (room) {
        room.delete(ws);
        if (room.size === 0) rooms.delete(code);
      }
      if (ws.role === 'teacher') broadcastPresence(code);
    });
    ws.on('error', () => {});
  });

  // Heartbeat to drop dead phone connections.
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(timer));
  return wss;
}
