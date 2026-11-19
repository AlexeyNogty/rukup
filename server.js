'use strict';
// «РукUP» — сервер платформы. Node.js 22: встроенные http и SQLite, WebSocket через модуль ws.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const { DatabaseSync } = require('node:sqlite');
const { WebSocketServer } = require('ws');
const R = require('./lib/rules');
const FC = require('./lib/frameCheck');
const WORKS = require('./works');

const scrypt = promisify(crypto.scrypt);
const TEST = process.env.NODE_ENV === 'test';
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_MODE = process.env.PUBLIC === '1';
const TRUSTED_HOPS = Number(process.env.TRUSTED_HOPS) || (PUBLIC_MODE ? 1 : 0);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

let clockShift = 0; // только для тестов: сдвиг времени
const now = () => Date.now() + clockShift;

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg, code = 400) => { throw new HttpError(code, msg); };

/* ============================== БАЗА ДАННЫХ ============================== */
const db = new DatabaseSync(path.join(DATA_DIR, 'rukup.db'));
db.exec(`
PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, pass TEXT NOT NULL,
  role TEXT CHECK (role IN ('student','tutor','admin')), is_admin INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
  grade INTEGER, grade_at INTEGER, subjects TEXT NOT NULL DEFAULT '[]', about TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0, balance INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fav (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (user_id, target_id));
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, a INTEGER NOT NULL, b INTEGER NOT NULL, from_id INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'text', text TEXT NOT NULL, ref INTEGER, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_pair ON messages (a, b, id);
CREATE TABLE IF NOT EXISTS offers (id INTEGER PRIMARY KEY, tutor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, minutes INTEGER NOT NULL, price INTEGER NOT NULL, subject TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', reminded INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lessons (id INTEGER PRIMARY KEY, tutor_id INTEGER NOT NULL, student_id INTEGER NOT NULL, subject TEXT NOT NULL DEFAULT '',
  started INTEGER NOT NULL, ended INTEGER NOT NULL, minutes INTEGER NOT NULL, kind TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0, fee INTEGER NOT NULL DEFAULT 0, counted INTEGER NOT NULL DEFAULT 0, s_rated INTEGER NOT NULL DEFAULT 0, t_rated INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS lessons_t ON lessons (tutor_id); CREATE INDEX IF NOT EXISTS lessons_s ON lessons (student_id);
CREATE TABLE IF NOT EXISTS tutor_marks (tutor_id INTEGER NOT NULL, student_id INTEGER NOT NULL, score10 REAL NOT NULL, weight REAL NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (tutor_id, student_id));
CREATE TABLE IF NOT EXISTS student_records (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL, kind TEXT NOT NULL, value REAL NOT NULL, ref INTEGER, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS records_s ON student_records (student_id, id);
CREATE TABLE IF NOT EXISTS txs (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, work_id TEXT NOT NULL, started INTEGER NOT NULL, deadline INTEGER NOT NULL,
  answers TEXT NOT NULL DEFAULT '[]', submitted INTEGER, score REAL, detail TEXT, UNIQUE (user_id, work_id));
CREATE TABLE IF NOT EXISTS tworks (id INTEGER PRIMARY KEY, tutor_id INTEGER NOT NULL, student_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, minutes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned', started INTEGER, deadline INTEGER, answer TEXT NOT NULL DEFAULT '', attach TEXT NOT NULL DEFAULT '', grade INTEGER, created INTEGER NOT NULL);
`);
const stmts = new Map();
const P = (sql) => { let s = stmts.get(sql); if (!s) { s = db.prepare(sql); stmts.set(sql, s); } return s; };
const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
const safeJson = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const str = (v, max) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);

/* ============================== ПАРОЛИ И СЕССИИ ============================== */
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(String(pw), Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(keyHex, 'hex');
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SESSION_TTL = 30 * 86400_000;
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  P('INSERT INTO sessions (token, user_id, created) VALUES (?,?,?)').run(sha(token), userId, now());
  return token;
}
function lookupSession(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const s = P('SELECT user_id, created FROM sessions WHERE token=?').get(sha(token));
  if (!s || now() - s.created > SESSION_TTL) return null;
  const user = P('SELECT * FROM users WHERE id=?').get(s.user_id);
  if (!user || user.blocked) return null;
  return user;
}
const genPassword = () => crypto.randomBytes(9).toString('base64url');

async function seedAdmins(reset) {
  const lines = [];
  for (const login of ['admin1', 'admin2']) {
    const ex = P('SELECT id FROM users WHERE login=?').get(login);
    if (ex && !reset && !process.env[login.toUpperCase() + '_PASSWORD']) continue;
    // На хостинге пароли админов задаются переменными ADMIN1_PASSWORD и ADMIN2_PASSWORD, чтобы не меняться при перезапуске
    const fromEnv = process.env[login.toUpperCase() + '_PASSWORD'];
    const pw = fromEnv && fromEnv.length >= 8 ? fromEnv : genPassword();
    const hash = await hashPassword(pw);
    if (fromEnv) { if (ex) { P('UPDATE users SET pass=? WHERE id=?').run(hash, ex.id); } else P("INSERT INTO users (login, name, pass, role, is_admin, created) VALUES (?,?,?,'admin',1,?)").run(login, login === 'admin1' ? 'Админ 1' : 'Админ 2', hash, now()); continue; }
    if (ex) { P('UPDATE users SET pass=? WHERE id=?').run(hash, ex.id); P('DELETE FROM sessions WHERE user_id=?').run(ex.id); }
    else P("INSERT INTO users (login, name, pass, role, is_admin, created) VALUES (?,?,?,'admin',1,?)").run(login, login === 'admin1' ? 'Админ 1' : 'Админ 2', hash, now());
    lines.push(`${login}  ${pw}`);
  }
  if (lines.length) {
    fs.writeFileSync(path.join(DATA_DIR, 'admins.txt'), `Пароли админов «РукUP» (сохраните и удалите этот файл)\n${lines.join('\n')}\n`, { mode: 0o600 });
    if (!TEST) console.log(`\nСозданы пароли админов (файл data/admins.txt):\n  ${lines.join('\n  ')}\n`);
  }
}

/* ============================== HTTP: ОБЩЕЕ ============================== */
const SEC_HEADERS = {
  ...(PUBLIC_MODE ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // cdn.jsdelivr.net и wasm нужны только для запуска Python в браузере (Pyodide)
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "media-src 'self' blob:; connect-src 'self' ws: wss: https://cdn.jsdelivr.net https://files.pythonhosted.org https://pypi.org; frame-src *; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
};
function clientIp(req) {
  const direct = req.socket.remoteAddress || '';
  if (!TRUSTED_HOPS) return direct;
  const list = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list[list.length - TRUSTED_HOPS] || direct;
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS });
  res.end(JSON.stringify(obj));
}
function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(new HttpError(400, 'Некорректный запрос')); } });
    req.on('error', reject);
  });
}
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(t); hits.set(key, arr); return true;
}
setInterval(() => { const t = Date.now(); for (const [k, a] of hits) if (!a.length || t - a[a.length - 1] > 3600_000) hits.delete(k); }, 600_000).unref();

/* ============================== ПОЛЬЗОВАТЕЛИ: ПРЕДСТАВЛЕНИЯ ============================== */
const conns = new Map(); // userId -> Set<conn>
const calls = new Map(); // userId -> call
const hands = new Map(); // studentId -> { subject, topic, since }
const invites = new Map(); // studentId -> { tutorId, timer, ... } (или приглашение от ученика репетитору по заявке)
const isOnline = (id) => conns.has(id);
function sendTo(userId, obj) { const s = conns.get(userId); if (s) { const raw = JSON.stringify(obj); for (const c of s) if (c.ws.readyState === 1) c.ws.send(raw); } }

const gradeOf = (u) => R.gradeNow(u.grade, u.grade_at, now());
function tutorStats(id) {
  const marks = P('SELECT score10, weight FROM tutor_marks WHERE tutor_id=?').all(id);
  const lessons = P('SELECT COUNT(*) n FROM lessons WHERE tutor_id=? AND counted=1').get(id).n;
  const rating = R.tutorRating(marks);
  return { rating, marks: marks.length, lessons, ceiling: R.priceCeiling(rating, lessons), free: lessons < R.FREE_LESSONS || rating == null };
}
function studentStats(id) {
  const vals = P('SELECT value FROM student_records WHERE student_id=? ORDER BY id').all(id).map((r) => r.value);
  return { rating: R.studentRating(vals, 30), personal: R.studentRating(vals), lessons: P('SELECT COUNT(*) n FROM lessons WHERE student_id=? AND counted=1').get(id).n };
}
// Публичная карточка: логин не раскрывается
function card(u) {
  const base = { id: u.id, name: u.name, role: u.role, admin: !!u.is_admin, online: isOnline(u.id), busy: calls.has(u.id) };
  if (u.role === 'tutor') { const s = tutorStats(u.id); return { ...base, subjects: safeJson(u.subjects, []), about: u.about, price: Math.min(u.price, s.ceiling), rating: s.rating, marks: s.marks, lessons: s.lessons, free: s.free, ceiling: s.ceiling }; }
  if (u.role === 'student') { const s = studentStats(u.id); return { ...base, grade: gradeOf(u), gradeLabel: R.gradeLabel(gradeOf(u)), rating: s.rating, lessons: s.lessons, about: u.about, goal: u.goal }; }
  return base;
}
function selfView(u) {
  const c = card(u);
  const extra = { login: u.login, balance: u.balance, created: u.created };
  if (u.role === 'student') extra.personal = studentStats(u.id).personal;
  if (u.role === 'tutor') extra.ownPrice = u.price;
  return { ...c, ...extra };
}
const getUser = (id) => P('SELECT * FROM users WHERE id=?').get(Number(id) || 0) || bad('Пользователь не найден', 404);
const isFav = (a, b) => !!P('SELECT 1 FROM fav WHERE user_id=? AND target_id=?').get(a, b);
const isMutual = (a, b) => isFav(a, b) && isFav(b, a);
const pair = (x, y) => (x < y ? [x, y] : [y, x]);

/* ============================== МАРШРУТЫ ============================== */
const routes = new Map();
function route(method, p, opts, fn) { routes.set(`${method} ${p}`, { opts, fn }); }
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, ...(process.env.TURN_URL ? [{ urls: process.env.TURN_URL, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' }] : [])];

route('GET', '/config', {}, () => ({ name: 'РукUP', subjects: R.SUBJECTS, ice: ICE_SERVERS, workMinutes: R.WORK_MINUTES, topupMax: R.TOPUP_MAX }));

route('POST', '/register', { rate: ['register', TEST ? 1000 : 20, 3600_000] }, async (c) => {
  const { login, name, password, password2 } = c.body;
  if (!R.validLogin(login)) bad('Логин: 3–24 символа, латинские буквы, цифры, точка, дефис, подчёркивание');
  if (!R.validName(name)) bad('Имя: от 2 до 40 символов');
  if (!R.validPassword(password)) bad('Пароль: не короче 6 символов');
  if (password !== password2) bad('Пароли не совпадают');
  if (P('SELECT 1 FROM users WHERE login=?').get(login)) bad('Такой логин уже занят', 409);
  const hash = await hashPassword(password);
  let id;
  try { id = Number(P('INSERT INTO users (login, name, pass, created) VALUES (?,?,?,?)').run(login, str(name, 40), hash, now()).lastInsertRowid); }
  catch { bad('Такой логин уже занят', 409); }
  return { token: newSession(id), user: selfView(getUser(id)) };
});

const loginFails = new Map();
route('POST', '/login', { rate: ['login', TEST ? 1000 : 30, 600_000] }, async (c) => {
  const login = str(c.body.login, 40), key = `${login.toLowerCase()}|${c.ip}`;
  const fails = (loginFails.get(key) || []).filter((t) => Date.now() - t < 600_000);
  if (fails.length >= 8) bad('Слишком много неудачных попыток. Попробуйте через 10 минут', 429);
  const u = P('SELECT * FROM users WHERE login=?').get(login);
  const ok = await checkPassword(String(c.body.password ?? ''), u ? u.pass : DUMMY_HASH);
  if (!u || !ok) { fails.push(Date.now()); loginFails.set(key, fails); bad('Неверный логин или пароль', 401); }
  if (u.blocked) bad('Аккаунт заблокирован администратором', 403);
  loginFails.delete(key);
  return { token: newSession(u.id), user: selfView(u) };
});
route('POST', '/logout', { auth: true }, (c) => { P('DELETE FROM sessions WHERE token=?').run(sha(c.token)); return { ok: true }; });
route('GET', '/me', { auth: true }, (c) => ({ user: selfView(c.user) }));

// Роль выбирается один раз. Ученик указывает класс (потом меняет только админ), репетитор — предметы.
route('POST', '/role', { auth: true }, (c) => {
  if (c.user.role) bad('Роль уже выбрана', 409);
  const role = c.body.role;
  if (role === 'student') {
    const g = Number(c.body.grade);
    if (!Number.isInteger(g) || g < 7 || g > 11) bad('Выберите класс с 7 по 11');
    P("UPDATE users SET role='student', grade=?, grade_at=?, balance=? WHERE id=?").run(g, now(), R.START_BALANCE, c.user.id);
    P("INSERT INTO txs (user_id, amount, kind, note, ts) VALUES (?,?,'start','Стартовый баланс',?)").run(c.user.id, R.START_BALANCE, now());
  } else if (role === 'tutor') {
    const subj = [...new Set(Array.isArray(c.body.subjects) ? c.body.subjects : [])].filter((s) => R.SUBJECTS.includes(s));
    if (!subj.length) bad('Отметьте хотя бы один предмет');
    P("UPDATE users SET role='tutor', subjects=? WHERE id=?").run(JSON.stringify(subj), c.user.id);
  } else bad('Выберите роль');
  return { user: selfView(getUser(c.user.id)) };
});

route('POST', '/password', { auth: true, rate: ['password', 10, 600_000] }, async (c) => {
  if (!(await checkPassword(String(c.body.old ?? ''), c.user.pass))) bad('Текущий пароль неверный', 403);
  if (!R.validPassword(c.body.password)) bad('Пароль: не короче 6 символов');
  P('UPDATE users SET pass=? WHERE id=?').run(await hashPassword(c.body.password), c.user.id);
  P('DELETE FROM sessions WHERE user_id=? AND token<>?').run(c.user.id, sha(c.token));
  return { ok: true };
});

route('POST', '/profile', { auth: true, needRole: true }, (c) => {
  const u = c.user;
  const about = str(c.body.about, 200);
  if (u.role === 'tutor') {
    const subj = [...new Set(Array.isArray(c.body.subjects) ? c.body.subjects : [])].filter((s) => R.SUBJECTS.includes(s));
    if (!subj.length) bad('Отметьте хотя бы один предмет');
    const ceil = tutorStats(u.id).ceiling;
    const price = Math.max(0, Math.min(ceil, Math.round(Number(c.body.price) || 0)));
    P('UPDATE users SET about=?, subjects=?, price=? WHERE id=?').run(about, JSON.stringify(subj), price, u.id);
  } else {
    const goal = ['', 'ОГЭ', 'ЕГЭ', 'Олимпиады', 'Учёба'].includes(c.body.goal) ? c.body.goal : '';
    P('UPDATE users SET about=?, goal=? WHERE id=?').run(about, goal, u.id);
  }
  if (c.body.name !== undefined) { if (!R.validName(c.body.name)) bad('Имя: от 2 до 40 символов'); P('UPDATE users SET name=? WHERE id=?').run(str(c.body.name, 40), u.id); }
  pushPresence();
  return { user: selfView(getUser(u.id)) };
});

/* ---------- каталог, лидеры, избранное ---------- */
const byTutor = (a, b) => (b.rating != null) - (a.rating != null) || (b.rating || 0) - (a.rating || 0) || b.lessons - a.lessons || a.name.localeCompare(b.name, 'ru');
route('GET', '/users', { optAuth: true, rate: ['users', 240, 60_000] }, (c) => {
  const q = str(c.query.get('q'), 40).toLowerCase();
  let list = P('SELECT * FROM users WHERE role IS NOT NULL AND blocked=0').all().map(card);
  if (q) list = list.filter((u) => u.name.toLowerCase().includes(q));
  if (c.user) { const favs = new Set(P('SELECT target_id FROM fav WHERE user_id=?').all(c.user.id).map((r) => r.target_id)); for (const u of list) { u.fav = favs.has(u.id); u.mutual = u.fav && isFav(u.id, c.user.id); } }
  list.sort((a, b) => b.admin - a.admin || b.online - a.online || a.name.localeCompare(b.name, 'ru'));
  return { users: list.slice(0, 500), online: conns.size };
});
route('GET', '/tutors', { optAuth: true, rate: ['tutors', 240, 60_000] }, (c) => {
  const subject = c.query.get('subject');
  let list = P("SELECT * FROM users WHERE role='tutor' AND blocked=0").all().filter((u) => isOnline(u.id)).map(card);
  if (subject) list = list.filter((t) => t.subjects.includes(subject));
  if (c.user) for (const t of list) { t.fav = isFav(c.user.id, t.id); t.mutual = t.fav && isFav(t.id, c.user.id); }
  return { tutors: list.sort(byTutor) };
});
route('GET', '/leaders', { rate: ['leaders', 120, 60_000] }, (c) => {
  const subject = c.query.get('subject');
  let tutors = P("SELECT * FROM users WHERE role='tutor' AND blocked=0").all().map(card);
  if (subject) tutors = tutors.filter((t) => t.subjects.includes(subject));
  const students = P("SELECT * FROM users WHERE role='student' AND blocked=0").all().map(card).filter((s) => s.rating != null)
    .sort((a, b) => b.rating - a.rating || b.lessons - a.lessons || a.name.localeCompare(b.name, 'ru'));
  return { tutors: tutors.sort(byTutor).slice(0, 100), students: students.slice(0, 100) };
});
route('POST', '/favorite', { auth: true, needRole: true }, (c) => {
  const t = getUser(c.body.id);
  if (t.id === c.user.id) bad('Нельзя добавить себя');
  if (c.body.on) P('INSERT OR IGNORE INTO fav (user_id, target_id) VALUES (?,?)').run(c.user.id, t.id);
  else P('DELETE FROM fav WHERE user_id=? AND target_id=?').run(c.user.id, t.id);
  const mutual = isMutual(c.user.id, t.id);
  sendTo(t.id, { t: 'fav', from: c.user.id, name: c.user.name, on: !!c.body.on, mutual });
  return { fav: !!c.body.on, mutual };
});
route('GET', '/friends', { auth: true, needRole: true }, (c) => {
  const rows = P('SELECT u.* FROM fav f1 JOIN fav f2 ON f2.user_id=f1.target_id AND f2.target_id=f1.user_id JOIN users u ON u.id=f1.target_id WHERE f1.user_id=? AND u.blocked=0').all(c.user.id);
  return { friends: rows.map((u) => { const [a, b] = pair(c.user.id, u.id); const last = P('SELECT text, kind, ts, from_id FROM messages WHERE a=? AND b=? ORDER BY id DESC LIMIT 1').get(a, b); return { ...card(u), last: last || null }; })
    .sort((x, y) => ((y.last && y.last.ts) || 0) - ((x.last && x.last.ts) || 0)) };
});
const offerView = (o) => ({ id: o.id, tutorId: o.tutor_id, studentId: o.student_id, at: o.at, minutes: o.minutes, price: o.price, subject: o.subject, status: o.status });
route('GET', '/messages', { auth: true, needRole: true }, (c) => {
  const other = getUser(c.query.get('with'));
  if (!isMutual(c.user.id, other.id)) bad('Чат доступен после взаимного добавления в избранное', 403);
  const [a, b] = pair(c.user.id, other.id);
  const rows = P('SELECT * FROM (SELECT * FROM messages WHERE a=? AND b=? ORDER BY id DESC LIMIT 200) ORDER BY id').all(a, b);
  return { messages: rows.map((m) => ({ id: m.id, from: m.from_id, kind: m.kind, text: m.text, ts: m.ts, offer: m.kind === 'offer' && m.ref ? offerView(P('SELECT * FROM offers WHERE id=?').get(m.ref) || {}) : undefined })) };
});

/* ---------- профиль и портфолио ---------- */
route('GET', '/profile', { optAuth: true, rate: ['profile', 240, 60_000] }, (c) => {
  const u = getUser(c.query.get('id'));
  if (u.blocked) bad('Пользователь не найден', 404);
  const out = { user: { ...card(u), created: u.created } };
  const me = c.user;
  if (me) { out.user.fav = isFav(me.id, u.id); out.user.mutual = out.user.fav && isFav(u.id, me.id); }
  // Портфолио ученика видят он сам, репетиторы, взаимные друзья и админы
  if (u.role === 'student' && me && (me.id === u.id || me.role === 'tutor' || me.is_admin || isMutual(me.id, u.id))) {
    const done = P('SELECT work_id, score, submitted FROM attempts WHERE user_id=? AND submitted IS NOT NULL ORDER BY submitted').all(u.id);
    const tw = P("SELECT t.title, t.grade, t.minutes, u.name tutor FROM tworks t JOIN users u ON u.id=t.tutor_id WHERE t.student_id=? AND t.status='graded' ORDER BY t.id").all(u.id);
    const strong = {};
    for (const d of done) { const w = WORKS.byId.get(d.work_id); if (w) (strong[w.subject] = strong[w.subject] || []).push(d.score); }
    out.portfolio = {
      works: done.map((d) => { const w = WORKS.byId.get(d.work_id); return { title: w ? w.title : d.work_id, subject: w ? w.subject : '', score: d.score, ts: d.submitted }; }),
      tutorWorks: tw,
      strong: Object.entries(strong).map(([s, v]) => [s, v.reduce((a, b) => a + b, 0) / v.length]).filter(([, avg]) => avg >= 4).sort((a, b) => b[1] - a[1]).map(([s]) => s),
      badges: badges(u.id, done),
    };
  }
  return out;
});
function badges(id, done) {
  const b = [];
  const st = studentStats(id);
  if (st.lessons >= 1) b.push('Первое занятие');
  if (st.lessons >= 10) b.push('10 занятий');
  if (done.length >= 1) b.push('Первая работа');
  if (done.length >= 5) b.push('5 работ');
  if (done.some((d) => d.score >= 7)) b.push('Максимум за работу');
  return b;
}
route('GET', '/history', { auth: true, needRole: true }, (c) => {
  const col = c.user.role === 'tutor' ? 'tutor_id' : 'student_id', other = c.user.role === 'tutor' ? 'student_id' : 'tutor_id';
  const rows = P(`SELECT l.*, u.name peer FROM lessons l LEFT JOIN users u ON u.id=l.${other} WHERE l.${col}=? ORDER BY l.id DESC LIMIT 100`).all(c.user.id);
  return { lessons: rows.map((l) => ({ id: l.id, peer: l.peer || 'Удалён', subject: l.subject, started: l.started, minutes: l.minutes, kind: l.kind, cost: l.cost, counted: !!l.counted, canRate: canRate(l, c.user) })) };
});

/* ---------- кошелёк (виртуальный) ---------- */
function addTx(userId, amount, kind, note) {
  P('UPDATE users SET balance=balance+? WHERE id=?').run(amount, userId);
  P('INSERT INTO txs (user_id, amount, kind, note, ts) VALUES (?,?,?,?,?)').run(userId, amount, kind, note, now());
}
route('GET', '/wallet', { auth: true, needRole: true }, (c) => ({ balance: getUser(c.user.id).balance, txs: P('SELECT amount, kind, note, ts FROM txs WHERE user_id=? ORDER BY id DESC LIMIT 100').all(c.user.id) }));
route('POST', '/wallet/topup', { auth: true, role: 'student', rate: ['topup', 30, 3600_000] }, (c) => {
  const a = Math.round(Number(c.body.amount));
  if (!(a >= 1 && a <= R.TOPUP_MAX)) bad(`Сумма от 1 до ${R.TOPUP_MAX} ₽`);
  tx(() => addTx(c.user.id, a, 'topup', 'Пополнение (учебный кошелёк)'));
  return { balance: getUser(c.user.id).balance };
});
route('POST', '/wallet/withdraw', { auth: true, role: 'tutor' }, (c) => {
  const a = Math.round(Number(c.body.amount));
  if (!(a >= 1)) bad('Укажите сумму');
  tx(() => { if (getUser(c.user.id).balance < a) bad('Недостаточно средств'); addTx(c.user.id, -a, 'withdraw', 'Вывод (учебный кошелёк)'); });
  return { balance: getUser(c.user.id).balance };
});

/* ---------- заявки на занятие: только репетитор, только в чате друзей ---------- */
function storeMessage(fromId, toId, kind, text, ref) {
  const [a, b] = pair(fromId, toId);
  const ts = now();
  const id = Number(P('INSERT INTO messages (a, b, from_id, kind, text, ref, ts) VALUES (?,?,?,?,?,?,?)').run(a, b, fromId, kind, text, ref ?? null, ts).lastInsertRowid);
  const msg = { id, from: fromId, kind, text, ts, offer: kind === 'offer' ? offerView(P('SELECT * FROM offers WHERE id=?').get(ref)) : undefined };
  sendTo(toId, { t: 'chat', with: fromId, msg }); sendTo(fromId, { t: 'chat', with: toId, msg });
  return msg;
}
route('POST', '/offer', { auth: true, role: 'tutor', rate: ['offer', 60, 3600_000] }, (c) => {
  const st = getUser(c.body.studentId);
  if (st.role !== 'student' || !isMutual(c.user.id, st.id)) bad('Заявку можно отправить только ученику из взаимного избранного', 403);
  const at = Number(c.body.at), minutes = Math.round(Number(c.body.minutes));
  if (!(at > now() - 60_000 && at < now() + 60 * 86400_000)) bad('Укажите дату и время в будущем');
  if (!(minutes >= 20 && minutes <= 300)) bad('Длительность от 20 минут до 5 часов');
  const ceil = tutorStats(c.user.id).ceiling;
  const price = Math.round(Number(c.body.price) || 0);
  if (price < 0 || price > ceil) bad(ceil ? `Цена за час не выше ${ceil} ₽ (потолок по вашему рейтингу)` : 'Пока у вас нет оценок и 5 занятий, занятия бесплатные: укажите цену 0');
  const subject = R.SUBJECTS.includes(c.body.subject) ? c.body.subject : (safeJson(c.user.subjects, [])[0] || '');
  const id = Number(P('INSERT INTO offers (tutor_id, student_id, at, minutes, price, subject, created) VALUES (?,?,?,?,?,?,?)').run(c.user.id, st.id, at, minutes, price, subject, now()).lastInsertRowid);
  storeMessage(c.user.id, st.id, 'offer', 'Заявка на занятие', id);
  return { offer: offerView(P('SELECT * FROM offers WHERE id=?').get(id)) };
});
route('POST', '/offer/reply', { auth: true, role: 'student' }, (c) => {
  const o = P('SELECT * FROM offers WHERE id=?').get(Number(c.body.id) || 0);
  if (!o || o.student_id !== c.user.id) bad('Заявка не найдена', 404);
  if (o.status !== 'open') bad('Заявка уже неактуальна', 409);
  if (now() - o.created > 86400_000) { P("UPDATE offers SET status='expired' WHERE id=?").run(o.id); bad('Заявка сгорела: на неё не ответили за 24 часа', 409); }
  const status = c.body.accept ? 'accepted' : 'declined';
  P('UPDATE offers SET status=? WHERE id=?').run(status, o.id);
  storeMessage(c.user.id, o.tutor_id, 'text', c.body.accept ? 'Заявка принята' : 'Заявка отклонена');
  sendTo(o.tutor_id, { t: 'offer', id: o.id, status }); sendTo(o.student_id, { t: 'offer', id: o.id, status });
  return { status };
});
// Напоминание за 10 минут и сгорание неотвеченных заявок
function sweepOffers() {
  const t = now();
  for (const o of P("SELECT * FROM offers WHERE status='open' AND created < ?").all(t - 86400_000)) { P("UPDATE offers SET status='expired' WHERE id=?").run(o.id); sendTo(o.tutor_id, { t: 'offer', id: o.id, status: 'expired' }); sendTo(o.student_id, { t: 'offer', id: o.id, status: 'expired' }); }
  for (const o of P("SELECT * FROM offers WHERE status='accepted' AND reminded=0 AND at <= ? AND at > ?").all(t + 600_000, t - 60_000)) {
    P('UPDATE offers SET reminded=1 WHERE id=?').run(o.id);
    for (const [uid, peer] of [[o.tutor_id, o.student_id], [o.student_id, o.tutor_id]]) sendTo(uid, { t: 'remind', offer: offerView(o), peer: P('SELECT name FROM users WHERE id=?').get(peer)?.name || '' });
  }
}

/* ---------- практика: работы платформы ---------- */
const workHead = (w) => ({ id: w.id, grade: w.grade, subject: w.subject, title: w.title, tasks: w.tasks.length, minutes: R.WORK_MINUTES, max: w.tasks.reduce((s, t) => s + t.pts, 0) });
function finishAttempt(a) {
  const w = WORKS.byId.get(a.work_id);
  const answers = safeJson(a.answers, []);
  const { score, detail } = w ? R.workScore(w.tasks, answers) : { score: 0, detail: [] };
  tx(() => {
    P('UPDATE attempts SET submitted=?, score=?, detail=? WHERE id=? AND submitted IS NULL').run(Math.min(now(), a.deadline), score, JSON.stringify(detail), a.id);
    P("INSERT INTO student_records (student_id, kind, value, ref, ts) VALUES (?,'work',?,?,?)").run(a.user_id, score, a.id, now());
  });
  sendTo(a.user_id, { t: 'work-done', workId: a.work_id, score });
  return P('SELECT * FROM attempts WHERE id=?').get(a.id);
}
function attemptView(a, w) {
  const done = a.submitted != null;
  const detail = done ? safeJson(a.detail, []) : null;
  return {
    work: workHead(w), started: a.started, deadline: a.deadline, now: now(), submitted: a.submitted, score: a.score, answers: safeJson(a.answers, []),
    // условия видны всегда; ответы и разборы — только после сдачи
    tasks: w.tasks.map((t, i) => ({ q: t.q, pts: t.pts, ...(done ? { ok: !!detail[i], answer: String(t.a).split('|')[0], sol: t.sol } : {}) })),
  };
}
route('GET', '/works', { auth: true, needRole: true }, (c) => {
  const u = c.user;
  if (u.role !== 'student') return { works: WORKS.list.map((w) => ({ ...workHead(w), state: 'view' })), viewer: true };
  const g = gradeOf(u);
  if (g >= 12) return { works: [], graduate: true };
  const mine = new Map(P('SELECT * FROM attempts WHERE user_id=?').all(u.id).map((a) => [a.work_id, a]));
  return { grade: g, works: WORKS.list.filter((w) => w.grade === g).map((w) => { const a = mine.get(w.id); return { ...workHead(w), state: !a ? 'new' : a.submitted != null ? 'done' : 'going', score: a ? a.score : null, deadline: a ? a.deadline : null }; }) };
});
function myAttempt(c, create) {
  const w = WORKS.byId.get(String(c.body.id ?? c.query.get('id'))) || bad('Работа не найдена', 404);
  if (c.user.role !== 'student') bad('Работы выполняют только ученики', 403);
  if (w.grade !== gradeOf(c.user)) bad('Эта работа для другого класса', 403);
  let a = P('SELECT * FROM attempts WHERE user_id=? AND work_id=?').get(c.user.id, w.id);
  if (!a && create) { const t = now(); P('INSERT INTO attempts (user_id, work_id, started, deadline) VALUES (?,?,?,?)').run(c.user.id, w.id, t, t + R.WORK_MINUTES * 60_000); a = P('SELECT * FROM attempts WHERE user_id=? AND work_id=?').get(c.user.id, w.id); }
  if (!a) bad('Работа ещё не начата', 409);
  if (a.submitted == null && now() >= a.deadline) a = finishAttempt(a); // время вышло — сдаётся сама
  return { a, w };
}
route('POST', '/work/start', { auth: true, needRole: true }, (c) => { const { a, w } = myAttempt(c, true); return attemptView(a, w); });
route('GET', '/work', { auth: true, needRole: true }, (c) => { const { a, w } = myAttempt(c, false); return attemptView(a, w); });
route('POST', '/work/save', { auth: true, needRole: true, rate: ['wsave', 600, 60_000] }, (c) => {
  const { a, w } = myAttempt(c, false);
  if (a.submitted != null) return attemptView(a, w);
  const ans = (Array.isArray(c.body.answers) ? c.body.answers : []).slice(0, w.tasks.length).map((x) => str(x, 100));
  P('UPDATE attempts SET answers=? WHERE id=?').run(JSON.stringify(ans), a.id);
  return { saved: true, now: now(), deadline: a.deadline };
});
route('POST', '/work/submit', { auth: true, needRole: true }, (c) => {
  let { a, w } = myAttempt(c, false);
  if (a.submitted == null) {
    if (Array.isArray(c.body.answers)) P('UPDATE attempts SET answers=? WHERE id=?').run(JSON.stringify(c.body.answers.slice(0, w.tasks.length).map((x) => str(x, 100))), a.id);
    a = finishAttempt(P('SELECT * FROM attempts WHERE id=?').get(a.id));
  }
  return attemptView(a, w);
});

/* ---------- работы репетитора для учеников из взаимного избранного ---------- */
const tworkView = (t, me) => ({ id: t.id, title: t.title, minutes: t.minutes, status: t.status, started: t.started, deadline: t.deadline, grade: t.grade, created: t.created, now: now(),
  tutor: P('SELECT name FROM users WHERE id=?').get(t.tutor_id)?.name || 'Удалён', student: P('SELECT name FROM users WHERE id=?').get(t.student_id)?.name || 'Удалён', studentId: t.student_id,
  body: me.id === t.tutor_id || t.status !== 'assigned' ? t.body : undefined, answer: t.status === 'submitted' || t.status === 'graded' || me.id === t.student_id ? t.answer : undefined,
  attach: t.status === 'submitted' || t.status === 'graded' || me.id === t.student_id ? t.attach : undefined });
function closeTwork(t) { P("UPDATE tworks SET status='submitted' WHERE id=? AND status='started'").run(t.id); sendTo(t.tutor_id, { t: 'twork', id: t.id }); sendTo(t.student_id, { t: 'twork', id: t.id }); }
route('GET', '/tworks', { auth: true, needRole: true }, (c) => {
  const col = c.user.role === 'tutor' ? 'tutor_id' : 'student_id';
  const rows = P(`SELECT * FROM tworks WHERE ${col}=? ORDER BY id DESC`).all(c.user.id);
  for (const t of rows) if (t.status === 'started' && now() >= t.deadline) { closeTwork(t); t.status = 'submitted'; }
  return { works: rows.map((t) => tworkView(t, c.user)) };
});
route('POST', '/twork/create', { auth: true, role: 'tutor', rate: ['twork', 30, 3600_000] }, (c) => {
  const st = getUser(c.body.studentId);
  if (st.role !== 'student' || !isMutual(c.user.id, st.id)) bad('Работу можно создать только для ученика из взаимного избранного', 403);
  if (P('SELECT COUNT(*) n FROM tworks WHERE student_id=?').get(st.id).n >= 5) bad('У ученика уже 5 работ от репетиторов — это максимум', 409);
  const title = str(c.body.title, 80), body = str(c.body.body, 8000), minutes = Math.round(Number(c.body.minutes));
  if (title.length < 2 || body.length < 5) bad('Заполните название и задания');
  if (!(minutes >= 20 && minutes <= 300)) bad('Время на работу: от 20 минут до 5 часов');
  const id = Number(P('INSERT INTO tworks (tutor_id, student_id, title, body, minutes, created) VALUES (?,?,?,?,?,?)').run(c.user.id, st.id, title, body, minutes, now()).lastInsertRowid);
  sendTo(st.id, { t: 'twork', id, title, from: c.user.name });
  return { id };
});
const twOf = (c, role) => { const t = P('SELECT * FROM tworks WHERE id=?').get(Number(c.body.id) || 0); if (!t || t[role] !== c.user.id) bad('Работа не найдена', 404); return t; };
route('POST', '/twork/start', { auth: true, role: 'student' }, (c) => {
  const t = twOf(c, 'student_id');
  if (t.status === 'assigned') { const s = now(); P("UPDATE tworks SET status='started', started=?, deadline=? WHERE id=?").run(s, s + t.minutes * 60_000, t.id); }
  return { work: tworkView(P('SELECT * FROM tworks WHERE id=?').get(t.id), c.user) };
});
route('POST', '/twork/submit', { auth: true, role: 'student', big: true }, (c) => {
  const t = twOf(c, 'student_id');
  if (t.status !== 'started') bad('Работа не начата или уже сдана', 409);
  const attach = String(c.body.attach || '');
  if (attach && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(attach) || attach.length > 2_800_000)) bad('Вложение: картинка PNG, JPEG или WebP до 2 МБ');
  const late = now() > t.deadline + 15_000;
  P("UPDATE tworks SET status='submitted', answer=?, attach=? WHERE id=?").run(late ? t.answer : str(c.body.answer, 20000), late ? t.attach : attach, t.id);
  sendTo(t.tutor_id, { t: 'twork', id: t.id, title: t.title, from: c.user.name, submitted: true });
  return { ok: true, late };
});
route('POST', '/twork/draft', { auth: true, role: 'student', rate: ['twdraft', 600, 60_000] }, (c) => {
  const t = twOf(c, 'student_id');
  if (t.status === 'started' && now() <= t.deadline) P('UPDATE tworks SET answer=? WHERE id=?').run(str(c.body.answer, 20000), t.id);
  return { ok: true };
});
route('POST', '/twork/grade', { auth: true, role: 'tutor' }, (c) => {
  const t = twOf(c, 'tutor_id');
  if (t.status === 'started' && now() >= t.deadline) { closeTwork(t); t.status = 'submitted'; }
  if (t.status !== 'submitted') bad('Работа ещё не сдана или уже оценена', 409);
  const g = Number(c.body.grade);
  if (!Number.isInteger(g) || g < 1 || g > 5) bad('Оценка от 1 до 5');
  P("UPDATE tworks SET status='graded', grade=? WHERE id=?").run(g, t.id); // в рейтинг не идёт — только в портфолио
  sendTo(t.student_id, { t: 'twork', id: t.id, title: t.title, graded: g });
  return { ok: true };
});

/* ---------- оценки после звонка ---------- */
function canRate(l, u) {
  if (u.id === l.student_id && !l.s_rated) {
    const sc = R.tutorScale(l.minutes);
    if (!sc) return null;
    const ex = P('SELECT weight FROM tutor_marks WHERE tutor_id=? AND student_id=?').get(l.tutor_id, l.student_id);
    if (l.kind === 'lesson' && !l.counted) return null;
    if (ex && ex.weight >= sc.weight) return null; // оценка уже стоит; заменить её можно только после более длинного занятия
    return { max: sc.max };
  }
  if (u.id === l.tutor_id && !l.t_rated && l.kind === 'lesson' && l.counted) return { max: 5 };
  return null;
}
route('POST', '/rate', { auth: true, needRole: true }, (c) => {
  const l = P('SELECT * FROM lessons WHERE id=?').get(Number(c.body.lessonId) || 0);
  if (!l || (l.tutor_id !== c.user.id && l.student_id !== c.user.id)) bad('Занятие не найдено', 404);
  const can = canRate(l, c.user) || bad('Это занятие оценить нельзя', 409);
  const score = Number(c.body.score);
  if (!Number.isInteger(score) || score < 1 || score > can.max) bad(`Оценка от 1 до ${can.max}`);
  if (c.user.id === l.student_id) {
    const sc = R.tutorScale(l.minutes);
    tx(() => {
      P('INSERT INTO tutor_marks (tutor_id, student_id, score10, weight, ts) VALUES (?,?,?,?,?) ON CONFLICT (tutor_id, student_id) DO UPDATE SET score10=excluded.score10, weight=excluded.weight, ts=excluded.ts')
        .run(l.tutor_id, l.student_id, (score / sc.max) * 10, sc.weight, now());
      P('UPDATE lessons SET s_rated=1 WHERE id=?').run(l.id);
    });
  } else {
    tx(() => {
      P("INSERT INTO student_records (student_id, kind, value, ref, ts) VALUES (?,'lesson',?,?,?)").run(l.student_id, score, l.id, now());
      P('UPDATE lessons SET t_rated=1 WHERE id=?').run(l.id);
    });
  }
  pushPresence();
  return { ok: true };
});

/* ---------- сайты: можно ли показать внутри страницы ---------- */
const frameCache = new Map();
route('GET', '/frame-check', { auth: true, rate: ['frame', 60, 60_000] }, async (c) => {
  const url = str(c.query.get('url'), 500);
  if (frameCache.has(url)) return frameCache.get(url);
  const r = await FC.checkEmbeddable(url);
  if (frameCache.size > 500) frameCache.clear();
  frameCache.set(url, r);
  return r;
});

/* ---------- админ ---------- */
route('GET', '/admin/users', { auth: true, admin: true }, () => ({ users: P('SELECT * FROM users ORDER BY id').all().map((u) => ({ ...card(u), login: u.login, blocked: !!u.blocked, balance: u.balance, created: u.created })) }));
route('POST', '/admin/user', { auth: true, admin: true }, async (c) => {
  const u = getUser(c.body.id);
  if (u.is_admin) bad('Админов менять нельзя', 403);
  switch (c.body.action) {
    case 'grade': { const g = Number(c.body.value); if (u.role !== 'student' || !Number.isInteger(g) || g < 7 || g > 12) bad('Класс 7–11 или 12 (выпускник), только для учеников'); P('UPDATE users SET grade=?, grade_at=? WHERE id=?').run(g, now(), u.id); return { ok: true }; }
    case 'resetpw': { const pw = genPassword(); P('UPDATE users SET pass=? WHERE id=?').run(await hashPassword(pw), u.id); P('DELETE FROM sessions WHERE user_id=?').run(u.id); return { ok: true, password: pw }; }
    case 'block': case 'unblock': { P('UPDATE users SET blocked=? WHERE id=?').run(c.body.action === 'block' ? 1 : 0, u.id); if (c.body.action === 'block') kick(u.id); return { ok: true }; }
    case 'delete': { kick(u.id); P('DELETE FROM users WHERE id=?').run(u.id); P('DELETE FROM messages WHERE a=? OR b=?').run(u.id, u.id); pushPresence(); return { ok: true }; }
    default: bad('Неизвестное действие');
  }
});
function kick(id) { P('DELETE FROM sessions WHERE user_id=?').run(id); const s = conns.get(id); if (s) for (const c of [...s]) { try { c.ws.close(4001, 'blocked'); } catch { /* уже закрыт */ } } }
// Вкладка «Открытый код»: исходники проекта только для чтения
function sourceFiles() {
  const out = [];
  const walk = (dir, rel) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { if (['node_modules', 'data', '.git'].includes(f.name)) continue; const p = path.join(dir, f.name), r = rel ? `${rel}/${f.name}` : f.name; if (f.isDirectory()) walk(p, r); else if (/\.(js|css|html|md|json)$/.test(f.name)) out.push(r); } };
  walk(ROOT, '');
  return out.sort();
}
route('GET', '/admin/source', { auth: true, admin: true }, (c) => {
  const files = sourceFiles();
  const f = c.query.get('file');
  if (!f) return { files };
  if (!files.includes(f)) bad('Файл не найден', 404);
  return { file: f, text: fs.readFileSync(path.join(ROOT, f), 'utf8').slice(0, 400_000) };
});
if (TEST) route('POST', '/test/shift', {}, (c) => { clockShift += Number(c.body.ms) || 0; sweep(); return { now: now() }; });

async function handleApi(req, res, url) {
  try {
    const r = routes.get(`${req.method} ${url.pathname.slice(4)}`);
    if (!r) throw new HttpError(404, 'Не найдено');
    const ip = clientIp(req);
    const c = { req, res, ip, query: url.searchParams, body: {} };
    if (r.opts.rate && !rateLimit(`${r.opts.rate[0]}:${ip}`, r.opts.rate[1], r.opts.rate[2])) throw new HttpError(429, 'Слишком много запросов, попробуйте позже');
    if (req.method === 'POST') c.body = await readJson(req, r.opts.big ? 3_200_000 : 100_000);
    if (r.opts.auth || r.opts.optAuth) {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const user = lookupSession(m && m[1]);
      if (!user && r.opts.auth) throw new HttpError(401, 'Нужно войти');
      if (user) {
        c.user = user; c.token = m[1];
        if (r.opts.admin && !user.is_admin) throw new HttpError(403, 'Только для админов');
        if (r.opts.role && user.role !== r.opts.role) throw new HttpError(403, 'Недоступно для вашей роли');
        if (r.opts.needRole && !user.role) throw new HttpError(409, 'Сначала выберите роль');
      }
    }
    sendJson(res, 200, await r.fn(c));
  } catch (e) {
    if (e instanceof HttpError) sendJson(res, e.code, { error: e.message });
    else { console.error(e); sendJson(res, 500, { error: 'Внутренняя ошибка сервера' }); }
  }
}

/* ============================== СТАТИКА ============================== */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const staticCache = new Map();
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel.includes('\0')) { res.writeHead(404, SEC_HEADERS); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
    let e = staticCache.get(file);
    if (!e || e.mtime !== st.mtimeMs || e.size !== st.size) {
      let buf;
      try { buf = fs.readFileSync(file); } catch { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      e = { mtime: st.mtimeMs, size: st.size, type, buf, etag: `"${sha(buf).slice(0, 20)}"`, gz: /^(text|image\/svg|application\/json)/.test(type) && buf.length > 1024 ? zlib.gzipSync(buf) : null };
      staticCache.set(file, e);
    }
    const base = { 'Content-Type': e.type, 'Cache-Control': 'no-cache', ETag: e.etag, Vary: 'Accept-Encoding', ...SEC_HEADERS };
    if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, base); return res.end(); }
    const gz = e.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, gz ? { ...base, 'Content-Encoding': 'gzip' } : base);
    res.end(req.method === 'HEAD' ? undefined : (gz ? e.gz : e.buf));
  });
}
function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SEC_HEADERS); return res.end(); }
    serveStatic(req, res, url.pathname);
  } catch { try { res.writeHead(400, SEC_HEADERS); res.end(); } catch { /* соединение закрыто */ } }
}
const server = http.createServer(handler);
server.headersTimeout = 20_000; server.requestTimeout = 30_000; server.keepAliveTimeout = 65_000;

/* ============================== РЕАЛЬНОЕ ВРЕМЯ: РУКИ, ПРИГЛАШЕНИЯ, ЗВОНКИ ============================== */
const subjectsOf = (u) => safeJson(u.subjects, []);
const freeTutors = (subject) => { let n = 0; for (const id of conns.keys()) { if (calls.has(id)) continue; const c = [...conns.get(id)][0]; if (c.user.role === 'tutor' && subjectsOf(c.user).includes(subject)) n++; } return n; };
const visibleHands = () => [...hands.entries()].filter(([id]) => isOnline(id) && !calls.has(id)).map(([id, h]) => ({ id, ...h }));

// Рассылка состояния: ученику — счётчики по его предмету, репетитору — до 30 рук по его предметам
let presTimer = null;
function pushPresence() { if (!presTimer) presTimer = setTimeout(() => { presTimer = null; broadcastState(); }, 150); }
function broadcastState() {
  const all = visibleHands();
  for (const [id, set] of conns) {
    const u = [...set][0].user;
    let msg;
    if (u.role === 'student') {
      const h = hands.get(id);
      msg = { t: 'state', hand: h ? { ...h, hands: all.filter((x) => x.subject === h.subject).length, tutors: freeTutors(h.subject) } : null };
    } else if (u.role === 'tutor') {
      const subj = subjectsOf(u);
      const mine = R.pickHands(all.filter((x) => subj.includes(x.subject)), id);
      msg = { t: 'state', hands: mine.map((h) => { const s = P('SELECT * FROM users WHERE id=?').get(h.id); const c = s ? card(s) : null; return c && { id: h.id, name: c.name, gradeLabel: c.gradeLabel, rating: c.rating, lessons: c.lessons, subject: h.subject, topic: h.topic, since: h.since }; }).filter(Boolean) };
    } else msg = { t: 'state' };
    msg.online = conns.size;
    const raw = JSON.stringify(msg);
    for (const c of set) if (c.ws.readyState === 1) c.ws.send(raw);
  }
}

function clearInvite(studentId, reason, notify = true) {
  const inv = invites.get(studentId);
  if (!inv) return;
  clearTimeout(inv.timer); invites.delete(studentId);
  if (notify) { sendTo(inv.from, { t: 'invite-result', ok: false, reason }); sendTo(inv.to, { t: 'invite-cancel' }); }
}
// Приглашение на занятие. Обычно репетитор приглашает ученика с поднятой рукой; по принятой заявке начать может любая сторона.
function doInvite(conn, m) {
  const me = conn.user, other = P('SELECT * FROM users WHERE id=?').get(Number(m.to) || 0);
  const fail = (reason) => sendTo(me.id, { t: 'invite-result', ok: false, reason });
  if (!other || other.blocked) return fail('Пользователь не найден');
  if (calls.has(me.id)) return fail('Вы уже на занятии');
  if (!isOnline(other.id)) return fail('Собеседник не в сети');
  if (calls.has(other.id)) return fail('Собеседник сейчас на другом занятии');
  let tutor, student, offer = null, subject = '';
  if (m.offerId) {
    offer = P('SELECT * FROM offers WHERE id=?').get(Number(m.offerId) || 0);
    if (!offer || offer.status !== 'accepted' || ![offer.tutor_id, offer.student_id].includes(me.id) || ![offer.tutor_id, offer.student_id].includes(other.id) || me.id === other.id) return fail('Заявка не найдена или не принята');
    tutor = offer.tutor_id; student = offer.student_id; subject = offer.subject;
  } else {
    if (me.role !== 'tutor' || other.role !== 'student') return fail('Начать занятие может только репетитор');
    const h = hands.get(other.id);
    if (!h) return fail('Ученик уже опустил руку');
    if (!subjectsOf(me).includes(h.subject)) return fail('Это не ваш предмет');
    tutor = me.id; student = other.id; subject = h.subject;
  }
  const key = student;
  if (invites.has(key)) return fail('Ученика уже приглашает другой репетитор');
  const inv = { from: me.id, to: other.id, tutor, student, subject, offerId: offer ? offer.id : null, comment: str(m.comment, 200) };
  inv.timer = setTimeout(() => clearInvite(key, 'Нет ответа за 60 секунд'), R.INVITE_MS);
  invites.set(key, inv);
  sendTo(other.id, { t: 'invite', from: card(me), subject, comment: inv.comment, offer: offer ? offerView(offer) : null, ms: R.INVITE_MS });
  sendTo(me.id, { t: 'invite-sent', to: other.id, name: other.name });
}
function doInviteReply(conn, m) {
  const me = conn.user;
  const entry = [...invites.entries()].find(([, v]) => v.to === me.id);
  if (!entry) return;
  const [key, inv] = entry;
  if (!m.accept) return clearInvite(key, 'Приглашение отклонено');
  clearTimeout(inv.timer); invites.delete(key);
  if (calls.has(inv.tutor) || calls.has(inv.student) || !isOnline(inv.from)) { sendTo(me.id, { t: 'invite-cancel' }); return sendTo(inv.from, { t: 'invite-result', ok: false, reason: 'Занятие не удалось начать' }); }
  startCall(inv);
}
function startCall(inv) {
  const tutor = getUser(inv.tutor), student = getUser(inv.student);
  const st = tutorStats(tutor.id);
  const offer = inv.offerId ? P('SELECT * FROM offers WHERE id=?').get(inv.offerId) : null;
  const price = st.free ? 0 : Math.min(st.ceiling, offer ? offer.price : tutor.price);
  const call = { id: crypto.randomBytes(8).toString('hex'), tutor: tutor.id, student: student.id, subject: inv.subject, started: now(), price, offerId: inv.offerId };
  calls.set(tutor.id, call); calls.set(student.id, call);
  hands.delete(student.id); // рука опускается, ученик пропадает у остальных репетиторов
  if (offer) P("UPDATE offers SET status='done' WHERE id=?").run(offer.id);
  const base = { t: 'call-start', callId: call.id, subject: call.subject, price, free: st.free, started: call.started, ice: ICE_SERVERS };
  sendTo(inv.from, { ...base, peer: card(inv.from === tutor.id ? student : tutor), polite: false });
  sendTo(inv.to, { ...base, peer: card(inv.to === tutor.id ? student : tutor), polite: true });
  pushPresence();
}
function finishCall(call, reason) {
  if (calls.get(call.tutor) !== call) return;
  calls.delete(call.tutor); calls.delete(call.student);
  const ended = now();
  const minutes = Math.floor((ended - call.started) / 60_000);
  const kind = R.callKind(minutes);
  let lessonId = null, cost = 0, counted = false, paid = 0;
  if (kind !== 'short') {
    tx(() => {
      if (kind === 'lesson') counted = P("SELECT COUNT(*) n FROM lessons WHERE tutor_id=? AND student_id=? AND counted=1 AND ended > ?").get(call.tutor, call.student, ended - 86400_000).n < R.PAIR_DAY_LIMIT;
      const c = R.lessonCost(minutes, call.price);
      const balance = P('SELECT balance FROM users WHERE id=?').get(call.student)?.balance || 0;
      paid = Math.min(c.cost, Math.max(0, balance));
      const fee = Math.round(paid * R.FEE);
      if (paid > 0) { addTx(call.student, -paid, 'lesson', `Занятие ${minutes} мин`); addTx(call.tutor, paid - fee, 'lesson', `Занятие ${minutes} мин, комиссия ${fee} ₽`); }
      cost = paid;
      lessonId = Number(P('INSERT INTO lessons (tutor_id, student_id, subject, started, ended, minutes, kind, price, cost, fee, counted) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(call.tutor, call.student, call.subject, call.started, ended, minutes, kind, call.price, paid, fee, counted ? 1 : 0).lastInsertRowid);
    });
  }
  const l = lessonId ? P('SELECT * FROM lessons WHERE id=?').get(lessonId) : null;
  for (const uid of [call.tutor, call.student]) {
    const u = P('SELECT * FROM users WHERE id=?').get(uid);
    sendTo(uid, { t: 'call-end', reason, summary: { lessonId, minutes, kind, cost, counted, rate: l && u ? canRate(l, u) : null, peer: P('SELECT name FROM users WHERE id=?').get(uid === call.tutor ? call.student : call.tutor)?.name || '' } });
  }
  pushPresence();
}

function doChat(conn, m) {
  const text = str(m.text, 2000), to = Number(m.to) || 0;
  if (!text || !isMutual(conn.user.id, to)) return;
  storeMessage(conn.user.id, to, 'text', text);
}
// Сообщения внутри звонка (сигналы WebRTC, чат занятия, общая доска и код) просто пересылаются собеседнику и не хранятся
function relay(conn, m) {
  const call = calls.get(conn.user.id);
  if (!call) return;
  const other = call.tutor === conn.user.id ? call.student : call.tutor;
  sendTo(other, { t: m.t, data: m.data, from: conn.user.id });
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
server.on('upgrade', (req, socket, head) => {
  let p = ''; try { p = new URL(req.url, 'http://local').pathname; } catch { /* мусор в адресе */ }
  if (p !== '/ws') return socket.destroy();
  if (!rateLimit(`ws:${clientIp(req)}`, 120, 60_000)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  const conn = { ws, user: null, n: 0, t0: Date.now() };
  const authTimer = setTimeout(() => { if (!conn.user) ws.close(4000, 'auth'); }, 10_000);
  ws.on('error', () => { /* обрыв соединения — обработается в close */ });
  ws.on('message', (raw) => {
    if (Date.now() - conn.t0 > 10_000) { conn.t0 = Date.now(); conn.n = 0; }
    if (++conn.n > 600) return ws.close(4008, 'flood');
    let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!m || typeof m !== 'object') return;
    try { onMessage(conn, m); } catch (e) { console.error('ws', e); }
  });
  ws.on('close', () => {
    clearTimeout(authTimer);
    if (!conn.user) return;
    const id = conn.user.id, set = conns.get(id);
    if (set) { set.delete(conn); if (!set.size) conns.delete(id); }
    if (!conns.has(id)) {
      const call = calls.get(id); if (call) finishCall(call, 'Собеседник вышел из сети');
      for (const [k, v] of [...invites]) if (v.from === id || v.to === id) clearInvite(k, 'Собеседник вышел из сети');
    }
    pushPresence();
  });
});
function onMessage(conn, m) {
  if (m.t === 'auth') {
    if (conn.user) return;
    const u = lookupSession(m.token);
    if (!u) return conn.ws.close(4001, 'auth');
    conn.user = u;
    if (!conns.has(u.id)) conns.set(u.id, new Set());
    conns.get(u.id).add(conn);
    conn.ws.send(JSON.stringify({ t: 'ready', inCall: calls.has(u.id) }));
    return pushPresence();
  }
  if (!conn.user) return;
  conn.user = P('SELECT * FROM users WHERE id=?').get(conn.user.id) || conn.user; // свежие данные (предметы, блокировка)
  const u = conn.user;
  switch (m.t) {
    case 'hand': {
      if (u.role !== 'student' || calls.has(u.id)) return;
      if (!R.SUBJECTS.includes(m.subject)) return;
      hands.set(u.id, { subject: m.subject, topic: str(m.topic, 120), since: now() });
      return pushPresence();
    }
    case 'unhand': hands.delete(u.id); clearInvite(u.id, 'Ученик опустил руку'); return pushPresence();
    case 'invite': return doInvite(conn, m);
    case 'invite-reply': return doInviteReply(conn, m);
    case 'invite-cancel': { for (const [k, v] of [...invites]) if (v.from === u.id) { clearTimeout(v.timer); invites.delete(k); sendTo(v.to, { t: 'invite-cancel' }); } return; }
    case 'hangup': { const call = calls.get(u.id); if (call) finishCall(call, 'Занятие завершено'); return; }
    case 'chat': return doChat(conn, m);
    case 'rtc': case 'callmsg': case 'board': case 'code': return relay(conn, m);
    case 'ping': return conn.ws.send('{"t":"pong"}');
  }
}

// Раз в 20 секунд: работы с истёкшим временем сдаются сами, заявки сгорают, напоминания уходят
function sweep() {
  try {
    for (const a of P('SELECT * FROM attempts WHERE submitted IS NULL AND deadline <= ?').all(now())) finishAttempt(a);
    for (const t of P("SELECT * FROM tworks WHERE status='started' AND deadline <= ?").all(now())) closeTwork(t);
    sweepOffers();
  } catch (e) { console.error('sweep', e); }
}
setInterval(sweep, 20_000).unref();
setInterval(() => { try { P('DELETE FROM sessions WHERE created < ?').run(now() - SESSION_TTL); } catch { /* не критично */ } }, 3600_000).unref();
process.on('uncaughtException', (e) => console.error('uncaught', e));

(async () => {
  await seedAdmins(process.argv.includes('--reset-admins'));
  if (process.argv.includes('--reset-admins')) { console.log('Пароли админов обновлены, см. data/admins.txt'); process.exit(0); }
  server.listen(PORT, HOST, () => { if (!TEST) console.log(`«РукUP» запущен: http://localhost:${PORT}`); });
})();
module.exports = { server };
