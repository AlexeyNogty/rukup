'use strict';
// Правила платформы «РукUP» — чистые функции без базы данных, чтобы их можно было проверять тестами.

const SUBJECTS = ['Информатика', 'Математика', 'Физика', 'Химия', 'Биология', 'Русский язык', 'Литература', 'Обществознание', 'История',
  'Английский язык', 'Китайский язык', 'Французский язык', 'Немецкий язык'];

const HELP_MIN = 2;       // короче — звонок не считается
const LESSON_MIN = 20;    // с этой длительности «помощь» становится «занятием»
const PAID_MIN = 60;      // с этой длительности занятие оплачивается (за всё время)
const FEE = 0.02;         // комиссия платформы
const FREE_LESSONS = 5;   // первые занятия нового репетитора бесплатны
const PAIR_DAY_LIMIT = 4; // засчитанных занятий одной пары за сутки
const START_BALANCE = 5000;
const TOPUP_MAX = 10000;
const INVITE_MS = 60_000;
const WORK_MINUTES = 90;
const HANDS_SHOWN = 30;

// Учебный год: с 1 сентября. Класс растёт на 1 каждое 1 сентября; после 11-го — выпускник (12).
const schoolYear = (ts) => { const d = new Date(ts); return d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1; };
function gradeNow(baseGrade, setAt, nowTs) {
  if (!baseGrade) return null;
  return Math.min(12, baseGrade + Math.max(0, schoolYear(nowTs) - schoolYear(setAt)));
}
const gradeLabel = (g) => (g == null ? '' : g >= 12 ? 'выпускник' : `${g} класс`);

// Вид звонка по длительности в минутах
function callKind(minutes) {
  if (minutes < HELP_MIN) return 'short';
  if (minutes < LESSON_MIN) return 'help';
  return 'lesson';
}
// Шкала и вес оценки, которую ученик ставит репетитору
function tutorScale(minutes) {
  const k = callKind(minutes);
  if (k === 'short') return null;
  if (k === 'help') return { max: 5, weight: 0.5 };
  if (minutes < PAID_MIN) return { max: 7, weight: 1 };
  return { max: 10, weight: 1.5 };
}
// Рейтинг репетитора: средневзвешенное оценок, приведённых к 10
function tutorRating(marks) {
  let s = 0, w = 0;
  for (const m of marks) { s += m.score10 * m.weight; w += m.weight; }
  return w ? Math.round((s / w) * 10) / 10 : null;
}
// Потолок цены за час по рейтингу
function priceCeiling(rating, lessons) {
  if (rating == null || lessons < FREE_LESSONS) return 0;
  if (rating < 3) return 300;
  if (rating < 5) return 500;
  if (rating < 7) return 800;
  if (rating < 9) return 1200;
  return 2000;
}
// Стоимость занятия: до часа бесплатно, от часа — поминутно за всё время
function lessonCost(minutes, pricePerHour) {
  if (minutes < PAID_MIN || !pricePerHour) return { cost: 0, fee: 0, tutorGets: 0 };
  const cost = Math.round((pricePerHour / 60) * minutes);
  const fee = Math.round(cost * FEE);
  return { cost, fee, tutorGets: cost - fee };
}
// Рейтинг ученика: среднее записей (оценки репетиторов 1–5 и баллы работ до 7)
function studentRating(values, last) {
  const v = last ? values.slice(-last) : values;
  if (!v.length) return null;
  return Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10;
}

// Какие руки видит репетитор: до 30; первые 20 — кто ждёт дольше всех, остальные — случайные (у каждого репетитора свои)
function pickHands(hands, tutorId, limit = HANDS_SHOWN) {
  const sorted = [...hands].sort((a, b) => a.since - b.since);
  if (sorted.length <= limit) return sorted;
  const head = sorted.slice(0, Math.floor(limit * 2 / 3));
  const rest = sorted.slice(head.length);
  let seed = (tutorId * 2654435761) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return head.concat(rest.slice(0, limit - head.length));
}

// Проверка краткого ответа: числа сравниваются как числа (0,5 = 1/2 = 0.5), слова — без регистра и «ё»
const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[−–—]/g, '-').replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
function asNumber(s) {
  const t = norm(s).replace(/\s/g, '').replace(',', '.');
  if (/^[+-]?\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^([+-]?\d+)\/(\d+)$/.exec(t);
  if (m && Number(m[2])) return Number(m[1]) / Number(m[2]);
  return null;
}
function isCorrect(answerField, given) {
  const g = norm(given);
  if (!g) return false;
  const gn = asNumber(g);
  return String(answerField).split('|').some((a) => {
    const an = asNumber(a);
    if (an !== null && gn !== null) return Math.abs(an - gn) <= 1e-6 * Math.max(1, Math.abs(an));
    return norm(a).replace(/\s/g, '') === g.replace(/\s/g, '');
  });
}
// Балл за работу: сумма весов верных задач
function workScore(tasks, answers) {
  let score = 0;
  const detail = tasks.map((t, i) => { const ok = isCorrect(t.a, answers[i]); if (ok) score += t.pts; return ok; });
  return { score, detail };
}

const validLogin = (s) => typeof s === 'string' && /^[a-zA-Z0-9_.-]{3,24}$/.test(s);
const validName = (s) => typeof s === 'string' && s.trim().length >= 2 && s.trim().length <= 40;
const validPassword = (s) => typeof s === 'string' && s.length >= 6 && s.length <= 100;

module.exports = { SUBJECTS, HELP_MIN, LESSON_MIN, PAID_MIN, FEE, FREE_LESSONS, PAIR_DAY_LIMIT, START_BALANCE, TOPUP_MAX, INVITE_MS, WORK_MINUTES, HANDS_SHOWN,
  schoolYear, gradeNow, gradeLabel, callKind, tutorScale, tutorRating, priceCeiling, lessonCost, studentRating, pickHands, norm, asNumber, isCorrect, workScore,
  validLogin, validName, validPassword };
