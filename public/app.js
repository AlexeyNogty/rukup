'use strict';
// «РукUP» — интерфейс. Одностраничное приложение без сторонних библиотек.
const $root = document.getElementById('root');
const S = { me: null, cfg: null, token: null, tab: 'practice', mob: 'center', ws: null, wsOk: false, hand: null, hands: [], tutors: [], online: 0, tutorSubject: '', call: null, invite: null, waiting: null, chatWith: null, discSubject: 'Математика' };
try { S.token = localStorage.getItem('rukup-token'); } catch { /* хранилище недоступно */ }

async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({ error: 'Сервер не отвечает' }));
  if (!r.ok) { if (r.status === 401 && S.me) logout(true); throw new Error(j.error || 'Ошибка'); }
  return j;
}
function toast(text, kind) {
  const el = h('div', { class: 'toast glass' + (kind ? ' ' + kind : '') }, text);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}
const tryDo = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, 'bad'); return undefined; } };
const stars = (r) => (r == null ? 'нет оценок' : '★ ' + String(r).replace('.', ','));
const money = (v) => `${Number(v).toLocaleString('ru-RU')} ₽`;
const fmtTime = (ts) => new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return (hh ? hh + ':' : '') + String(mm).padStart(hh ? 2 : 1, '0') + ':' + String(ss).padStart(2, '0'); };
const plural = (n, a, b, c) => { const d = n % 10, t = n % 100; return d === 1 && t !== 11 ? a : d >= 2 && d <= 4 && (t < 12 || t > 14) ? b : c; };
const kindName = { short: 'Короткий звонок', help: 'Помощь', lesson: 'Занятие' };

/* ---------- окна ---------- */
function modal(content, opts = {}) {
  const ov = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' });
  const box = h('div', { class: 'modal glass' + (opts.wide ? ' wide' : '') }, content);
  ov.append(box);
  const close = () => { ov.remove(); if (opts.onClose) opts.onClose(); };
  if (!opts.sticky) ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  document.body.append(ov);
  return { close, box };
}
function confirmBox(title, text, okLabel = 'Да') {
  return new Promise((res) => { const m = modal([h('h2', {}, title), h('p', { class: 'muted' }, text), h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => { m.close(); res(true); } }, okLabel), h('button', { onclick: () => { m.close(); res(false); } }, 'Отмена'))], { sticky: true }); });
}

/* ---------- связь с сервером ---------- */
const Hub = { send(o) { if (S.ws && S.ws.readyState === 1) { S.ws.send(JSON.stringify(o)); return true; } return false; }, toast };
let wsRetry = 1000, tutorsTimer = null;
function connect() {
  if (!S.token || !S.me) return;
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: S.token }));
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onWs(m); };
  ws.onclose = (ev) => {
    S.wsOk = false;
    if (S.ws !== ws) return;
    if (S.call) { Call.reset(); S.call = null; toast('Связь с сервером прервалась, занятие завершено', 'bad'); render(); }
    if (ev.code === 4001) return logout(true);
    setTimeout(connect, wsRetry); wsRetry = Math.min(wsRetry * 2, 15000);
  };
}
setInterval(() => Hub.send({ t: 'ping' }), 25000);
function refreshTutors() { clearTimeout(tutorsTimer); tutorsTimer = setTimeout(async () => { try { const r = await api('GET', '/tutors' + (S.tutorSubject ? '?subject=' + encodeURIComponent(S.tutorSubject) : '')); S.tutors = r.tutors; renderRight(); } catch { /* не критично */ } }, 200); }
function onWs(m) {
  switch (m.t) {
    case 'ready': S.wsOk = true; wsRetry = 1000; if (S.hand && S.me.role === 'student') Hub.send({ t: 'hand', subject: S.hand.subject, topic: S.hand.topic }); break;
    case 'state': S.online = m.online; if (S.me.role === 'student') S.hand = m.hand || null; if (S.me.role === 'tutor') S.hands = m.hands || []; renderLeft(); renderFab(); refreshTutors(); break;
    case 'invite': showInvite(m); break;
    case 'invite-cancel': if (S.invite) { S.invite.close(); S.invite = null; toast('Приглашение отменено'); } break;
    case 'invite-sent': showWaiting(m.name); break;
    case 'invite-result': if (S.waiting) { S.waiting.close(); S.waiting = null; } if (!m.ok) toast(m.reason || 'Занятие не началось', 'bad'); break;
    case 'call-start': startCallUi(m); break;
    case 'call-end': endCallUi(m); break;
    case 'rtc': Call.handle(m); break;
    case 'callmsg': if (S.call) { S.call.msgs.push({ me: false, text: String(m.data && m.data.text || '') }); renderCallChat(); } break;
    case 'board': if (S.call) S.call.board.apply(m.data); break;
    case 'code': if (S.call) S.call.code.apply(m.data); break;
    case 'chat': onChat(m); break;
    case 'fav': if (m.mutual) toast(`${m.name} и вы теперь в избранном друг у друга — открыт чат`, 'ok'); else if (m.on) toast(`${m.name} добавил(а) вас в избранное`); if (S.tab === 'chat') renderCenter(); refreshTutors(); break;
    case 'offer': if (S.tab === 'chat') renderCenter(); break;
    case 'remind': toast(`Через 10 минут занятие с пользователем ${m.peer}. Откройте чат и нажмите «Начать».`, 'ok'); break;
    case 'twork': toast(m.graded ? `Работа «${m.title}» оценена: ${m.graded}` : m.submitted ? `${m.from} сдал(а) работу «${m.title}»` : m.title ? `${m.from} выдал(а) вам работу «${m.title}»` : 'Работа обновлена'); if (S.tab === 'practice' && !S.work) renderCenter(); break;
    case 'work-done': if (S.work && S.work.id === m.workId && !S.work.done) openWork(m.workId); break;
  }
}

/* ---------- вход и регистрация ---------- */
function authScreen(mode = 'login') {
  document.body.classList.remove('in');
  const f = { login: h('input', { autocomplete: 'username', placeholder: 'Например: timur_2010' }), name: h('input', { placeholder: 'Как вас увидят другие', maxlength: 40 }), p1: h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password' }), p2: h('input', { type: 'password', autocomplete: 'new-password' }) };
  const err = h('div', { class: 'bad small', role: 'alert' });
  const submit = async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      const r = mode === 'login' ? await api('POST', '/login', { login: f.login.value.trim(), password: f.p1.value }) : await api('POST', '/register', { login: f.login.value.trim(), name: f.name.value.trim(), password: f.p1.value, password2: f.p2.value });
      S.token = r.token; try { localStorage.setItem('rukup-token', r.token); } catch { /* войдём без запоминания */ }
      S.me = r.user; enter();
    } catch (ex) { err.textContent = ex.message; }
  };
  $root.replaceChildren(h('div', { class: 'auth' }, h('form', { class: 'modal glass', onsubmit: submit },
    h('div', { class: 'logo', style: 'font-size:30px' }, '✋ Рук', h('b', {}, 'UP')),
    h('p', { class: 'muted' }, 'Подними руку — и репетитор поможет. Практика, дисциплины и занятия в одном месте.'),
    h('div', { class: 'tabs' }, h('button', { type: 'button', class: mode === 'login' ? 'on' : '', onclick: () => authScreen('login') }, 'Вход'), h('button', { type: 'button', class: mode === 'reg' ? 'on' : '', onclick: () => authScreen('reg') }, 'Регистрация')),
    h('label', {}, 'Логин', f.login), mode === 'reg' ? h('label', {}, 'Видимое имя (фамилию писать не нужно)', f.name) : null,
    h('label', {}, 'Пароль', f.p1), mode === 'reg' ? h('label', {}, 'Пароль ещё раз', f.p2) : null, err,
    h('button', { class: 'primary' }, mode === 'login' ? 'Войти' : 'Зарегистрироваться'),
    h('button', { type: 'button', onclick: guestScreen }, 'Посмотреть пользователей без входа'))));
}
async function guestScreen() {
  const list = h('div', { class: 'grid' });
  $root.replaceChildren(h('div', { class: 'app' }, h('div', { class: 'top glass' }, h('div', { class: 'logo' }, '✋ Рук', h('b', {}, 'UP')), h('span', { class: 'sp' }), h('button', { class: 'primary', onclick: () => authScreen('login') }, 'Войти')),
    h('div', { class: 'center glass' }, h('div', { class: 'scroll' }, h('h2', {}, 'Пользователи платформы'), h('p', { class: 'muted' }, 'Гость видит каталог. Чтобы поднять руку или проводить занятия, войдите.'), list))));
  const r = await tryDo(() => api('GET', '/users'));
  if (r) list.append(...r.users.map((u) => userCard(u, null)));
}
function roleScreen() {
  let role = null; const box = h('div', { class: 'col' }), err = h('div', { class: 'bad small', role: 'alert' });
  const grade = h('select', {}, [7, 8, 9, 10, 11].map((g) => h('option', { value: g }, g + ' класс')));
  const subj = h('div', { class: 'subj' }, S.cfg.subjects.map((s) => h('label', {}, h('input', { type: 'checkbox', value: s }), s)));
  const pick = (r) => { role = r; btns.forEach((b, i) => b.classList.toggle('on', (i === 0) === (r === 'student'))); box.replaceChildren(...(r === 'student' ? [h('label', {}, 'Ваш класс', grade), h('p', { class: 'small warn' }, 'Класс потом нельзя изменить самому: он сам вырастет 1 сентября. Исправить ошибку может только админ.')] : [h('p', { class: 'small muted' }, 'Отметьте предметы, по которым готовы заниматься. Руки учеников вы увидите только по этим предметам.'), subj])); };
  const btns = [h('button', { type: 'button', onclick: () => pick('student') }, h('b', {}, '🎒 Я ученик'), h('span', { class: 'small muted' }, 'Поднимаю руку и учусь')), h('button', { type: 'button', onclick: () => pick('tutor') }, h('b', {}, '🎓 Я репетитор'), h('span', { class: 'small muted' }, 'Помогаю ученикам'))];
  $root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'modal glass' }, h('h2', {}, `Здравствуйте, ${S.me.name}!`), h('p', { class: 'muted' }, 'Выберите роль. Изменить её потом нельзя.'), h('div', { class: 'rolepick' }, btns), box, err,
    h('button', { class: 'primary', onclick: async () => { err.textContent = ''; if (!role) { err.textContent = 'Выберите роль'; return; } try { const r = await api('POST', '/role', role === 'student' ? { role, grade: Number(grade.value) } : { role, subjects: [...subj.querySelectorAll('input:checked')].map((i) => i.value) }); S.me = r.user; enter(); } catch (e) { err.textContent = e.message; } } }, 'Продолжить'),
    h('button', { onclick: () => logout() }, 'Выйти'))));
}
function logout(silent) {
  if (!silent && S.token) api('POST', '/logout').catch(() => {});
  try { localStorage.removeItem('rukup-token'); } catch { /* нечего удалять */ }
  const ws = S.ws; Object.assign(S, { me: null, token: null, ws: null, hand: null, hands: [], call: null, work: null });
  if (ws) try { ws.close(); } catch { /* уже закрыт */ }
  Call.reset(); authScreen('login');
}
async function boot() {
  S.cfg = await api('GET', '/config').catch(() => null);
  if (!S.cfg) { $root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'modal glass' }, h('h2', {}, 'Сервер недоступен'), h('button', { onclick: () => location.reload() }, 'Повторить')))); return; }
  if (S.token) { try { S.me = (await api('GET', '/me')).user; } catch { S.token = null; } }
  if (S.me) enter(); else authScreen('login');
}
function enter() {
  if (!S.me.role) return roleScreen();
  S.tab = S.me.role === 'admin' ? 'admin' : S.me.role === 'tutor' ? 'profile' : 'practice';
  buildShell(); connect(); refreshTutors();
}
async function reloadMe() { const r = await tryDo(() => api('GET', '/me')); if (r) { S.me = r.user; renderTop(); } }

/* ---------- каркас ---------- */
const E = {};
const TABS = [['practice', '📝', 'Практика'], ['disc', '🧰', 'Дисциплины'], ['sites', '🌐', 'Сайты'], ['chat', '💬', 'Чат'], ['leaders', '🏆', 'Лидеры'], ['users', '👥', 'Пользователи'], ['profile', '👤', 'Профиль']];
function buildShell() {
  E.nav = h('nav', { class: 'nav', 'aria-label': 'Разделы' }); E.who = h('div', { class: 'row who' }); E.left = h('aside', { class: 'side left glass' }); E.center = h('main', { class: 'center glass' }); E.right = h('aside', { class: 'side right glass' });
  E.shell = h('div', { class: 'shell' }, E.left, E.center, E.right); E.mnav = h('nav', { class: 'mnav glass', 'aria-label': 'Меню' }); E.fab = h('div', {});
  $root.replaceChildren(h('div', { class: 'app' }, h('header', { class: 'top glass' }, h('div', { class: 'logo' }, '✋ Рук', h('b', {}, 'UP')), E.nav, E.who), E.shell, E.mnav), E.fab);
  render();
}
function render() { renderTop(); renderLeft(); renderCenter(); renderRight(); renderFab(); }
function setTab(t) { if (S.work && S.work.stop) S.work.stop(); S.tab = t; S.mob = 'center'; S.work = null; render(); }
function tabsList() { const t = TABS.slice(); if (S.call) t.unshift(['lesson', '🎧', 'Занятие']); if (S.me.admin) t.push(['admin', '🛠', 'Открытый код']); return t; }
function renderTop() {
  if (!E.nav) return;
  E.nav.replaceChildren(...tabsList().map(([id, , title]) => h('button', { class: (S.tab === id ? 'on ' : '') + (id === 'admin' ? 'adm' : ''), onclick: () => setTab(id) }, title)));
  E.who.replaceChildren(S.me.role !== 'admin' ? h('span', { class: 'chip', title: 'Учебный кошелёк' }, money(S.me.balance)) : '', h('span', { class: 'chip' + (S.me.admin ? ' admin' : '') }, S.me.name));
  const leftLabel = S.me.role === 'tutor' ? ['left', '✋', `Руки${S.hands.length ? ' ' + S.hands.length : ''}`] : S.hand ? ['left', '✋', 'Моя рука'] : null;
  const items = [...(leftLabel ? [leftLabel] : []), ['right', S.call ? '🎧' : '🎓', S.call ? 'Звонок' : 'Репетиторы'], ...tabsList()];
  E.mnav.replaceChildren(...items.map(([id, ic, title]) => h('button', { class: (id === 'left' || id === 'right' ? S.mob === id : S.mob === 'center' && S.tab === id) ? 'on' : '', onclick: () => { if (id === 'left' || id === 'right') { S.mob = id; render(); } else setTab(id); } }, h('span', {}, ic), title)));
  E.shell.dataset.m = S.mob;
}

/* ---------- левая панель: рука ученика / руки учеников ---------- */
function renderLeft() {
  if (!E.left) return;
  const me = S.me;
  const show = me.role === 'tutor' || (me.role === 'student' && S.hand);
  E.shell.classList.toggle('has-left', !!show);
  E.left.hidden = !show;
  if (!show) { if (S.mob === 'left') { S.mob = 'center'; E.shell.dataset.m = 'center'; } return; }
  if (me.role === 'student') {
    const hd = S.hand;
    E.left.replaceChildren(h('div', { class: 'head' }, h('h3', {}, '✋ Рука поднята')), h('div', { class: 'scroll' },
      h('div', { class: 'card' }, h('div', { class: 'name' }, hd.subject), hd.topic ? h('div', { class: 'small' }, hd.topic) : h('div', { class: 'small muted' }, 'Тема не указана')),
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Поднято рук по предмету'), h('div', { class: 'stat' }, hd.hands)),
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Свободных репетиторов'), h('div', { class: 'stat' }, hd.tutors)),
      h('p', { class: 'small muted' }, hd.tutors ? 'Ждите: репетитор выберет вас и пригласит на занятие. Окно с приглашением появится по центру экрана.' : 'Сейчас по этому предмету нет свободных репетиторов. Рука останется поднятой, пока вы её не опустите.'),
      h('button', { class: 'danger', onclick: () => Hub.send({ t: 'unhand' }) }, 'Опустить руку')));
  } else {
    E.left.replaceChildren(h('div', { class: 'head' }, h('h3', {}, '✋ Руки учеников'), h('span', { class: 'sp' }), h('span', { class: 'chip' }, S.hands.length)), h('div', { class: 'scroll' },
      S.call ? h('div', { class: 'empty' }, 'Вы на занятии. Новые руки появятся после его завершения.') : S.hands.length ? S.hands.map((x) => h('div', { class: 'card click', tabindex: 0, role: 'button', onclick: () => inviteDialog(x), onkeydown: (e) => { if (e.key === 'Enter') inviteDialog(x); } },
        h('div', { class: 'row' }, h('span', { class: 'name grow' }, x.name), h('span', { class: 'chip' }, x.gradeLabel)),
        h('div', { class: 'chips' }, h('span', { class: 'chip on' }, x.subject), h('span', { class: 'chip' }, stars(x.rating)), h('span', { class: 'chip' }, `${x.lessons} ${plural(x.lessons, 'занятие', 'занятия', 'занятий')}`)),
        x.topic ? h('div', { class: 'small' }, x.topic) : null)) : h('div', { class: 'empty' }, 'Пока никто не поднял руку по вашим предметам: ' + S.me.subjects.join(', '))));
  }
  renderTop();
}
function inviteDialog(x) {
  const comment = h('input', { placeholder: 'Комментарий ученику (необязательно)', maxlength: 200 });
  const m = modal([h('h2', {}, 'Начать занятие?'), h('p', {}, `${x.name}, ${x.gradeLabel}. Предмет: ${x.subject}.`), x.topic ? h('p', { class: 'muted' }, 'Тема: ' + x.topic) : null,
    h('button', { class: 'sm', onclick: () => { m.close(); showProfile(x.id); } }, 'Открыть профиль и портфолио'), comment,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => { Hub.send({ t: 'invite', to: x.id, comment: comment.value }); m.close(); } }, 'Пригласить'), h('button', { onclick: () => m.close() }, 'Отмена'))]);
}
function showWaiting(name) {
  if (S.waiting) S.waiting.close();
  S.waiting = modal([h('h2', {}, 'Ждём ответа'), h('p', { class: 'muted' }, `${name} видит приглашение. На ответ даётся 60 секунд.`), h('button', { onclick: () => { Hub.send({ t: 'invite-cancel' }); S.waiting.close(); S.waiting = null; } }, 'Отменить приглашение')], { sticky: true });
}
function showInvite(m) {
  if (S.invite) S.invite.close();
  const left = h('b', {}, '60');
  const t0 = Date.now(), tm = setInterval(() => { left.textContent = Math.max(0, Math.ceil((m.ms - (Date.now() - t0)) / 1000)); }, 500);
  const f = m.from, answer = (accept) => { Hub.send({ t: 'invite-reply', accept }); S.invite.close(); S.invite = null; };
  S.invite = modal([h('h2', {}, f.role === 'tutor' ? 'Репетитор готов помочь' : 'Ученик готов начать занятие'), h('div', { class: 'card' }, h('div', { class: 'name', style: 'font-size:18px' }, f.name),
    f.role === 'tutor' ? h('div', { class: 'chips' }, h('span', { class: 'chip' }, stars(f.rating)), h('span', { class: 'chip' }, `${f.lessons} ${plural(f.lessons, 'занятие', 'занятия', 'занятий')}`), h('span', { class: 'chip on' }, m.subject)) : h('div', { class: 'chips' }, h('span', { class: 'chip' }, f.gradeLabel), h('span', { class: 'chip on' }, m.subject)),
    m.comment ? h('div', {}, '«' + m.comment + '»') : null),
  h('p', { class: 'small muted' }, m.offer ? `Занятие по заявке: ${m.offer.minutes} мин, ${m.offer.price ? money(m.offer.price) + ' в час' : 'бесплатно'}.` : 'До 20 минут — помощь, от 20 минут — занятие. Короче часа всегда бесплатно.'),
  h('p', { class: 'small' }, 'Осталось секунд: ', left),
  h('div', { class: 'row' }, h('button', { class: 'good', onclick: () => answer(true) }, 'Принять'), h('button', { class: 'danger', onclick: () => answer(false) }, 'Отказаться'))], { sticky: true, onClose: () => clearInterval(tm) });
}
function renderFab() {
  if (!E.fab) return;
  const show = S.me.role === 'student' && !S.hand && !S.call && !S.work;
  E.fab.replaceChildren(show ? h('button', { class: 'primary hand-fab', onclick: handDialog }, '✋ Поднять руку') : '');
}
function handDialog() {
  const subj = h('select', {}, S.cfg.subjects.map((s) => h('option', {}, s))), topic = h('input', { placeholder: 'Например: не понимаю задачу на проценты', maxlength: 120 });
  try { const last = localStorage.getItem('rukup-subject'); if (last) subj.value = last; } catch { /* не запоминали */ }
  const m = modal([h('h2', {}, 'Поднять руку'), h('label', {}, 'Предмет', subj), h('label', {}, 'Тема или вопрос (можно не писать)', topic), h('p', { class: 'small muted' }, 'Руку увидят репетиторы этого предмета. Она останется поднятой, пока вы её не опустите.'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => { if (!Hub.send({ t: 'hand', subject: subj.value, topic: topic.value })) return toast('Нет связи с сервером', 'bad'); try { localStorage.setItem('rukup-subject', subj.value); } catch { /* не запомнили */ } m.close(); } }, 'Поднять'), h('button', { onclick: () => m.close() }, 'Отмена'))]);
}

/* ---------- правая панель: репетиторы онлайн или звонок ---------- */
function userCard(u, onclick) {
  return h('div', { class: 'card' + (onclick ? ' click' : ''), tabindex: onclick ? 0 : null, role: onclick ? 'button' : null, onclick, onkeydown: onclick ? (e) => { if (e.key === 'Enter') onclick(); } : null },
    h('div', { class: 'row' }, h('span', { class: 'dot ' + (u.busy ? 'busy' : u.online ? 'on' : ''), title: u.busy ? 'На занятии' : u.online ? 'В сети' : 'Не в сети' }), h('span', { class: 'name grow' }, u.name), u.admin ? h('span', { class: 'chip admin' }, 'админ') : null, u.mutual ? h('span', { class: 'chip on' }, 'друг') : u.fav ? h('span', { class: 'chip' }, '★') : null),
    u.role === 'tutor' ? [h('div', { class: 'chips' }, h('span', { class: 'chip' }, stars(u.rating)), h('span', { class: 'chip' }, `${u.lessons} ${plural(u.lessons, 'занятие', 'занятия', 'занятий')}`), h('span', { class: 'chip' }, u.free ? 'бесплатно' : u.price ? money(u.price) + '/ч' : 'бесплатно')), h('div', { class: 'small muted' }, u.subjects.join(', '))]
      : u.role === 'student' ? h('div', { class: 'chips' }, h('span', { class: 'chip' }, 'ученик'), h('span', { class: 'chip' }, u.gradeLabel), h('span', { class: 'chip' }, stars(u.rating))) : null);
}
function renderRight() {
  if (!E.right) return;
  if (S.call) return renderCallPanel();
  const sel = h('select', { style: 'width:auto;max-width:150px', 'aria-label': 'Предмет', onchange: (e) => { S.tutorSubject = e.target.value; refreshTutors(); } }, h('option', { value: '' }, 'Все предметы'), S.cfg.subjects.map((s) => h('option', { value: s, selected: s === S.tutorSubject }, s)));
  E.right.replaceChildren(h('div', { class: 'head' }, h('h3', {}, '🎓 Репетиторы онлайн'), h('span', { class: 'sp' }), sel), h('div', { class: 'scroll' },
    S.tutors.length ? S.tutors.map((t) => userCard(t, () => showProfile(t.id))) : h('div', { class: 'empty' }, 'Сейчас репетиторов в сети нет'),
    S.me.role === 'student' ? h('p', { class: 'small muted' }, 'Занятие начинает репетитор. Поднимите руку — и свободный репетитор пригласит вас.') : null));
}
async function showProfile(id) {
  const r = await tryDo(() => api('GET', '/profile?id=' + id));
  if (!r) return;
  const u = r.user, p = r.portfolio, mine = u.id === S.me.id;
  const favBtn = h('button', { class: u.fav ? 'on' : '', onclick: async () => { const x = await tryDo(() => api('POST', '/favorite', { id: u.id, on: !u.fav })); if (x) { m.close(); toast(x.mutual ? 'Вы в избранном друг у друга — чат открыт во вкладке «Чат»' : x.fav ? 'Добавлено в избранное' : 'Убрано из избранного', 'ok'); refreshTutors(); showProfile(id); } } }, u.fav ? '★ В избранном' : '☆ В избранное');
  const m = modal([h('div', { class: 'row' }, h('h2', { class: 'grow' }, u.name), u.admin ? h('span', { class: 'chip admin' }, 'админ') : null, h('span', { class: 'chip' }, u.online ? 'в сети' : 'не в сети')),
    u.role === 'tutor' ? [h('div', { class: 'chips' }, h('span', { class: 'chip' }, 'репетитор'), h('span', { class: 'chip' }, stars(u.rating) + (u.marks ? ` (${u.marks} ${plural(u.marks, 'оценка', 'оценки', 'оценок')})` : '')), h('span', { class: 'chip' }, `${u.lessons} ${plural(u.lessons, 'занятие', 'занятия', 'занятий')}`), h('span', { class: 'chip' }, u.free ? 'первые занятия бесплатно' : u.price ? `${money(u.price)} в час (от часа)` : 'бесплатно')), h('div', {}, 'Предметы: ' + u.subjects.join(', '))]
      : u.role === 'student' ? h('div', { class: 'chips' }, h('span', { class: 'chip' }, 'ученик'), h('span', { class: 'chip' }, u.gradeLabel), h('span', { class: 'chip' }, 'рейтинг: ' + stars(u.rating)), h('span', { class: 'chip' }, `${u.lessons} ${plural(u.lessons, 'занятие', 'занятия', 'занятий')}`), u.goal ? h('span', { class: 'chip on' }, 'цель: ' + u.goal) : null) : null,
    u.about ? h('p', {}, u.about) : null, h('p', { class: 'small muted' }, 'На платформе с ' + new Date(u.created).toLocaleDateString('ru-RU')),
    p ? portfolioView(p) : null,
    mine || S.me.role === 'admin' || u.role === 'admin' ? null : h('div', { class: 'row' }, favBtn, h('button', { disabled: !u.mutual, title: u.mutual ? '' : 'Чат откроется после взаимного добавления в избранное', onclick: () => { m.close(); S.chatWith = u.id; setTab('chat'); } }, '💬 Написать')),
    !mine && !u.mutual && u.role !== 'admin' && S.me.role !== 'admin' ? h('p', { class: 'small muted' }, 'Чат и заявки на занятия открываются, когда вы оба добавили друг друга в избранное.') : null], { wide: !!p });
}
function portfolioView(p) {
  return h('div', { class: 'col' }, h('h3', {}, 'Портфолио'),
    p.badges.length ? h('div', { class: 'chips' }, p.badges.map((b) => h('span', { class: 'chip on' }, '🏅 ' + b))) : null,
    p.strong.length ? h('div', { class: 'small' }, 'Сильные предметы: ' + p.strong.join(', ')) : null,
    h('div', { class: 'tablewrap' }, h('table', {}, h('tr', {}, h('th', {}, 'Работа платформы'), h('th', {}, 'Балл из 7')), p.works.length ? p.works.map((w) => h('tr', {}, h('td', {}, w.title), h('td', {}, String(w.score).replace('.', ',')))) : h('tr', {}, h('td', { colspan: 2, class: 'muted' }, 'Работ пока нет')))),
    p.tutorWorks.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('tr', {}, h('th', {}, 'Работа репетитора'), h('th', {}, 'Репетитор'), h('th', {}, 'Оценка из 5')), p.tutorWorks.map((w) => h('tr', {}, h('td', {}, w.title), h('td', {}, w.tutor), h('td', {}, w.grade))))) : null);
}

/* ---------- занятие ---------- */
function startCallUi(m) {
  for (const k of ['invite', 'waiting']) if (S[k]) { S[k].close(); S[k] = null; }
  S.call = { ...m, msgs: [], sub: 'board' };
  S.call.board = new Board({ onOp: (op) => Hub.send({ t: 'board', data: op }) });
  S.call.code = new CodeEditor({ onChange: (d) => Hub.send({ t: 'code', data: d }) });
  S.call.t0 = Date.now(); S.hand = null;
  Call.begin(m.peer, m.polite, m.ice);
  S.tab = 'lesson'; S.mob = 'right'; render();
  toast(`Занятие с пользователем ${m.peer.name} началось`, 'ok');
}
Call.on(() => { if (S.call) { renderCallPanel(); if (Call.state.remoteSharing && S.call.sub !== 'screen') { S.call.sub = 'screen'; if (S.tab === 'lesson') renderCenter(); } else if (S.tab === 'lesson' && S.call.sub === 'screen') renderCenter(); } });
setInterval(() => { const el = document.getElementById('calltimer'); if (el && S.call) el.textContent = fmtDur(Date.now() - S.call.t0); }, 1000);
function renderCallPanel() {
  const c = S.call, st = Call.state;
  const remote = h('video', { autoplay: true, playsinline: true }), self = h('video', { autoplay: true, playsinline: true, muted: true });
  remote.srcObject = st.remoteStream || null; self.srcObject = Call.localStream() || null; self.muted = true;
  const showRemote = st.remoteCam && st.remoteStream;
  if (!showRemote) remote.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0';
  c.chatEl = h('div', { class: 'msgs', style: 'min-height:90px' });
  const inp = h('input', { placeholder: 'Сообщение', maxlength: 2000, 'aria-label': 'Сообщение в чат занятия' });
  const send = (e) => { e.preventDefault(); const t = inp.value.trim(); if (!t) return; Hub.send({ t: 'callmsg', data: { text: t } }); c.msgs.push({ me: true, text: t }); inp.value = ''; renderCallChat(); };
  const payNote = c.free ? 'Занятие бесплатное: у репетитора первые занятия бесплатны.' : c.price ? `До часа бесплатно. От часа — ${money(c.price)} в час за всё время.` : 'Занятие бесплатное.';
  E.right.replaceChildren(h('div', { class: 'head' }, h('h3', { class: 'grow' }, '🎧 ' + c.peer.name), h('span', { class: 'timer', id: 'calltimer' }, fmtDur(Date.now() - c.t0))),
    h('div', { class: 'scroll' }, h('div', { class: 'videos' }, remote, showRemote ? null : h('div', { class: 'ava' }, st.state === 'active' ? '🎧' : '⏳'), st.camOn ? h('div', { class: 'self' }, self) : null),
      h('div', { class: 'callbar' }, h('button', { class: st.micOn ? 'on' : '', title: 'Микрофон', onclick: () => Call.toggleMic() }, st.micOn ? '🎙 Вкл' : '🎙 Выкл'), h('button', { class: st.camOn ? 'on' : '', title: 'Камера', onclick: () => Call.toggleCam() }, '📷'),
        navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia ? h('button', { class: st.sharing ? 'on' : '', title: 'Показ экрана', onclick: () => Call.toggleShare() }, '🖥') : null,
        h('button', { class: 'danger', onclick: async () => { if (await confirmBox('Завершить занятие?', 'Звонок закончится для обоих участников.', 'Завершить')) Hub.send({ t: 'hangup' }); } }, 'Завершить')),
      h('div', { class: 'small muted' }, `${c.subject}. ${payNote} До 20 минут — помощь, от 20 — занятие.`),
      h('button', { class: 'sm', onclick: () => setTab('lesson') }, 'Открыть доску и код'),
      h('div', { class: 'card', style: 'padding:0;flex:1;min-height:180px' }, h('div', { class: 'chatbox' }, c.chatEl, h('form', { class: 'send', onsubmit: send }, inp, h('button', { class: 'primary' }, '➤'))))));
  renderCallChat(); renderTop();
}
function renderCallChat() { const c = S.call; if (!c || !c.chatEl) return; c.chatEl.replaceChildren(...(c.msgs.length ? c.msgs.map((m) => h('div', { class: 'msg' + (m.me ? ' me' : '') }, m.text)) : [h('div', { class: 'msg sys' }, 'Чат занятия. После завершения он очищается.')])); c.chatEl.scrollTop = c.chatEl.scrollHeight; }
function lessonPage() {
  const c = S.call;
  if (!c) return h('div', { class: 'empty' }, 'Сейчас занятия нет');
  const tab = (id, title) => h('button', { class: c.sub === id ? 'on' : '', onclick: () => { c.sub = id; renderCenter(); } }, title);
  let body;
  if (c.sub === 'board') body = c.board.el;
  else if (c.sub === 'code') body = c.code.el;
  else { const v = h('video', { autoplay: true, playsinline: true, controls: true }); v.srcObject = Call.state.remoteScreen || Call.screenStream() || null; v.muted = true; body = Call.state.remoteScreen || Call.screenStream() ? h('div', { class: 'screenview' }, v) : h('div', { class: 'empty' }, 'Сейчас никто не показывает экран. Кнопка 🖥 в панели звонка включает показ (на компьютере).'); }
  return [h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Занятие: ' + c.peer.name), h('div', { class: 'tabs' }, tab('board', 'Общая доска'), tab('code', 'Общий код'), tab('screen', 'Экран'))),
    h('p', { class: 'small muted' }, c.sub === 'screen' ? 'Показ экрана собеседника.' : 'Вы и собеседник видите одно и то же: всё, что рисуете или пишете, сразу появляется у него.'), body];
}
function endCallUi(m) {
  Call.reset();
  const s = m.summary; S.call = null;
  if (S.tab === 'lesson') S.tab = S.me.role === 'tutor' ? 'profile' : 'practice';
  S.mob = 'center'; render(); reloadMe();
  const lines = [h('h2', {}, kindName[s.kind] + (s.kind === 'short' ? '' : ` · ${s.minutes} мин`)), h('p', { class: 'muted' }, m.reason || '')];
  if (s.kind === 'short') lines.push(h('p', {}, 'Звонок короче 2 минут не считается ни помощью, ни занятием.'));
  else {
    lines.push(h('p', {}, s.kind === 'help' ? 'Это была помощь: бесплатно, в счёт занятий не идёт.' : s.counted ? 'Занятие засчитано.' : 'Занятие не засчитано: у вас с этим пользователем уже 4 занятия за сутки.'));
    if (s.kind === 'lesson') lines.push(h('p', {}, s.cost ? (S.me.role === 'student' ? `Списано ${money(s.cost)}.` : `Ученик оплатил ${money(s.cost)}, комиссия платформы 2%.`) : 'Оплата не взималась.'));
  }
  if (s.rate) {
    const who = S.me.role === 'student' ? `Оцените репетитора (от 1 до ${s.rate.max})` : 'Поставьте оценку ученику (от 1 до 5)';
    lines.push(h('h3', {}, who), h('div', { class: 'stars' }, Array.from({ length: s.rate.max }, (_, i) => h('button', { onclick: async () => { const ok = await tryDo(() => api('POST', '/rate', { lessonId: s.lessonId, score: i + 1 })); if (ok) { box.close(); toast('Оценка сохранена', 'ok'); reloadMe(); } } }, i + 1))),
      h('p', { class: 'small muted' }, S.me.role === 'student' ? 'Оценка ставится один раз и влияет на рейтинг репетитора. Поставить её позже можно в профиле, в истории занятий.' : 'Оценка войдёт в рейтинг ученика.'));
  }
  lines.push(h('button', { onclick: () => box.close() }, s.rate ? 'Оценить позже' : 'Закрыть'));
  const box = modal(lines, { sticky: true });
}

/* ---------- центр ---------- */
async function renderCenter() {
  if (!E.center) return;
  const page = h('div', { class: 'scroll' });
  E.center.replaceChildren(page);
  const tab = S.tab;
  let kids;
  try { kids = await ({ practice: practicePage, disc: discPage, sites: sitesPage, chat: chatPage, leaders: leadersPage, users: usersPage, profile: profilePage, lesson: lessonPage, admin: adminPage }[tab] || practicePage)(page); }
  catch (e) { kids = h('div', { class: 'empty bad' }, e.message); }
  if (tab !== S.tab || !page.isConnected) return;
  if (kids) page.replaceChildren(...[kids].flat(Infinity).filter(Boolean));
  renderFab();
}

/* ---------- практика ---------- */
async function practicePage() {
  if (S.work) return S.work.el;
  const me = S.me, out = [];
  const r = me.role === 'admin' ? { works: [], viewer: true } : await api('GET', '/works');
  out.push(h('h2', {}, 'Практика'), h('p', { class: 'muted' }, 'Работы олимпиадного уровня: 5 задач, 1 час 30 минут, максимум 7 баллов. Ответ краткий, но чтобы его получить, нужно полное решение. Попытка одна.'));
  if (me.role === 'student') {
    if (r.graduate) out.push(h('div', { class: 'card' }, 'Вы выпускник: работы платформы рассчитаны на 7–11 классы и вам недоступны. Работы от репетиторов, дисциплины и сайты остаются.'));
    else out.push(h('h3', {}, `Работы для вашего класса (${r.grade})`), h('div', { class: 'grid' }, r.works.map((w) => h('div', { class: 'card click', tabindex: 0, role: 'button', onclick: () => startWork(w), onkeydown: (e) => { if (e.key === 'Enter') startWork(w); } },
      h('div', { class: 'row' }, h('span', { class: 'chip on' }, w.subject), h('span', { class: 'sp' }), w.state === 'done' ? h('span', { class: 'chip' }, `${String(w.score).replace('.', ',')} из ${w.max}`) : w.state === 'going' ? h('span', { class: 'chip', style: 'color:var(--warn)' }, 'идёт') : h('span', { class: 'chip' }, 'не начата')),
      h('div', { class: 'name' }, w.title), h('div', { class: 'small muted' }, `${w.tasks} задач · ${w.minutes} минут`)))));
  } else if (r.works.length) {
    out.push(h('h3', {}, 'Работы платформы'), h('p', { class: 'small muted' }, 'Выполнять работы могут только ученики своего класса, поэтому задания здесь не показываются.'), h('div', { class: 'tablewrap' }, h('table', {}, h('tr', {}, ['Класс', 'Предмет', 'Работа'].map((t) => h('th', {}, t))), r.works.map((w) => h('tr', {}, h('td', {}, w.grade), h('td', {}, w.subject), h('td', {}, w.title))))));
  }
  if (me.role !== 'admin') out.push(await tworksBlock());
  return out;
}
async function startWork(w) {
  if (w.state === 'new' && !(await confirmBox('Начать работу?', `«${w.title}». На работу даётся ${w.minutes} минут. Таймер идёт на сервере и не останавливается, даже если закрыть страницу. Попытка одна.`, 'Начать'))) return;
  if (w.state === 'new') { const ok = await tryDo(() => api('POST', '/work/start', { id: w.id })); if (!ok) return; }
  openWork(w.id);
}
async function openWork(id) {
  const a = await tryDo(() => api('GET', '/work?id=' + encodeURIComponent(id)));
  if (!a) return;
  if (S.work && S.work.stop) S.work.stop();
  const done = a.submitted != null, skew = a.now - Date.now();
  const W = S.work = { id, done };
  const back = h('button', { onclick: () => { if (W.stop) W.stop(); S.work = null; renderCenter(); } }, '← К списку работ');
  if (done) {
    W.el = [h('div', { class: 'row' }, back, h('h2', { class: 'grow' }, a.work.title), h('span', { class: 'timer' }, `${String(a.score).replace('.', ',')} из ${a.work.max}`)),
      h('p', { class: 'muted' }, 'Работа сдана. Балл вошёл в ваш рейтинг и портфолио.'),
      a.tasks.map((t, i) => h('div', { class: 'task' }, h('div', { class: 'row' }, h('b', {}, `Задача ${i + 1}`), h('span', { class: 'chip' }, `${t.pts} ${plural(t.pts, 'балл', 'балла', 'баллов')}`), h('span', { class: 'chip ' + (t.ok ? 'on' : ''), style: t.ok ? '' : 'color:var(--bad);border-color:var(--bad)' }, t.ok ? 'верно' : 'неверно')),
        h('div', { class: 'q' }, t.q), h('div', { class: 'small' }, 'Ваш ответ: ', h('b', {}, a.answers[i] || '—'), ' · Верный ответ: ', h('b', {}, t.answer)), h('div', { class: 'small muted q' }, 'Разбор: ' + t.sol)))];
  } else {
    const timer = h('span', { class: 'timer' }, fmtDur(a.deadline - a.now)), saved = h('span', { class: 'small muted' }, '');
    const inputs = a.tasks.map((t, i) => h('input', { value: a.answers[i] || '', placeholder: 'Краткий ответ', maxlength: 100, 'aria-label': `Ответ на задачу ${i + 1}` }));
    const answers = () => inputs.map((x) => x.value);
    let tm = null, dirty = false;
    const save = async () => { if (!dirty) return; dirty = false; try { await api('POST', '/work/save', { id, answers: answers() }); saved.textContent = 'Ответы сохранены ' + new Date().toLocaleTimeString('ru-RU'); } catch { dirty = true; saved.textContent = 'Не удалось сохранить, пробуем ещё раз…'; } };
    inputs.forEach((x) => x.addEventListener('input', () => { dirty = true; clearTimeout(tm); tm = setTimeout(save, 1200); }));
    const finish = async (auto) => { W.stop(); const r = await tryDo(() => api('POST', '/work/submit', { id, answers: answers() })); if (auto) toast('Время вышло, работа сдана', 'ok'); if (r) { reloadMe(); openWork(id); } };
    const tick = setInterval(() => { const left = a.deadline - (Date.now() + skew); timer.textContent = fmtDur(left); timer.classList.toggle('low', left < 300_000); if (left <= 0) finish(true); }, 500);
    const iv = setInterval(save, 15000);
    W.stop = () => { clearInterval(tick); clearInterval(iv); clearTimeout(tm); W.stop = null; save(); };
    W.el = [h('div', { class: 'row' }, back, h('h2', { class: 'grow' }, a.work.title), timer),
      h('p', { class: 'small muted' }, 'В ответ запишите число или слово. Дробь можно записать как 0,5 или 1/2. Решение не проверяется, но без него ответ не получить.'),
      a.tasks.map((t, i) => h('div', { class: 'task' }, h('div', { class: 'row' }, h('b', {}, `Задача ${i + 1}`), h('span', { class: 'chip' }, `${t.pts} ${plural(t.pts, 'балл', 'балла', 'баллов')}`)), h('div', { class: 'q' }, t.q), inputs[i])),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => { if (await confirmBox('Сдать работу?', 'После сдачи изменить ответы будет нельзя.', 'Сдать')) finish(false); } }, 'Сдать работу'), saved)];
  }
  S.tab = 'practice'; renderTop(); renderCenter();
}
// Работы репетитора: у репетитора — создание и проверка, у ученика — выполнение
async function tworksBlock() {
  const me = S.me, r = await api('GET', '/tworks');
  const stName = { assigned: 'выдана', started: 'выполняется', submitted: 'ждёт оценки', graded: 'оценена' };
  const rows = r.works.map((w) => h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'name grow' }, w.title), h('span', { class: 'chip' }, w.status === 'graded' ? `оценка ${w.grade}` : stName[w.status])),
    h('div', { class: 'small muted' }, `${me.role === 'tutor' ? 'Ученик: ' + w.student : 'Репетитор: ' + w.tutor} · ${w.minutes} мин`),
    h('div', { class: 'row' }, me.role === 'student' && (w.status === 'assigned' || w.status === 'started') ? h('button', { class: 'sm primary', onclick: () => doTwork(w) }, w.status === 'assigned' ? 'Начать' : 'Продолжить') : null,
      w.status === 'submitted' || w.status === 'graded' || me.role === 'tutor' ? h('button', { class: 'sm', onclick: () => viewTwork(w) }, me.role === 'tutor' && w.status === 'submitted' ? 'Проверить и оценить' : 'Открыть') : null)));
  const out = [h('h3', {}, me.role === 'tutor' ? 'Мои работы для учеников' : 'Работы от репетиторов'),
    h('p', { class: 'small muted' }, me.role === 'tutor' ? 'Работу можно создать для ученика из взаимного избранного: от 20 минут до 5 часов. Оценка от 1 до 5 идёт в портфолио ученика.' : 'Работы выдают репетиторы из взаимного избранного. Оценка идёт в портфолио, на рейтинг не влияет.')];
  if (me.role === 'tutor') out.push(h('button', { class: 'primary', style: 'align-self:flex-start', onclick: createTwork }, '＋ Создать работу'));
  out.push(rows.length ? h('div', { class: 'grid' }, rows) : h('div', { class: 'empty' }, 'Работ пока нет'));
  return out;
}
async function createTwork() {
  const fr = await tryDo(() => api('GET', '/friends'));
  if (!fr) return;
  const sts = fr.friends.filter((f) => f.role === 'student');
  if (!sts.length) return toast('Сначала добавьте ученика в избранное, и пусть он добавит вас', 'bad');
  const who = h('select', {}, sts.map((s) => h('option', { value: s.id }, `${s.name}, ${s.gradeLabel}`))), title = h('input', { maxlength: 80, placeholder: 'Например: Квадратные уравнения' }), body = h('textarea', { style: 'min-height:200px', maxlength: 8000, placeholder: 'Задания работы. Формат любой.' }), minutes = h('input', { type: 'number', min: 20, max: 300, value: 45 });
  const m = modal([h('h2', {}, 'Новая работа'), h('label', {}, 'Ученик', who), h('label', {}, 'Название', title), h('label', {}, 'Задания', body), h('label', {}, 'Время на работу, минут (от 20 до 300)', minutes),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => { const r = await tryDo(() => api('POST', '/twork/create', { studentId: Number(who.value), title: title.value, body: body.value, minutes: Number(minutes.value) })); if (r) { m.close(); toast('Работа выдана', 'ok'); renderCenter(); } } }, 'Выдать'), h('button', { onclick: () => m.close() }, 'Отмена'))], { wide: true, sticky: true });
}
function viewTwork(w) {
  const grade = S.me.role === 'tutor' && w.status === 'submitted' ? [h('h3', {}, 'Оценка'), h('div', { class: 'stars' }, [1, 2, 3, 4, 5].map((g) => h('button', { onclick: async () => { const r = await tryDo(() => api('POST', '/twork/grade', { id: w.id, grade: g })); if (r) { m.close(); toast('Оценка поставлена', 'ok'); renderCenter(); } } }, g)))] : null;
  const m = modal([h('h2', {}, w.title), h('div', { class: 'task' }, h('div', { class: 'q' }, w.body || 'Задания откроются ученику после начала работы.')),
    w.answer !== undefined ? [h('h3', {}, 'Ответ ученика'), h('div', { class: 'task' }, h('div', { class: 'q' }, w.answer || '(пусто)')), w.attach ? h('img', { src: w.attach, alt: 'Вложение ученика', style: 'max-width:100%;border-radius:12px' }) : null] : null,
    w.status === 'graded' ? h('p', {}, 'Оценка: ', h('b', {}, w.grade)) : null, grade, h('button', { onclick: () => m.close() }, 'Закрыть')], { wide: true });
}
async function doTwork(w0) {
  if (w0.status === 'assigned' && !(await confirmBox('Начать работу?', `«${w0.title}». На работу ${w0.minutes} минут, таймер не останавливается.`, 'Начать'))) return;
  const r = await tryDo(() => api('POST', '/twork/start', { id: w0.id }));
  if (!r) return;
  const w = r.work, skew = w.now - Date.now();
  const ans = h('textarea', { style: 'min-height:220px', maxlength: 20000, placeholder: 'Решение и ответы. Код и формулы можно вставить текстом.' }); ans.value = w.answer || '';
  const timer = h('span', { class: 'timer' }), prev = h('div', {}); let attach = w.attach || '';
  const setAttach = (d) => { attach = d; prev.replaceChildren(d ? h('img', { src: d, alt: 'Вложение', style: 'max-width:240px;border-radius:10px' }) : ''); };
  setAttach(attach);
  const file = h('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: async () => { const f = file.files[0]; if (!f) return; const d = await shrinkImage(f).catch(() => null); if (!d) return toast('Не удалось прочитать картинку', 'bad'); setAttach(d); } });
  let tm = null;
  ans.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => api('POST', '/twork/draft', { id: w.id, answer: ans.value }).catch(() => {}), 1500); });
  const submit = async (auto) => { stop(); const x = await tryDo(() => api('POST', '/twork/submit', { id: w.id, answer: ans.value, attach })); S.work = null; if (x) toast(auto ? 'Время вышло, работа сдана' : 'Работа сдана', 'ok'); renderCenter(); };
  const tick = setInterval(() => { const left = w.deadline - (Date.now() + skew); timer.textContent = fmtDur(left); timer.classList.toggle('low', left < 300_000); if (left <= 0) submit(true); }, 500);
  const stop = () => { clearInterval(tick); clearTimeout(tm); };
  S.work = { id: 'tw' + w.id, stop, el: [h('div', { class: 'row' }, h('button', { onclick: () => { stop(); S.work = null; renderCenter(); } }, '← Назад'), h('h2', { class: 'grow' }, w.title), timer), h('div', { class: 'task' }, h('div', { class: 'q' }, w.body)), ans,
    h('div', { class: 'row' }, file, h('button', { onclick: () => file.click() }, '📷 Фото из тетради'), h('button', { onclick: () => boardAttach(setAttach) }, '✏️ Рисунок с доски'), attach ? null : h('span', { class: 'small muted' }, 'Одно вложение до 2 МБ')), prev,
    h('button', { class: 'primary', style: 'align-self:flex-start', onclick: async () => { if (await confirmBox('Сдать работу?', 'После сдачи изменить ответ будет нельзя.', 'Сдать')) submit(false); } }, 'Сдать работу')] };
  renderCenter();
}
function boardAttach(done) {
  const b = new Board({});
  const m = modal([h('h2', {}, 'Рисунок с доски'), b.el, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => { done(b.toDataURL()); m.close(); } }, 'Прикрепить'), h('button', { onclick: () => m.close() }, 'Отмена'))], { wide: true, sticky: true });
}
// Фото уменьшается до 1600 пикселей и сохраняется в JPEG, чтобы уложиться в 2 МБ
function shrinkImage(file) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, 1600 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); let q = 0.85, d = c.toDataURL('image/jpeg', q); while (d.length > 2_600_000 && q > 0.3) { q -= 0.15; d = c.toDataURL('image/jpeg', q); } res(d); };
    img.onerror = rej; img.src = url;
  });
}

/* ---------- дисциплины ---------- */
const discCache = new Map();
function discPage() {
  const subject = S.discSubject, tools = subjectTools(subject);
  S.discTool = Math.min(S.discTool || 0, tools.length - 1);
  const key = subject + ':' + S.discTool;
  if (!discCache.has(key)) discCache.set(key, tools[S.discTool][1]()); // инструмент создаётся один раз и сохраняет своё состояние
  return [h('h2', {}, 'Дисциплины'), h('p', { class: 'muted' }, 'Выберите предмет — появятся материалы и инструменты для него.'),
    h('div', { class: 'tabs' }, S.cfg.subjects.map((s) => h('button', { class: 'sm' + (s === subject ? ' on' : ''), onclick: () => { S.discSubject = s; S.discTool = 0; renderCenter(); } }, s))),
    h('div', { class: 'tabs' }, tools.map(([t], i) => h('button', { class: i === S.discTool ? 'on' : '', onclick: () => { S.discTool = i; renderCenter(); } }, t))),
    discCache.get(key)];
}

/* ---------- сайты ---------- */
function sitesPage() {
  if (S.site) {
    const s = S.site;
    return [h('div', { class: 'row' }, h('button', { onclick: () => { S.site = null; renderCenter(); } }, '← Все сайты'), h('h2', { class: 'grow' }, s.title), h('a', { class: 'btn', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть в новой вкладке ↗')),
      h('div', { class: 'site' }, h('iframe', { src: s.url, title: s.title, referrerpolicy: 'no-referrer', sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups' }))];
  }
  const groups = [...new Set(SITES.map((s) => s.group))];
  const open = async (s) => {
    toast('Проверяю, можно ли открыть сайт внутри страницы…');
    const r = await api('GET', '/frame-check?url=' + encodeURIComponent(s.url)).catch(() => ({ embeddable: false }));
    if (r.embeddable && !r.unknown) { S.site = s; renderCenter(); }
    else { window.open(s.url, '_blank', 'noopener'); toast(r.unknown ? 'Не удалось проверить сайт — открываю в новой вкладке' : 'Этот сайт запрещает показ внутри других страниц — открыл в новой вкладке'); }
  };
  return [h('h2', {}, 'Сайты для подготовки'), h('p', { class: 'muted' }, '20 сайтов для подготовки к ОГЭ, ЕГЭ, ВПР, олимпиадам и для программирования. Если сайт разрешает, он откроется прямо здесь, иначе — в новой вкладке.'),
    groups.map((g) => [h('h3', {}, g), h('div', { class: 'grid' }, SITES.filter((s) => s.group === g).map((s) => h('div', { class: 'card click', tabindex: 0, role: 'link', onclick: () => open(s), onkeydown: (e) => { if (e.key === 'Enter') open(s); } }, h('div', { class: 'name' }, s.title), h('div', { class: 'small muted' }, s.note), h('div', { class: 'small', style: 'color:var(--accent)' }, s.url.replace(/^https?:\/\//, '').replace(/\/$/, '')))))])];
}

/* ---------- чат друзей и заявки ---------- */
let chatState = { msgs: [], el: null };
function onChat(m) {
  if (S.tab === 'chat' && S.chatWith === m.with && chatState.el) { chatState.msgs.push(m.msg); drawMsgs(); }
  else if (m.msg.from !== S.me.id) toast('Новое сообщение в чате: ' + (m.msg.kind === 'offer' ? 'заявка на занятие' : m.msg.text.slice(0, 80)));
}
function offerCard(o) {
  const me = S.me, st = { open: 'ждёт ответа ученика', accepted: 'принята', declined: 'отклонена', expired: 'сгорела', done: 'занятие проведено' }[o.status] || o.status;
  const reply = (accept) => tryDo(async () => { await api('POST', '/offer/reply', { id: o.id, accept }); o.status = accept ? 'accepted' : 'declined'; drawMsgs(); });
  return h('div', { class: 'card', style: 'min-width:220px' }, h('b', {}, '📅 Заявка на занятие'), h('div', {}, `${o.subject ? o.subject + ' · ' : ''}${fmtTime(o.at)}`), h('div', { class: 'small' }, `${o.minutes} мин · ${o.price ? money(o.price) + ' в час' : 'бесплатно'}`), h('div', { class: 'small muted' }, 'Статус: ' + st),
    o.status === 'open' && me.role === 'student' ? h('div', { class: 'row' }, h('button', { class: 'sm good', onclick: () => reply(true) }, 'Принять'), h('button', { class: 'sm danger', onclick: () => reply(false) }, 'Отклонить')) : null,
    o.status === 'accepted' ? h('button', { class: 'sm primary', onclick: () => Hub.send({ t: 'invite', to: me.id === o.tutorId ? o.studentId : o.tutorId, offerId: o.id }) }, '▶ Начать занятие') : null);
}
function drawMsgs() {
  const el = chatState.el; if (!el) return;
  el.replaceChildren(...(chatState.msgs.length ? chatState.msgs.map((m) => h('div', { class: 'msg' + (m.from === S.me.id ? ' me' : '') }, m.kind === 'offer' && m.offer ? offerCard(m.offer) : m.text, h('span', { class: 't' }, new Date(m.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })))) : [h('div', { class: 'msg sys' }, 'Сообщений пока нет')]));
  el.scrollTop = el.scrollHeight;
}
async function chatPage() {
  const fr = (await api('GET', '/friends')).friends;
  if (!fr.length) return [h('h2', {}, 'Чат'), h('div', { class: 'empty' }, 'Чат появляется, когда вы и другой пользователь добавили друг друга в избранное. Откройте профиль репетитора или ученика и нажмите «В избранное».')];
  if (!fr.some((f) => f.id === S.chatWith)) S.chatWith = null;
  const cur = fr.find((f) => f.id === S.chatWith);
  const list = h('div', { class: 'col list' }, fr.map((f) => h('div', { class: 'card click', style: f.id === S.chatWith ? 'border-color:var(--accent)' : '', tabindex: 0, role: 'button', onclick: () => { S.chatWith = f.id; renderCenter(); }, onkeydown: (e) => { if (e.key === 'Enter') { S.chatWith = f.id; renderCenter(); } } },
    h('div', { class: 'row' }, h('span', { class: 'dot ' + (f.online ? 'on' : '') }), h('span', { class: 'name grow' }, f.name), h('span', { class: 'chip' }, f.role === 'tutor' ? 'репетитор' : f.gradeLabel)), h('div', { class: 'small muted' }, f.last ? (f.last.kind === 'offer' ? 'Заявка на занятие' : f.last.text.slice(0, 60)) : 'Нет сообщений'))));
  let conv = h('div', { class: 'conv empty' }, 'Выберите собеседника');
  if (cur) {
    chatState = { msgs: (await api('GET', '/messages?with=' + cur.id)).messages, el: h('div', { class: 'msgs' }) };
    const inp = h('input', { placeholder: 'Сообщение', maxlength: 2000, 'aria-label': 'Сообщение' });
    const send = (e) => { e.preventDefault(); const t = inp.value.trim(); if (!t) return; if (!Hub.send({ t: 'chat', to: cur.id, text: t })) return toast('Нет связи с сервером', 'bad'); inp.value = ''; };
    conv = h('div', { class: 'conv card', style: 'padding:0;min-height:0' }, h('div', { class: 'row', style: 'padding:10px 12px;border-bottom:1px solid var(--line)' }, h('button', { class: 'sm', onclick: () => { S.chatWith = null; renderCenter(); } }, '←'), h('span', { class: 'name grow', style: 'cursor:pointer', onclick: () => showProfile(cur.id) }, cur.name),
      S.me.role === 'tutor' && cur.role === 'student' ? h('button', { class: 'sm primary', onclick: () => offerDialog(cur) }, '📅 Предложить занятие') : null),
    h('div', { class: 'chatbox' }, chatState.el, h('form', { class: 'send', onsubmit: send }, inp, h('button', { class: 'primary' }, '➤'))));
    setTimeout(drawMsgs, 0);
  }
  return [h('h2', {}, 'Чат'), h('div', { class: 'chatgrid' + (cur ? ' open' : '') }, list, conv)];
}
function offerDialog(st) {
  const me = S.me, d = new Date(Date.now() + 2 * 3600_000); d.setMinutes(0, 0, 0); // ближайший целый час не раньше чем через час
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const at = h('input', { type: 'datetime-local', value: local }), minutes = h('input', { type: 'number', min: 20, max: 300, value: 60 }), price = h('input', { type: 'number', min: 0, max: me.ceiling, value: Math.min(me.ownPrice || 0, me.ceiling) }), subj = h('select', {}, me.subjects.map((s) => h('option', {}, s)));
  const m = modal([h('h2', {}, 'Заявка на занятие'), h('p', { class: 'muted' }, 'Ученик: ' + st.name), h('label', {}, 'Предмет', subj), h('label', {}, 'Дата и время', at), h('label', {}, 'Длительность, минут', minutes),
    h('label', {}, me.ceiling ? `Цена за час, ₽ (не выше ${me.ceiling} — потолок по вашему рейтингу)` : 'Цена за час: пока 0 ₽ (у вас ещё нет 5 занятий и оценок)', price),
    h('p', { class: 'small muted' }, 'Занятие короче часа бесплатно при любой цене. Неотвеченная заявка сгорает через 24 часа.'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => { const r = await tryDo(() => api('POST', '/offer', { studentId: st.id, at: new Date(at.value).getTime(), minutes: Number(minutes.value), price: Number(price.value), subject: subj.value })); if (r) m.close(); } }, 'Отправить'), h('button', { onclick: () => m.close() }, 'Отмена'))]);
}

/* ---------- лидеры и пользователи ---------- */
async function leadersPage() {
  const r = await api('GET', '/leaders' + (S.leadSubject ? '?subject=' + encodeURIComponent(S.leadSubject) : ''));
  const sel = h('select', { style: 'width:auto', 'aria-label': 'Предмет', onchange: (e) => { S.leadSubject = e.target.value; renderCenter(); } }, h('option', { value: '' }, 'Все предметы'), S.cfg.subjects.map((s) => h('option', { value: s, selected: s === S.leadSubject }, s)));
  const table = (rows, tutor) => h('div', { class: 'tablewrap' }, h('table', {}, h('tr', {}, ['№', 'Имя', 'Рейтинг', 'Занятий'].map((t) => h('th', {}, t))), rows.length ? rows.map((u, i) => h('tr', { style: 'cursor:pointer', onclick: () => showProfile(u.id) }, h('td', {}, i + 1), h('td', {}, u.name), h('td', {}, stars(u.rating)), h('td', {}, u.lessons))) : h('tr', {}, h('td', { colspan: 4, class: 'muted' }, tutor ? 'Репетиторов пока нет' : 'Учеников с рейтингом пока нет'))));
  return [h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Лидеры'), sel), h('h3', {}, 'Репетиторы (рейтинг из 10)'), table(r.tutors, true), h('h3', {}, 'Ученики (общий рейтинг из 7)'), table(r.students, false)];
}
async function usersPage() {
  const list = h('div', { class: 'grid' }), q = h('input', { placeholder: 'Поиск по имени', 'aria-label': 'Поиск по имени' });
  const load = async () => { const r = await tryDo(() => api('GET', '/users' + (q.value.trim() ? '?q=' + encodeURIComponent(q.value.trim()) : ''))); if (r) list.replaceChildren(...(r.users.length ? r.users.map((u) => userCard(u, () => showProfile(u.id))) : [h('div', { class: 'empty' }, 'Никого не найдено')])); };
  let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(load, 300); });
  load();
  return [h('h2', {}, 'Пользователи'), q, list];
}

/* ---------- профиль ---------- */
async function profilePage() {
  await reloadMe();
  const me = S.me, out = [h('div', { class: 'row' }, h('h2', { class: 'grow' }, me.name), h('span', { class: 'chip' }, 'логин: ' + me.login), h('button', { class: 'sm', onclick: () => logout() }, 'Выйти'))];
  if (me.role === 'admin') { out.push(h('p', { class: 'muted' }, 'Вы администратор. Управление пользователями и исходный код — во вкладке «Открытый код».'), passwordCard()); return out; }
  const about = h('textarea', { maxlength: 200, placeholder: 'О себе (до 200 знаков)', style: 'min-height:70px' }); about.value = me.about || '';
  const name = h('input', { value: me.name, maxlength: 40 });
  if (me.role === 'student') {
    const goal = h('select', {}, [['', 'Не выбрана'], ['ОГЭ', 'ОГЭ'], ['ЕГЭ', 'ЕГЭ'], ['Олимпиады', 'Олимпиады'], ['Учёба', 'Учёба']].map(([v, t]) => h('option', { value: v, selected: v === me.goal }, t)));
    out.push(h('div', { class: 'grid' }, h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Общий рейтинг (последние 30 записей, виден всем)'), h('div', { class: 'stat' }, stars(me.rating))), h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Личный рейтинг (за всё время, видите только вы)'), h('div', { class: 'stat' }, stars(me.personal))),
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Класс и занятия'), h('div', { class: 'stat' }, me.gradeLabel), h('div', { class: 'small muted' }, `${me.lessons} ${plural(me.lessons, 'занятие', 'занятия', 'занятий')} · класс вырастет 1 сентября`))),
    h('div', { class: 'card' }, h('h3', {}, 'О себе'), h('label', {}, 'Видимое имя', name), about, h('label', {}, 'Цель', goal), h('button', { class: 'primary', style: 'align-self:flex-start', onclick: async () => { const r = await tryDo(() => api('POST', '/profile', { name: name.value, about: about.value, goal: goal.value })); if (r) { S.me = r.user; toast('Сохранено', 'ok'); renderTop(); } } }, 'Сохранить')));
    const pf = await tryDo(() => api('GET', '/profile?id=' + me.id));
    if (pf && pf.portfolio) out.push(h('div', { class: 'card' }, portfolioView(pf.portfolio)));
  } else {
    const subj = h('div', { class: 'subj' }, S.cfg.subjects.map((s) => h('label', {}, h('input', { type: 'checkbox', value: s, checked: me.subjects.includes(s) }), s)));
    const price = h('input', { type: 'number', min: 0, max: me.ceiling, value: me.ownPrice || 0, disabled: !me.ceiling });
    out.push(h('div', { class: 'grid' }, h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Рейтинг (из 10)'), h('div', { class: 'stat' }, stars(me.rating)), h('div', { class: 'small muted' }, `${me.marks} ${plural(me.marks, 'оценка', 'оценки', 'оценок')} от учеников`)),
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Проведено занятий'), h('div', { class: 'stat' }, me.lessons), h('div', { class: 'small muted' }, me.free ? 'Первые 5 занятий бесплатные, затем цену ограничит рейтинг' : 'Засчитываются занятия от 20 минут')),
      h('div', { class: 'card' }, h('div', { class: 'muted small' }, 'Потолок цены за час'), h('div', { class: 'stat' }, money(me.ceiling)), h('div', { class: 'small muted' }, 'до 3 — 300 ₽, 3–5 — 500 ₽, 5–7 — 800 ₽, 7–9 — 1200 ₽, 9–10 — 2000 ₽'))),
    h('div', { class: 'card' }, h('h3', {}, 'О себе и предметы'), h('label', {}, 'Видимое имя', name), about, subj, h('label', {}, 'Цена за час, ₽ (берётся только за занятия от часа)', price),
      h('button', { class: 'primary', style: 'align-self:flex-start', onclick: async () => { const r = await tryDo(() => api('POST', '/profile', { name: name.value, about: about.value, price: Number(price.value), subjects: [...subj.querySelectorAll('input:checked')].map((i) => i.value) })); if (r) { S.me = r.user; toast('Сохранено', 'ok'); renderTop(); } } }, 'Сохранить')));
  }
  out.push(await walletCard(), await historyCard(), passwordCard());
  return out;
}
async function walletCard() {
  const me = S.me, w = await api('GET', '/wallet');
  const amount = h('input', { type: 'number', min: 1, max: me.role === 'student' ? S.cfg.topupMax : w.balance, value: me.role === 'student' ? 1000 : Math.max(0, w.balance), 'aria-label': 'Сумма' });
  const act = async () => { const r = await tryDo(() => api('POST', me.role === 'student' ? '/wallet/topup' : '/wallet/withdraw', { amount: Number(amount.value) })); if (r) { toast(me.role === 'student' ? 'Кошелёк пополнен' : 'Вывод оформлен', 'ok'); renderCenter(); } };
  return h('div', { class: 'card' }, h('h3', {}, 'Кошелёк'), h('div', { class: 'stat' }, money(w.balance)), h('p', { class: 'small warn' }, 'Кошелёк учебный: настоящие деньги не списываются и не выводятся.'),
    h('div', { class: 'row' }, h('div', { style: 'width:160px' }, amount), h('button', { class: 'primary', onclick: act }, me.role === 'student' ? `Пополнить (до ${money(S.cfg.topupMax)} за раз)` : 'Вывести')),
    w.txs.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('tr', {}, ['Когда', 'Сумма', 'Операция'].map((t) => h('th', {}, t))), w.txs.slice(0, 20).map((t) => h('tr', {}, h('td', {}, fmtTime(t.ts)), h('td', { class: t.amount < 0 ? 'bad' : 'ok' }, (t.amount > 0 ? '+' : '') + money(t.amount)), h('td', {}, t.note))))) : null);
}
async function historyCard() {
  const r = await api('GET', '/history');
  const rate = (l) => { const m = modal([h('h2', {}, 'Оценка'), h('p', { class: 'muted' }, `${kindName[l.kind]} с пользователем ${l.peer}, ${l.minutes} мин`), h('div', { class: 'stars' }, Array.from({ length: l.canRate.max }, (_, i) => h('button', { onclick: async () => { const ok = await tryDo(() => api('POST', '/rate', { lessonId: l.id, score: i + 1 })); if (ok) { m.close(); toast('Оценка сохранена', 'ok'); renderCenter(); } } }, i + 1)))]); };
  return h('div', { class: 'card' }, h('h3', {}, 'История занятий'), r.lessons.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('tr', {}, ['Когда', 'С кем', 'Что', 'Минут', 'Оплата', ''].map((t) => h('th', {}, t))),
    r.lessons.map((l) => h('tr', {}, h('td', {}, fmtTime(l.started)), h('td', {}, l.peer), h('td', {}, kindName[l.kind] + (l.kind === 'lesson' && !l.counted ? ' (не засчитано)' : '')), h('td', {}, l.minutes), h('td', {}, l.cost ? money(l.cost) : '—'), h('td', {}, l.canRate ? h('button', { class: 'sm', onclick: () => rate(l) }, 'Оценить') : ''))))) : h('div', { class: 'muted' }, 'Занятий пока не было'));
}
function passwordCard() {
  const o = h('input', { type: 'password', autocomplete: 'current-password' }), n = h('input', { type: 'password', autocomplete: 'new-password' });
  return h('div', { class: 'card' }, h('h3', {}, 'Смена пароля'), h('label', {}, 'Текущий пароль', o), h('label', {}, 'Новый пароль (не короче 6 символов)', n), h('button', { style: 'align-self:flex-start', onclick: async () => { const r = await tryDo(() => api('POST', '/password', { old: o.value, password: n.value })); if (r) { o.value = n.value = ''; toast('Пароль изменён', 'ok'); } } }, 'Изменить пароль'));
}

/* ---------- админ: пользователи и открытый код ---------- */
async function adminPage() {
  const sub = S.adminSub || 'users';
  const tabs = h('div', { class: 'tabs' }, h('button', { class: sub === 'users' ? 'on' : '', onclick: () => { S.adminSub = 'users'; renderCenter(); } }, 'Пользователи'), h('button', { class: sub === 'code' ? 'on' : '', onclick: () => { S.adminSub = 'code'; renderCenter(); } }, 'Исходный код'));
  if (sub === 'code') {
    const l = await api('GET', '/admin/source');
    const view = h('pre', { class: 'src' }, 'Выберите файл');
    const sel = h('select', { 'aria-label': 'Файл', onchange: async () => { const r = await tryDo(() => api('GET', '/admin/source?file=' + encodeURIComponent(sel.value))); if (r) view.textContent = r.text; } }, h('option', { value: '' }, 'Файл…'), l.files.map((f) => h('option', {}, f)));
    return [h('h2', {}, 'Открытый код'), tabs, h('p', { class: 'muted' }, 'Исходный код платформы, только для чтения.'), sel, view];
  }
  const r = await api('GET', '/admin/users');
  const act = async (u, action, value) => { const x = await tryDo(() => api('POST', '/admin/user', { id: u.id, action, value })); if (!x) return; if (x.password) modal([h('h2', {}, 'Новый пароль'), h('p', {}, `Пользователь ${u.login}: `, h('b', { style: 'font-family:var(--mono)' }, x.password)), h('p', { class: 'small muted' }, 'Передайте пароль пользователю. Повторно он не показывается.')]); else toast('Готово', 'ok'); renderCenter(); };
  return [h('h2', {}, 'Открытый код'), tabs, h('div', { class: 'tablewrap' }, h('table', {}, h('tr', {}, ['Логин', 'Имя', 'Роль', 'Класс', 'Баланс', 'Действия'].map((t) => h('th', {}, t))),
    r.users.map((u) => h('tr', {}, h('td', {}, u.login), h('td', {}, u.name), h('td', {}, u.admin ? 'админ' : u.role === 'tutor' ? 'репетитор' : u.role === 'student' ? 'ученик' : '—'),
      h('td', {}, u.role === 'student' ? h('select', { style: 'width:auto', 'aria-label': 'Класс', onchange: (e) => act(u, 'grade', Number(e.target.value)) }, [7, 8, 9, 10, 11, 12].map((g) => h('option', { value: g, selected: g === u.grade }, g === 12 ? 'выпускник' : g))) : ''), h('td', {}, u.admin ? '' : money(u.balance)),
      h('td', {}, u.admin ? '' : h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => act(u, 'resetpw') }, 'Сбросить пароль'), h('button', { class: 'sm', onclick: () => act(u, u.blocked ? 'unblock' : 'block') }, u.blocked ? 'Разблокировать' : 'Заблокировать'),
        h('button', { class: 'sm danger', onclick: async () => { if (await confirmBox('Удалить аккаунт?', `${u.login} будет удалён без возможности восстановления.`, 'Удалить')) act(u, 'delete'); } }, 'Удалить')))))))];
}

window.addEventListener('beforeunload', (e) => { if (S.call || (S.work && S.work.stop)) { e.preventDefault(); e.returnValue = ''; } });
boot();
