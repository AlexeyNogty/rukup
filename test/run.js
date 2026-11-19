'use strict';
// Автотесты «РукUP»: правила (чистые функции) и сервер целиком (HTTP + WebSocket) на временной базе.
process.env.NODE_ENV = 'test';
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
const WebSocket = require('ws');
const R = require('../lib/rules');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukup-'));
process.env.DATA_DIR = dir; process.env.PORT = String(4100 + Math.floor(Math.random() * 800)); process.env.HOST = '127.0.0.1';
require('../server');
const BASE = `http://127.0.0.1:${process.env.PORT}`;

const groups = [];
let cur = null;
const group = (name) => { cur = { name, total: 0, ok: 0, fails: [] }; groups.push(cur); };
const tests = [];
const test = (name, fn) => tests.push({ g: cur, name, fn });

async function api(method, p, body, token) {
  const r = await fetch(BASE + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const shift = (min) => api('POST', '/test/shift', { ms: min * 60_000 });
let seq = 0;
async function mk(role, extra = {}) {
  const login = `u${++seq}_${role}`;
  const r = await api('POST', '/register', { login, name: `${role === 'tutor' ? 'Репетитор' : 'Ученик'} ${seq}`, password: 'secret1', password2: 'secret1' });
  assert.equal(r.status, 200, JSON.stringify(r));
  const rr = await api('POST', '/role', role === 'tutor' ? { role, subjects: extra.subjects || ['Математика'] } : { role, grade: extra.grade || 10 }, r.token);
  assert.equal(rr.status, 200, JSON.stringify(rr));
  return { token: r.token, id: r.user.id, login };
}
function ws(u) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(BASE.replace('http', 'ws') + '/ws');
    const box = { s, log: [], waiters: [] };
    box.send = (o) => s.send(JSON.stringify(o));
    box.wait = (t, ms = 3000) => new Promise((res, rej) => {
      const i = box.log.findIndex((m) => m.t === t);
      if (i >= 0) return res(box.log.splice(i, 1)[0]);
      const w = { t, res }; box.waiters.push(w);
      setTimeout(() => { const k = box.waiters.indexOf(w); if (k >= 0) { box.waiters.splice(k, 1); rej(new Error('нет сообщения ' + t)); } }, ms);
    });
    box.drop = (t) => { box.log = box.log.filter((m) => m.t !== t); };
    s.on('message', (raw) => { const m = JSON.parse(raw); const k = box.waiters.findIndex((w) => w.t === m.t); if (k >= 0) box.waiters.splice(k, 1)[0].res(m); else box.log.push(m); });
    s.on('open', () => { box.send({ t: 'auth', token: u.token }); box.wait('ready').then(() => resolve(box), reject); });
    s.on('error', reject);
    u.ws = box;
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Провести звонок через поднятую руку; вернуть итог со стороны ученика и репетитора
async function lesson(t, s, minutes, subject = 'Математика') {
  s.ws.drop('state'); t.ws.drop('state');
  s.ws.send({ t: 'hand', subject, topic: 'тема' });
  await sleep(250);
  t.ws.send({ t: 'invite', to: s.id, comment: 'Помогу' });
  const inv = await s.ws.wait('invite');
  s.ws.send({ t: 'invite-reply', accept: true });
  const cs = await s.ws.wait('call-start'); await t.ws.wait('call-start');
  await shift(minutes);
  t.ws.send({ t: 'hangup' });
  const es = await s.ws.wait('call-end'), et = await t.ws.wait('call-end');
  return { inv, cs, s: es.summary, t: et.summary };
}

/* ---------- правила ---------- */
group('Правила: рейтинги, цены, длительность');
test('вид звонка по длительности: короткий, помощь, занятие', () => { assert.equal(R.callKind(1), 'short'); assert.equal(R.callKind(2), 'help'); assert.equal(R.callKind(19), 'help'); assert.equal(R.callKind(20), 'lesson'); });
test('шкала оценки репетитора: 5, 7 и 10 баллов с весами 0,5, 1 и 1,5', () => { assert.deepEqual(R.tutorScale(5), { max: 5, weight: 0.5 }); assert.deepEqual(R.tutorScale(45), { max: 7, weight: 1 }); assert.deepEqual(R.tutorScale(60), { max: 10, weight: 1.5 }); assert.equal(R.tutorScale(1), null); });
test('рейтинг репетитора — средневзвешенное (8 с весом 0,5 и 10 с весом 1 дают 9,3)', () => { assert.equal(R.tutorRating([{ score10: 8, weight: 0.5 }, { score10: 10, weight: 1 }]), 9.3); assert.equal(R.tutorRating([]), null); });
test('потолок цены по рейтингу: 0, 300, 500, 800, 1200, 2000', () => { assert.deepEqual([R.priceCeiling(null, 9), R.priceCeiling(9, 2), R.priceCeiling(2.9, 5), R.priceCeiling(3, 5), R.priceCeiling(5, 5), R.priceCeiling(7, 5), R.priceCeiling(9, 5), R.priceCeiling(10, 5)], [0, 0, 300, 500, 800, 1200, 2000, 2000]); });
test('оплата: до часа бесплатно, от часа поминутно за всё время, комиссия 2%', () => { assert.deepEqual(R.lessonCost(59, 600), { cost: 0, fee: 0, tutorGets: 0 }); assert.deepEqual(R.lessonCost(90, 800), { cost: 1200, fee: 24, tutorGets: 1176 }); });
test('рейтинг ученика: среднее последних 30 записей и личный по всем', () => { const v = [1, ...Array(30).fill(5)]; assert.equal(R.studentRating(v, 30), 5); assert.equal(R.studentRating(v), 4.9); assert.equal(R.studentRating([]), null); });
test('класс растёт 1 сентября, после 11-го — выпускник', () => { const reg = Date.parse('2026-11-11'); assert.equal(R.gradeNow(10, reg, Date.parse('2027-08-31')), 10); assert.equal(R.gradeNow(10, reg, Date.parse('2027-09-01T12:00')), 11); assert.equal(R.gradeNow(10, reg, Date.parse('2029-01-01')), 12); assert.equal(R.gradeLabel(12), 'выпускник'); });
test('репетитор видит не больше 30 рук, списки у разных репетиторов различаются', () => { const hs = Array.from({ length: 80 }, (_, i) => ({ id: i, since: i })); const a = R.pickHands(hs, 1), b = R.pickHands(hs, 2); assert.equal(a.length, 30); assert.deepEqual(a.slice(0, 20).map((h) => h.id), b.slice(0, 20).map((h) => h.id)); assert.notDeepEqual(a.map((h) => h.id), b.map((h) => h.id)); });
test('проверка краткого ответа: числа, дроби, запятая, регистр, варианты', () => { assert.ok(R.isCorrect('0,5', '1/2')); assert.ok(R.isCorrect('12', ' 12,0 ')); assert.ok(R.isCorrect('Москва|москва город', 'МОСКВА')); assert.ok(R.isCorrect('-3', '−3')); assert.ok(!R.isCorrect('12', '13')); assert.ok(!R.isCorrect('12', '')); });
test('балл за работу — сумма весов верных задач', () => { const r = R.workScore([{ a: '1', pts: 1 }, { a: '2', pts: 2 }, { a: 'да', pts: 2 }], ['1', '3', 'Да']); assert.equal(r.score, 3); assert.deepEqual(r.detail, [true, false, true]); });

/* ---------- регистрация ---------- */
group('Регистрация, вход, роли');
test('регистрация требует логин, имя и пароль дважды', async () => {
  assert.equal((await api('POST', '/register', { login: 'ab', name: 'Имя', password: 'secret1', password2: 'secret1' })).status, 400);
  assert.equal((await api('POST', '/register', { login: 'okuser', name: 'Имя', password: 'secret1', password2: 'другой' })).status, 400);
  const r = await api('POST', '/register', { login: 'okuser', name: 'Имя', password: 'secret1', password2: 'secret1' });
  assert.equal(r.status, 200); assert.ok(r.token);
  assert.equal((await api('POST', '/register', { login: 'OKUSER', name: 'Имя', password: 'secret1', password2: 'secret1' })).status, 409);
});
test('ученик выбирает класс 7–11 и получает 5000 ₽, сменить класс сам не может', async () => {
  const r = await api('POST', '/register', { login: 'st_role', name: 'Ученик', password: 'secret1', password2: 'secret1' });
  assert.equal((await api('POST', '/role', { role: 'student', grade: 6 }, r.token)).status, 400);
  const ok = await api('POST', '/role', { role: 'student', grade: 9 }, r.token);
  assert.equal(ok.user.grade, 9); assert.equal(ok.user.balance, 5000);
  assert.equal((await api('POST', '/role', { role: 'student', grade: 11 }, r.token)).status, 409);
});
test('репетитор обязан выбрать предметы из списка 13 предметов', async () => {
  const r = await api('POST', '/register', { login: 'tu_role', name: 'Репетитор', password: 'secret1', password2: 'secret1' });
  assert.equal((await api('POST', '/role', { role: 'tutor', subjects: ['Астрология'] }, r.token)).status, 400);
  const ok = await api('POST', '/role', { role: 'tutor', subjects: ['Химия', 'Китайский язык'] }, r.token);
  assert.deepEqual(ok.user.subjects, ['Химия', 'Китайский язык']); assert.equal(R.SUBJECTS.length, 13);
});
test('неверный пароль не пускает, после 8 ошибок вход блокируется', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await api('POST', '/login', { login: 'okuser', password: 'нет' })).status, 401);
  assert.equal((await api('POST', '/login', { login: 'okuser', password: 'secret1' })).status, 429);
});
test('без входа закрытые разделы недоступны, каталог виден гостю без логинов', async () => {
  assert.equal((await api('GET', '/me')).status, 401); assert.equal((await api('GET', '/works')).status, 401);
  const u = await api('GET', '/users'); assert.equal(u.status, 200); assert.ok(u.users.length >= 2); assert.ok(u.users.every((x) => x.login === undefined));
  assert.ok(u.users.some((x) => x.admin));
});

/* ---------- руки и занятия ---------- */
group('Поднятая рука и занятия');
let T, S, S2, T2;
test('руку видят только репетиторы этого предмета; ученик видит счётчики', async () => {
  T = await mk('tutor'); T2 = await mk('tutor', { subjects: ['Физика'] }); S = await mk('student'); S2 = await mk('student');
  await ws(T); await ws(T2); await ws(S); await ws(S2);
  S.ws.send({ t: 'hand', subject: 'Математика', topic: 'логарифмы' });
  await sleep(350);
  const last = (b) => b.log.filter((m) => m.t === 'state').pop();
  assert.equal(last(T.ws).hands.length, 1); assert.equal(last(T.ws).hands[0].topic, 'логарифмы');
  assert.equal(last(T2.ws).hands.length, 0);
  assert.deepEqual([last(S.ws).hand.hands, last(S.ws).hand.tutors], [1, 1]);
  S.ws.send({ t: 'unhand' }); await sleep(300);
  assert.equal(last(T.ws).hands.length, 0);
});
test('репетитор чужого предмета и ученик не могут начать занятие', async () => {
  S.ws.send({ t: 'hand', subject: 'Математика' }); await sleep(200);
  T2.ws.send({ t: 'invite', to: S.id }); assert.equal((await T2.ws.wait('invite-result')).ok, false);
  S2.ws.send({ t: 'invite', to: S.id }); assert.equal((await S2.ws.wait('invite-result')).ok, false);
  S.ws.send({ t: 'unhand' }); await sleep(100);
});
test('отказ ученика оставляет руку поднятой', async () => {
  S.ws.send({ t: 'hand', subject: 'Математика' }); await sleep(200);
  T.ws.send({ t: 'invite', to: S.id, comment: 'Привет' });
  const inv = await S.ws.wait('invite'); assert.equal(inv.comment, 'Привет'); assert.equal(inv.from.id, T.id); assert.equal(inv.from.rating, null);
  S.ws.send({ t: 'invite-reply', accept: false });
  assert.equal((await T.ws.wait('invite-result')).ok, false);
  await sleep(250); assert.equal(T.ws.log.filter((m) => m.t === 'state').pop().hands.length, 1);
  S.ws.send({ t: 'unhand' }); await sleep(100);
});
test('звонок короче 2 минут не считается', async () => { const r = await lesson(T, S, 1); assert.equal(r.s.kind, 'short'); assert.equal(r.s.lessonId, null); assert.equal(r.s.rate, null); });
test('помощь (2–19 минут): бесплатно, не занятие, ученик ставит оценку 1–5', async () => {
  const r = await lesson(T, S, 10);
  assert.equal(r.s.kind, 'help'); assert.equal(r.s.cost, 0); assert.deepEqual(r.s.rate, { max: 5 }); assert.equal(r.t.rate, null);
  assert.equal((await api('POST', '/rate', { lessonId: r.s.lessonId, score: 6 }, S.token)).status, 400);
  assert.equal((await api('POST', '/rate', { lessonId: r.s.lessonId, score: 4 }, S.token)).status, 200);
  const me = await api('GET', '/me', null, T.token); assert.equal(me.user.rating, 8); assert.equal(me.user.lessons, 0);
});
test('занятие 20–59 минут: оценка 1–7 заменяет оценку за помощь, репетитор ставит ученику 1–5', async () => {
  const r = await lesson(T, S, 30);
  assert.equal(r.s.kind, 'lesson'); assert.equal(r.s.cost, 0); assert.deepEqual(r.s.rate, { max: 7 }); assert.deepEqual(r.t.rate, { max: 5 });
  assert.equal((await api('POST', '/rate', { lessonId: r.s.lessonId, score: 7 }, S.token)).status, 200);
  assert.equal((await api('POST', '/rate', { lessonId: r.s.lessonId, score: 7 }, S.token)).status, 409);
  assert.equal((await api('POST', '/rate', { lessonId: r.t.lessonId, score: 5 }, T.token)).status, 200);
  assert.equal((await api('GET', '/me', null, T.token)).user.rating, 10);
  const st = (await api('GET', '/me', null, S.token)).user; assert.equal(st.rating, 5); assert.equal(st.lessons, 1);
});
test('во время занятия рука опущена, второй репетитор пригласить не может', async () => {
  S2.ws.send({ t: 'hand', subject: 'Математика' }); await sleep(200);
  T.ws.send({ t: 'invite', to: S2.id }); await S2.ws.wait('invite'); S2.ws.send({ t: 'invite-reply', accept: true });
  await S2.ws.wait('call-start'); await T.ws.wait('call-start');
  const T3 = await mk('tutor'); await ws(T3);
  T3.ws.send({ t: 'invite', to: S2.id }); assert.equal((await T3.ws.wait('invite-result')).ok, false);
  await shift(3); S2.ws.send({ t: 'hangup' }); await S2.ws.wait('call-end'); await T.ws.wait('call-end');
});
test('сигналы звонка, доска и общий код пересылаются только собеседнику', async () => {
  S.ws.send({ t: 'hand', subject: 'Математика' }); await sleep(200);
  T.ws.send({ t: 'invite', to: S.id }); await S.ws.wait('invite'); S.ws.send({ t: 'invite-reply', accept: true });
  await S.ws.wait('call-start'); await T.ws.wait('call-start');
  T.ws.send({ t: 'board', data: { line: [1, 2, 3, 4] } }); assert.deepEqual((await S.ws.wait('board')).data, { line: [1, 2, 3, 4] });
  S.ws.send({ t: 'code', data: { text: 'print(1)' } }); assert.equal((await T.ws.wait('code')).data.text, 'print(1)');
  await sleep(150); assert.ok(!S2.ws.log.some((m) => m.t === 'board' || m.t === 'code'));
  await shift(1); T.ws.send({ t: 'hangup' }); await S.ws.wait('call-end'); await T.ws.wait('call-end');
});

/* ---------- деньги ---------- */
group('Оплата и защита от накрутки');
test('у нового репетитора первые 5 занятий бесплатные и цена ограничена потолком', async () => {
  const p = await api('POST', '/profile', { subjects: ['Математика'], price: 5000, about: 'Опыт 3 года' }, T.token);
  assert.equal(p.user.ownPrice, 0); // потолок пока 0: меньше 5 занятий
  const r = await lesson(T, S, 61); assert.equal(r.cs.free, true); assert.equal(r.s.cost, 0); assert.deepEqual(r.s.rate, { max: 10 });
  assert.equal((await api('POST', '/rate', { lessonId: r.s.lessonId, score: 10 }, S.token)).status, 200);
});
test('не больше 4 засчитанных занятий одной пары в сутки', async () => {
  const a = await lesson(T, S, 20), b = await lesson(T, S, 20); assert.equal(a.s.counted, true); assert.equal(b.s.counted, true);
  const c = await lesson(T, S, 20); assert.equal(c.s.counted, false); assert.equal(c.t.rate, null);
  assert.equal((await api('GET', '/me', null, T.token)).user.lessons, 4);
});
test('занятие от часа оплачивается поминутно: ученик платит, репетитор получает за вычетом 2%', async () => {
  await shift(25 * 60);
  for (const st of [S2]) { const r = await lesson(T, st, 25); assert.equal(r.s.counted, true); }
  const me = (await api('GET', '/me', null, T.token)).user; assert.equal(me.lessons, 5); assert.equal(me.free, false); assert.equal(me.ceiling, 2000);
  assert.equal((await api('POST', '/profile', { subjects: ['Математика'], price: 900 }, T.token)).user.ownPrice, 900);
  const r = await lesson(T, S, 90);
  assert.equal(r.cs.price, 900); assert.equal(r.s.cost, 1350);
  assert.equal((await api('GET', '/me', null, S.token)).user.balance, 5000 - 1350);
  assert.equal((await api('GET', '/me', null, T.token)).user.balance, 1350 - 27);
  const w = await api('GET', '/wallet', null, T.token); assert.equal(w.txs[0].amount, 1323);
});
test('кошелёк: пополнение до 10 000 ₽ за раз, вывод не больше баланса', async () => {
  assert.equal((await api('POST', '/wallet/topup', { amount: 10001 }, S.token)).status, 400);
  assert.equal((await api('POST', '/wallet/topup', { amount: 10000 }, S.token)).balance, 13650);
  assert.equal((await api('POST', '/wallet/withdraw', { amount: 99999 }, T.token)).status, 400);
  assert.equal((await api('POST', '/wallet/withdraw', { amount: 1000 }, T.token)).balance, 323);
  assert.equal((await api('POST', '/wallet/topup', { amount: 100 }, T.token)).status, 403);
});

/* ---------- избранное, чат, заявки ---------- */
group('Избранное, чат и заявки');
test('чат открывается только при взаимном избранном', async () => {
  await api('POST', '/favorite', { id: T.id, on: true }, S.token);
  assert.equal((await api('GET', `/messages?with=${T.id}`, null, S.token)).status, 403);
  const f = await api('POST', '/favorite', { id: S.id, on: true }, T.token); assert.equal(f.mutual, true);
  S.ws.send({ t: 'chat', to: T.id, text: 'Здравствуйте' });
  assert.equal((await T.ws.wait('chat')).msg.text, 'Здравствуйте');
  S2.ws.drop('chat'); S2.ws.send({ t: 'chat', to: T.id, text: 'спам' }); await sleep(200);
  const m = await api('GET', `/messages?with=${S.id}`, null, T.token); assert.equal(m.messages.length, 1);
  assert.equal((await api('GET', '/friends', null, T.token)).friends.length, 1);
});
test('заявку отправляет только репетитор, цена не выше потолка', async () => {
  const at = (await shift(0)).now + 3600_000;
  assert.equal((await api('POST', '/offer', { studentId: T.id, at, minutes: 60, price: 0 }, S.token)).status, 403);
  assert.equal((await api('POST', '/offer', { studentId: S2.id, at, minutes: 60, price: 0 }, T.token)).status, 403);
  assert.equal((await api('POST', '/offer', { studentId: S.id, at, minutes: 60, price: 2500 }, T.token)).status, 400);
  const o = await api('POST', '/offer', { studentId: S.id, at, minutes: 60, price: 600, subject: 'Математика' }, T.token);
  assert.equal(o.status, 200); assert.equal(o.offer.status, 'open');
  assert.equal((await api('POST', '/offer/reply', { id: o.offer.id, accept: true }, S.token)).status, 'accepted');
  S.offerId = o.offer.id; S.offerAt = at;
});
test('напоминание приходит за 10 минут; начать по заявке может любая сторона, цена — из заявки', async () => {
  S.ws.drop('remind'); await shift(51);
  assert.equal((await S.ws.wait('remind')).offer.id, S.offerId); await T.ws.wait('remind');
  S.ws.send({ t: 'invite', to: T.id, offerId: S.offerId });
  const inv = await T.ws.wait('invite'); assert.equal(inv.offer.price, 600);
  T.ws.send({ t: 'invite-reply', accept: true });
  const cs = await S.ws.wait('call-start'); await T.ws.wait('call-start'); assert.equal(cs.price, 600);
  await shift(60); S.ws.send({ t: 'hangup' });
  assert.equal((await S.ws.wait('call-end')).summary.cost, 600); await T.ws.wait('call-end');
});
test('заявка без ответа сгорает через 24 часа', async () => {
  const at = (await shift(0)).now + 30 * 3600_000;
  const o = await api('POST', '/offer', { studentId: S.id, at, minutes: 30, price: 0 }, T.token);
  await shift(24 * 60 + 1);
  assert.equal((await api('POST', '/offer/reply', { id: o.offer.id, accept: true }, S.token)).status, 409);
});

/* ---------- практика ---------- */
group('Практика: работы платформы');
const WORKS = require('../works');
test('в банке 23 работы: по 5 задач и 7 баллов, классы 7–11', () => {
  assert.equal(WORKS.list.length, 23);
  const per = {}; for (const w of WORKS.list) per[w.grade] = (per[w.grade] || 0) + 1;
  assert.deepEqual(per, { 7: 4, 8: 4, 9: 5, 10: 5, 11: 5 });
  for (const w of WORKS.list) for (const t of w.tasks) { assert.ok(t.q && t.a && t.sol, w.id); assert.ok(R.isCorrect(t.a, String(t.a).split('|')[0]), w.id); }
});
let W;
test('ученик видит только работы своего класса; чужую начать нельзя', async () => {
  const l = await api('GET', '/works', null, S.token);
  assert.ok(l.works.length >= 1); assert.ok(l.works.every((w) => w.grade === 10));
  W = l.works[0];
  const other = WORKS.list.find((w) => w.grade !== 10);
  if (other) assert.equal((await api('POST', '/work/start', { id: other.id }, S.token)).status, 403);
  assert.equal((await api('POST', '/work/start', { id: W.id }, T.token)).status, 403);
});
test('до сдачи ответы и разборы не отдаются; ответы сохраняются на сервере', async () => {
  const a = await api('POST', '/work/start', { id: W.id }, S.token);
  assert.equal(a.tasks.length, 5); assert.ok(a.tasks.every((t) => t.answer === undefined && t.sol === undefined));
  assert.equal(a.deadline - a.started, 90 * 60_000);
  await api('POST', '/work/save', { id: W.id, answers: ['черновик'] }, S.token);
  assert.deepEqual((await api('GET', `/work?id=${W.id}`, null, S.token)).answers, ['черновик']);
});
test('сдача: сервер проверяет ответы, балл идёт в рейтинг, вторая попытка невозможна', async () => {
  const w = WORKS.byId.get(W.id);
  const answers = w.tasks.map((t, i) => (i === 4 ? 'неверно' : String(t.a).split('|')[0]));
  const before = (await api('GET', '/me', null, S.token)).user.personal;
  const r = await api('POST', '/work/submit', { id: W.id, answers }, S.token);
  assert.equal(r.score, 7 - w.tasks[4].pts); assert.equal(r.tasks[4].ok, false); assert.ok(r.tasks[0].sol);
  const again = await api('POST', '/work/start', { id: W.id }, S.token); assert.equal(again.score, r.score); assert.ok(again.submitted);
  const recs = (await api('GET', `/profile?id=${S.id}`, null, S.token)).portfolio.works; assert.equal(recs.length, 1); assert.equal(recs[0].score, r.score);
  assert.equal(before, 5); assert.equal((await api('GET', '/me', null, S.token)).user.personal, R.studentRating([5, r.score])); // запись о работе вошла в рейтинг
});
test('по истечении времени работа сдаётся сама, даже если страница закрыта', async () => {
  const a = await api('POST', '/work/start', { id: W.id }, S2.token);
  const w = WORKS.byId.get(W.id);
  await api('POST', '/work/save', { id: W.id, answers: [String(w.tasks[0].a).split('|')[0]] }, S2.token);
  await shift(91);
  const r = await api('GET', `/work?id=${W.id}`, null, S2.token);
  assert.ok(r.submitted); assert.equal(r.score, w.tasks[0].pts);
  assert.equal((await api('POST', '/work/save', { id: W.id, answers: ['поздно'] }, S2.token)).submitted, r.submitted);
});

/* ---------- работы репетитора и портфолио ---------- */
group('Работы репетитора и портфолио');
let TW;
test('работу создаёт репетитор для ученика из взаимного избранного, от 20 минут до 5 часов', async () => {
  assert.equal((await api('POST', '/twork/create', { studentId: S2.id, title: 'Работа', body: 'Задание 1', minutes: 30 }, T.token)).status, 403);
  assert.equal((await api('POST', '/twork/create', { studentId: S.id, title: 'Работа', body: 'Задание 1', minutes: 10 }, T.token)).status, 400);
  const r = await api('POST', '/twork/create', { studentId: S.id, title: 'Проценты', body: 'Решите три задачи…', minutes: 30 }, T.token);
  assert.equal(r.status, 200); TW = r.id;
});
test('ученик видит задания после старта, сдаёт ответ с картинкой; репетитор ставит 1–5', async () => {
  const before = (await api('GET', '/tworks', null, S.token)).works[0]; assert.equal(before.body, undefined);
  const st = await api('POST', '/twork/start', { id: TW }, S.token); assert.ok(st.work.body);
  assert.equal((await api('POST', '/twork/submit', { id: TW, answer: 'Ответ', attach: 'data:text/html;base64,AAAA' }, S.token)).status, 400);
  assert.equal((await api('POST', '/twork/submit', { id: TW, answer: 'Ответ 42', attach: 'data:image/png;base64,iVBORw0KGgo=' }, S.token)).status, 200);
  assert.equal((await api('POST', '/twork/grade', { id: TW, grade: 6 }, T.token)).status, 400);
  const ratingBefore = (await api('GET', '/me', null, S.token)).user.personal;
  assert.equal((await api('POST', '/twork/grade', { id: TW, grade: 5 }, T.token)).status, 200);
  assert.equal((await api('GET', '/me', null, S.token)).user.personal, ratingBefore); // в рейтинг не входит
});
test('у ученика не больше 5 работ от репетиторов', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await api('POST', '/twork/create', { studentId: S.id, title: 'Работа ' + i, body: 'Задание', minutes: 20 }, T.token)).status, 200);
  assert.equal((await api('POST', '/twork/create', { studentId: S.id, title: 'Шестая', body: 'Задание', minutes: 20 }, T.token)).status, 409);
});
test('портфолио видят репетиторы и сам ученик, другим ученикам оно закрыто', async () => {
  const mine = await api('GET', `/profile?id=${S.id}`, null, S.token);
  assert.equal(mine.portfolio.works.length, 1); assert.equal(mine.portfolio.tutorWorks.length, 1); assert.ok(mine.portfolio.badges.includes('Первая работа'));
  assert.ok((await api('GET', `/profile?id=${S.id}`, null, T2.token)).portfolio);
  assert.equal((await api('GET', `/profile?id=${S.id}`, null, S2.token)).portfolio, undefined);
  assert.equal((await api('GET', `/profile?id=${S.id}`)).portfolio, undefined);
});

/* ---------- админ и безопасность ---------- */
group('Админ и безопасность');
let A;
test('админ входит паролем из файла; обычному пользователю админка закрыта', async () => {
  const pw = /admin1\s+(\S+)/.exec(fs.readFileSync(path.join(dir, 'admins.txt'), 'utf8'))[1];
  A = await api('POST', '/login', { login: 'admin1', password: pw }); assert.equal(A.status, 200); assert.equal(A.user.admin, true);
  assert.equal((await api('GET', '/admin/users', null, S.token)).status, 403);
  assert.ok((await api('GET', '/admin/users', null, A.token)).users.length > 5);
});
test('админ меняет класс, сбрасывает пароль, блокирует и удаляет', async () => {
  const v = await mk('student', { grade: 7 });
  assert.equal((await api('POST', '/admin/user', { id: v.id, action: 'grade', value: 8 }, A.token)).status, 200);
  assert.equal((await api('GET', '/me', null, v.token)).user.grade, 8);
  const rp = await api('POST', '/admin/user', { id: v.id, action: 'resetpw' }, A.token);
  assert.equal((await api('GET', '/me', null, v.token)).status, 401);
  const again = await api('POST', '/login', { login: v.login, password: rp.password }); assert.equal(again.status, 200);
  await api('POST', '/admin/user', { id: v.id, action: 'block' }, A.token);
  assert.equal((await api('GET', '/me', null, again.token)).status, 401);
  assert.equal((await api('POST', '/login', { login: v.login, password: rp.password })).status, 403);
  assert.equal((await api('POST', '/admin/user', { id: v.id, action: 'delete' }, A.token)).status, 200);
  assert.equal((await api('GET', `/profile?id=${v.id}`)).status, 404);
});
test('выпускнику работы платформы недоступны', async () => {
  const v = await mk('student', { grade: 11 });
  await api('POST', '/admin/user', { id: v.id, action: 'grade', value: 12 }, A.token);
  const l = await api('GET', '/works', null, v.token); assert.equal(l.graduate, true); assert.equal(l.works.length, 0);
});
test('вкладка «Открытый код» отдаёт исходники и не выпускает за пределы проекта', async () => {
  const l = await api('GET', '/admin/source', null, A.token); assert.ok(l.files.includes('server.js'));
  assert.ok((await api('GET', '/admin/source?file=server.js', null, A.token)).text.includes('РукUP'));
  assert.equal((await api('GET', '/admin/source?file=../../etc/passwd', null, A.token)).status, 404);
  assert.equal((await api('GET', '/admin/source?file=data/admins.txt', null, A.token)).status, 404);
});
test('статика: выход из папки и нулевой байт отклоняются, заголовки защиты на месте', async () => {
  assert.equal((await fetch(BASE + '/..%2f..%2fserver.js')).status, 404);
  assert.equal((await fetch(BASE + '/%00')).status, 404);
  const r = await fetch(BASE + '/'); assert.equal(r.status, 200);
  assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'self'")); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});
test('пароли хранятся только в виде хешей scrypt', () => {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(path.join(dir, 'rukup.db'), { readOnly: true });
  const rows = d.prepare('SELECT pass FROM users').all(); d.close();
  assert.ok(rows.length > 5 && rows.every((r) => /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(r.pass)));
});

(async () => {
  await sleep(400);
  for (const t of tests) {
    t.g.total++;
    try { await t.fn(); t.g.ok++; console.log('  ✓ ' + t.name); }
    catch (e) { t.g.fails.push(t.name); console.log('  ✗ ' + t.name + '\n      ' + String(e && e.message).split('\n')[0]); }
  }
  const total = groups.reduce((s, g) => s + g.total, 0), ok = groups.reduce((s, g) => s + g.ok, 0);
  console.log(`\nПройдено ${ok} из ${total}`);
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ groups: groups.map((g) => ({ name: g.name, total: g.total, ok: g.ok })), total, ok }, null, 1));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка */ }
  process.exit(ok === total ? 0 : 1);
})();
