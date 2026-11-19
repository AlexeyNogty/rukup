'use strict';
// Инструменты раздела «Дисциплины»: доска, редактор кода с запуском Python, калькулятор, уравнения, графики, химия, шпаргалки.

// Создание элементов: h('div', { class: 'x', onclick: fn }, дети…)
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

/* ============================== ДОСКА ============================== */
// Координаты хранятся в долях ширины, поэтому рисунок одинаково выглядит на экранах разного размера.
// opts.onOp(op) — вызывается для каждого действия, чтобы передать его собеседнику; apply(op) — применить чужое действие.
class Board {
  constructor(opts = {}) {
    this.opts = opts; this.items = []; this.color = '#1a1f45'; this.width = 3; this.tool = 'pen'; this.cur = null; this.ratio = opts.ratio || 0.6;
    this.canvas = h('canvas', {});
    this.wrap = h('div', { class: 'board' }, this.canvas);
    const colors = ['#1a1f45', '#e5484d', '#2f7bf6', '#1f9d63', '#f59f00'];
    this.toolBtns = {};
    const tool = (id, label, title) => (this.toolBtns[id] = h('button', { class: 'sm', title, onclick: () => this.setTool(id) }, label));
    this.el = h('div', { class: 'col' },
      h('div', { class: 'row' }, tool('pen', '✏️ Перо', 'Рисовать'), tool('line', '📏 Линия', 'Прямая линия'), tool('text', '🔤 Текст', 'Написать текст'), tool('erase', '🧽 Ластик', 'Стирать'),
        colors.map((c) => h('button', { class: 'sm icon', title: 'Цвет', style: `background:${c};width:30px`, onclick: () => { this.color = c; if (this.tool === 'erase') this.setTool('pen'); } })),
        h('select', { style: 'width:auto', title: 'Толщина', onchange: (e) => { this.width = Number(e.target.value); } }, [2, 3, 5, 8].map((w) => h('option', { value: w, selected: w === 3 }, w + ' px'))),
        h('button', { class: 'sm', onclick: () => this.op({ k: 'u' }, true) }, '↩ Отменить'), h('button', { class: 'sm', onclick: () => this.op({ k: 'c' }, true) }, 'Очистить'),
        opts.extra || null),
      this.wrap);
    this.setTool('pen');
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.wrap);
    const pos = (e) => { const r = this.canvas.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.width]; };
    this.canvas.addEventListener('pointerdown', (e) => {
      const p = pos(e);
      if (this.tool === 'text') return this.askText(p, e);
      this.canvas.setPointerCapture(e.pointerId);
      this.cur = { k: 's', id: Math.random().toString(36).slice(2), mine: true, c: this.tool === 'erase' ? '#ffffff' : this.color, w: this.tool === 'erase' ? 22 : this.width, line: this.tool === 'line', p: [p[0], p[1]] };
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.cur) return;
      const p = pos(e);
      if (this.cur.line) this.cur.p = [this.cur.p[0], this.cur.p[1], p[0], p[1]]; else this.cur.p.push(p[0], p[1]);
      this.draw();
    });
    const up = () => { if (!this.cur) return; const s = this.cur; this.cur = null; if (s.p.length < 4) s.p.push(s.p[0] + 0.0005, s.p[1]); s.p = s.p.map((v) => Math.round(v * 1e4) / 1e4); this.op(s, true); };
    this.canvas.addEventListener('pointerup', up); this.canvas.addEventListener('pointercancel', up);
  }
  setTool(t) { this.tool = t; for (const [k, b] of Object.entries(this.toolBtns)) b.classList.toggle('on', k === t); }
  askText(p, e) {
    const r = this.wrap.getBoundingClientRect();
    const inp = h('input', { style: `position:absolute;left:${e.clientX - r.left}px;top:${e.clientY - r.top - 16}px;width:220px;background:#fff;color:#111;z-index:3`, placeholder: 'Текст и Enter' });
    const done = (ok) => { if (ok && inp.value.trim()) this.op({ k: 's', id: Math.random().toString(36).slice(2), mine: true, c: this.color, text: inp.value.trim().slice(0, 200), p: [Math.round(p[0] * 1e4) / 1e4, Math.round(p[1] * 1e4) / 1e4] }, true); inp.remove(); };
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
    this.wrap.append(inp); setTimeout(() => inp.focus(), 0);
  }
  // Применить действие: штрих, отмена (последнего штриха того же автора), очистка
  op(o, local) {
    if (o.k === 's') this.items.push(local ? o : { ...o, mine: false });
    else if (o.k === 'u') { for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].mine === !!local) { this.items.splice(i, 1); break; } }
    else if (o.k === 'c') this.items = [];
    else if (o.k === 'all') this.items = (o.items || []).map((s) => ({ ...s, mine: false }));
    if (this.items.length > 3000) this.items.splice(0, this.items.length - 3000);
    this.draw();
    if (local && this.opts.onOp) { const { mine, ...clean } = o; this.opts.onOp(clean); }
  }
  apply(o) { this.op(o, false); }
  snapshot() { return { k: 'all', items: this.items.map(({ mine, ...s }) => s) }; }
  resize() {
    const w = this.wrap.clientWidth; if (!w) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.wrap.style.height = Math.round(w * this.ratio) + 'px';
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(w * this.ratio * dpr);
    this.draw();
  }
  draw() {
    const c = this.canvas, g = c.getContext('2d'), W = c.width, H = c.height;
    if (!W) return;
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    if (this.opts.grid !== false) { // клетка, как в тетради
      const step = W / 40; g.strokeStyle = '#cfe0f5'; g.lineWidth = 1; g.beginPath();
      for (let x = step; x < W; x += step) { g.moveTo(x, 0); g.lineTo(x, H); }
      for (let y = step; y < H; y += step) { g.moveTo(0, y); g.lineTo(W, y); }
      g.stroke();
    }
    const k = W / 900;
    for (const s of this.cur ? [...this.items, this.cur] : this.items) {
      if (s.text) { g.fillStyle = s.c; g.font = `${Math.round(20 * k)}px sans-serif`; g.textBaseline = 'middle'; g.fillText(s.text, s.p[0] * W, s.p[1] * W); continue; }
      g.strokeStyle = s.c; g.lineWidth = s.w * k; g.lineCap = 'round'; g.lineJoin = 'round'; g.beginPath();
      g.moveTo(s.p[0] * W, s.p[1] * W);
      for (let i = 2; i < s.p.length; i += 2) g.lineTo(s.p[i] * W, s.p[i + 1] * W);
      g.stroke();
    }
  }
  toDataURL() { return this.canvas.toDataURL('image/png'); }
}

/* ============================== РЕДАКТОР КОДА ============================== */
const LANGS = {
  python: { title: 'Python', run: true, kw: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield', fn: 'print input int float str len range list dict set tuple abs max min sum sorted map open round enumerate zip', comment: '#', sample: 'n = int(input())\nprint(sum(range(1, n + 1)))\n' },
  cpp: { title: 'C++', kw: 'auto bool break case char class const continue default do double else enum false float for if include int long namespace new nullptr private public return short signed sizeof static struct switch template true typedef unsigned using void while', fn: 'cin cout endl std vector string map set sort main printf scanf', comment: '//', sample: '#include <iostream>\nusing namespace std;\n\nint main() {\n    int n;\n    cin >> n;\n    cout << n * (n + 1) / 2 << endl;\n    return 0;\n}\n' },
  java: { title: 'Java', kw: 'abstract boolean break case catch char class continue default do double else extends false final finally float for if implements import int interface long new null private protected public return static super switch this throw throws true try void while', fn: 'System String Scanner Math println print main', comment: '//', sample: 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        int n = in.nextInt();\n        System.out.println(n * (n + 1) / 2);\n    }\n}\n' },
  js: { title: 'JavaScript', kw: 'async await break case catch class const continue default do else export extends false finally for function if import in instanceof let new null of return switch this throw true try typeof undefined var while yield', fn: 'console log Math Number String Array Object parseInt parseFloat', comment: '//', sample: 'const n = 10;\nlet s = 0;\nfor (let i = 1; i <= n; i++) s += i;\nconsole.log(s);\n' },
  csharp: { title: 'C#', kw: 'bool break case catch char class const continue default do double else false finally float for foreach if in int long namespace new null private protected public return static string struct switch this throw true try using var void while', fn: 'Console WriteLine ReadLine Parse Math Main', comment: '//', sample: 'using System;\n\nclass Program {\n    static void Main() {\n        int n = int.Parse(Console.ReadLine());\n        Console.WriteLine(n * (n + 1) / 2);\n    }\n}\n' },
  pascal: { title: 'Pascal', kw: 'and array begin case const div do downto else end for function if mod not of or procedure program repeat then to type until var while', fn: 'integer real boolean string char write writeln read readln', comment: '//', sample: 'var n: integer;\nbegin\n  readln(n);\n  writeln(n * (n + 1) div 2);\nend.\n' },
};
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function highlight(code, lang) {
  const L = LANGS[lang], kw = new Set(L.kw.split(' ')), fn = new Set(L.fn.split(' '));
  const cm = L.comment === '#' ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  const re = new RegExp(`(${cm})|("(?:\\\\.|[^"\\\\\\n])*"?|'(?:\\\\.|[^'\\\\\\n])*'?)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-zА-Яа-я_][\\wА-Яа-я]*)`, 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index)); last = re.lastIndex;
    const t = esc(m[0]);
    if (m[1]) out += `<span class="tk-c">${t}</span>`; else if (m[2]) out += `<span class="tk-s">${t}</span>`; else if (m[3]) out += `<span class="tk-n">${t}</span>`;
    else out += kw.has(m[4]) ? `<span class="tk-k">${t}</span>` : fn.has(m[4]) ? `<span class="tk-f">${t}</span>` : t;
  }
  return out + esc(code.slice(last)) + '\n';
}

// Запуск Python в браузере: интерпретатор Pyodide работает в отдельном потоке; зависшую программу останавливаем через 10 секунд.
const PY = { worker: null, ready: false, wait: null };
const PY_SRC = `
importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
let py = null;
const boot = loadPyodide().then((p) => { py = p; postMessage({ t: 'ready' }); }).catch((e) => postMessage({ t: 'fail', text: String(e) }));
onmessage = async (ev) => {
  await boot; if (!py) return;
  const lines = String(ev.data.stdin || '').split('\\n'); let i = 0, out = '';
  py.setStdin({ stdin: () => (i < lines.length ? lines[i++] : null) });
  const w = { batched: (s) => { out += s + '\\n'; if (out.length > 200000) throw new Error('Слишком большой вывод'); } };
  py.setStdout(w); py.setStderr(w);
  postMessage({ t: 'start' });
  try { await py.runPythonAsync(ev.data.code); postMessage({ t: 'done', out }); }
  catch (e) { postMessage({ t: 'done', out, err: String(e.message || e).split('\\n').filter((l) => !/pyodide|_pyodide|eval_code|File "\\/lib/.test(l)).join('\\n').trim() }); }
};`;
function runPython(code, stdin, onStatus) {
  return new Promise((resolve) => {
    if (PY.busy) return resolve({ err: 'Программа уже выполняется' });
    PY.busy = true;
    let timer = null;
    const finish = (r) => { clearTimeout(timer); PY.busy = false; resolve(r); };
    const kill = (text) => { try { PY.worker.terminate(); } catch { /* уже остановлен */ } PY.worker = null; PY.ready = false; finish({ err: text }); };
    if (!PY.worker) {
      onStatus('Загружаю Python (первый запуск занимает до минуты, нужен интернет)…');
      try { PY.worker = new Worker(URL.createObjectURL(new Blob([PY_SRC], { type: 'text/javascript' }))); }
      catch { PY.busy = false; return resolve({ err: 'Браузер не разрешил запуск Python' }); }
      PY.worker.onerror = () => kill('Не удалось загрузить Python. Проверьте подключение к интернету.');
      timer = setTimeout(() => kill('Python не загрузился за 90 секунд. Проверьте подключение к интернету.'), 90_000);
    }
    PY.worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.t === 'ready') { PY.ready = true; }
      else if (m.t === 'fail') kill('Не удалось загрузить Python: ' + m.text);
      else if (m.t === 'start') { clearTimeout(timer); onStatus('Выполняется…'); timer = setTimeout(() => kill('Остановлено: программа работала дольше 10 секунд'), 10_000); }
      else if (m.t === 'done') finish(m);
    };
    PY.worker.postMessage({ code, stdin });
  });
}

class CodeEditor {
  // opts.onChange({ lang, text }) — для общего редактора во время занятия
  constructor(opts = {}) {
    this.opts = opts; this.lang = 'python';
    this.ta = h('textarea', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'Код программы' });
    this.pre = h('pre', { 'aria-hidden': 'true' });
    this.note = h('div', { class: 'small muted' });
    this.stdin = h('textarea', { placeholder: 'Входные данные (то, что программа читает через input), каждое значение с новой строки', style: 'min-height:60px;font-family:var(--mono);font-size:13px' });
    this.out = h('div', { class: 'out' }, 'Здесь появится вывод программы');
    this.runBtn = h('button', { class: 'primary', onclick: () => this.run() }, '▶ Запустить');
    this.bar = h('div', { class: 'tabs' }, Object.entries(LANGS).map(([id, L]) => h('button', { class: 'sm', 'data-lang': id, onclick: () => this.setLang(id, true) }, L.title)));
    this.el = h('div', { class: 'col' }, this.bar, h('div', { class: 'editor' }, this.pre, this.ta), this.note,
      this.runBox = h('div', { class: 'col' }, this.stdin, h('div', { class: 'row' }, this.runBtn, h('span', { class: 'small muted' }, 'Ограничение: 10 секунд')), this.out));
    this.ta.addEventListener('input', () => { this.paint(); this.changed(); });
    this.ta.addEventListener('scroll', () => { this.pre.scrollTop = this.ta.scrollTop; this.pre.scrollLeft = this.ta.scrollLeft; });
    this.ta.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const s = this.ta.selectionStart; this.ta.setRangeText('    ', s, this.ta.selectionEnd, 'end'); this.paint(); this.changed();
    });
    this.setLang('python', false); this.ta.value = LANGS.python.sample; this.paint();
  }
  changed() { clearTimeout(this.tm); this.tm = setTimeout(() => this.opts.onChange && this.opts.onChange({ lang: this.lang, text: this.ta.value }), 200); }
  setLang(id, user) {
    const empty = !this.ta.value.trim() || Object.values(LANGS).some((L) => L.sample === this.ta.value);
    this.lang = id;
    for (const b of this.bar.children) b.classList.toggle('on', b.dataset.lang === id);
    const L = LANGS[id];
    this.runBox.hidden = !L.run;
    this.note.textContent = L.run ? 'Python запускается прямо в браузере.' : `${L.title}: работает только подсветка кода. Запустить такую программу в браузере нельзя — используйте компилятор на своём компьютере.`;
    if (user && empty) this.ta.value = L.sample;
    this.paint(); if (user) this.changed();
  }
  paint() { this.pre.innerHTML = highlight(this.ta.value, this.lang); this.pre.scrollTop = this.ta.scrollTop; }
  // Текст от собеседника: курсор остаётся на месте
  apply(d) {
    if (!d || typeof d.text !== 'string') return;
    if (LANGS[d.lang] && d.lang !== this.lang) this.setLang(d.lang, false);
    if (d.text === this.ta.value) return;
    const s = this.ta.selectionStart, e = this.ta.selectionEnd;
    this.ta.value = d.text.slice(0, 50000); try { this.ta.setSelectionRange(s, e); } catch { /* поле не в фокусе */ }
    this.paint();
  }
  get value() { return { lang: this.lang, text: this.ta.value }; }
  async run() {
    this.runBtn.disabled = true; this.out.textContent = '';
    const r = await runPython(this.ta.value, this.stdin.value, (s) => { this.out.textContent = s; });
    this.runBtn.disabled = false;
    this.out.textContent = (r.out || '') + (r.err ? (r.out ? '\n' : '') + 'Ошибка: ' + r.err : '') || '(программа ничего не вывела)';
  }
}

/* ============================== ВЫЧИСЛЕНИЯ ============================== */
// Разбор выражения: числа, x, + − * / ^, скобки, функции, π и e; «2x» и «2(x+1)» понимаются как умножение.
function compile(src, deg) {
  const s = String(src).toLowerCase().replace(/\s+/g, '').replace(/,/g, '.').replace(/[×·]/g, '*').replace(/[÷:]/g, '/').replace(/[−–]/g, '-').replace(/π/g, 'pi').replace(/√/g, 'sqrt').replace(/\*\*/g, '^');
  if (!s) throw new Error('Введите выражение');
  let i = 0;
  const k = deg ? Math.PI / 180 : 1;
  const F = { sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, lg: Math.log10, log: Math.log10, exp: Math.exp, sin: (v) => Math.sin(v * k), cos: (v) => Math.cos(v * k), tg: (v) => Math.tan(v * k), tan: (v) => Math.tan(v * k), ctg: (v) => 1 / Math.tan(v * k),
    arcsin: (v) => Math.asin(v) / k, arccos: (v) => Math.acos(v) / k, arctg: (v) => Math.atan(v) / k };
  const names = Object.keys(F).sort((a, b) => b.length - a.length);
  const expr = () => { let a = term(); while (s[i] === '+' || s[i] === '-') { const op = s[i++], b = term(), l = a; a = op === '+' ? (x) => l(x) + b(x) : (x) => l(x) - b(x); } return a; };
  const term = () => {
    let a = unary();
    for (;;) {
      if (s[i] === '*' || s[i] === '/') { const op = s[i++], b = unary(), l = a; a = op === '*' ? (x) => l(x) * b(x) : (x) => l(x) / b(x); }
      else if (i < s.length && /[a-zа-я(\d]/.test(s[i]) ) { const b = power(), l = a; a = (x) => l(x) * b(x); } // неявное умножение
      else return a;
    }
  };
  const unary = () => { if (s[i] === '-') { i++; const a = unary(); return (x) => -a(x); } if (s[i] === '+') { i++; return unary(); } return power(); };
  const power = () => { const a = atom(); if (s[i] === '^') { i++; const b = unary(); return (x) => Math.pow(a(x), b(x)); } return a; };
  const atom = () => {
    if (s[i] === '(') { i++; const a = expr(); if (s[i] !== ')') throw new Error('Не хватает закрывающей скобки'); i++; return a; }
    if (s[i] === '|') { i++; const a = expr(); if (s[i] !== '|') throw new Error('Не хватает знака модуля'); i++; return (x) => Math.abs(a(x)); }
    const m = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (m) { i += m[0].length; const v = Number(m[0]); return () => v; }
    for (const n of names) if (s.startsWith(n, i)) { i += n.length; const a = s[i] === '(' ? atom() : power(); return (x) => F[n](a(x)); }
    if (s.startsWith('pi', i)) { i += 2; return () => Math.PI; }
    if (s[i] === 'e') { i++; return () => Math.E; }
    if (s[i] === 'x' || s[i] === 'х') { i++; return (x) => x; }
    throw new Error(i >= s.length ? 'Выражение не закончено' : `Не понимаю «${s[i]}»`);
  };
  const f = expr();
  if (i < s.length) throw new Error(`Лишний символ «${s[i]}»`);
  return f;
}
const fmt = (v) => { if (!Number.isFinite(v)) return 'не определено'; const r = Math.round(v * 1e10) / 1e10; return String(Object.is(r, -0) ? 0 : r).replace('.', ','); };

// Уравнение: линейные и квадратные решаются точно с пояснением, остальные — численно на отрезке [−100; 100]
function solveEquation(text) {
  const parts = String(text).split('=');
  if (parts.length > 2) throw new Error('В уравнении должен быть один знак «=»');
  const L = compile(parts[0]), Rr = parts.length === 2 ? compile(parts[1]) : () => 0;
  const g = (x) => L(x) - Rr(x);
  const c = g(0), a = (g(1) + g(-1) - 2 * c) / 2, b = (g(1) - g(-1)) / 2;
  const poly = [2, -2, 3.5, -7.25, 11].every((x) => Math.abs(g(x) - (a * x * x + b * x + c)) < 1e-7 * (1 + Math.abs(g(x))));
  const near0 = (v) => Math.abs(v) < 1e-10;
  if (poly) {
    if (near0(a) && near0(b)) return { steps: [near0(c) ? 'Равенство верно при любом x' : 'Равенство неверно при любом x'], roots: near0(c) ? null : [] };
    if (near0(a)) return { steps: [`Линейное уравнение: ${fmt(b)}·x + ${fmt(c)} = 0`, `x = ${fmt(-c)} / ${fmt(b)}`], roots: [-c / b] };
    const D = b * b - 4 * a * c;
    const steps = [`Квадратное уравнение: ${fmt(a)}·x² + ${fmt(b)}·x + ${fmt(c)} = 0`, `Дискриминант: D = b² − 4ac = ${fmt(D)}`];
    if (D < -1e-12) return { steps: [...steps, 'D < 0, действительных корней нет'], roots: [] };
    if (near0(D)) return { steps: [...steps, 'D = 0, один корень: x = −b / 2a'], roots: [-b / (2 * a)] };
    return { steps: [...steps, 'x = (−b ± √D) / 2a'], roots: [(-b - Math.sqrt(D)) / (2 * a), (-b + Math.sqrt(D)) / (2 * a)].sort((x, y) => x - y) };
  }
  const roots = [];
  const add = (r) => { if (Number.isFinite(r) && Math.abs(g(r)) < 1e-6 && !roots.some((q) => Math.abs(q - r) < 1e-6)) roots.push(r); };
  let px = -100, pv = g(px);
  for (let n = 1; n <= 40000; n++) {
    const x = -100 + n * 0.005, v = g(x);
    if (Number.isFinite(pv) && Number.isFinite(v)) {
      if (v === 0) add(x);
      else if (pv * v < 0) { let lo = px, hi = x, fl = pv; for (let k = 0; k < 70; k++) { const mid = (lo + hi) / 2, fm = g(mid); if (fl * fm <= 0) hi = mid; else { lo = mid; fl = fm; } } add((lo + hi) / 2); }
    }
    px = x; pv = v;
  }
  return { steps: ['Уравнение решено численно на отрезке от −100 до 100 (корни приближённые)'], roots: roots.slice(0, 20) };
}

/* ============================== ХИМИЯ ============================== */
const SUB = '₀₁₂₃₄₅₆₇₈₉', SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻' };
// H2SO4 → H₂SO₄; Fe^3+ → Fe³⁺; -> → →; коэффициенты перед формулами остаются обычными цифрами
function prettyChem(s) {
  return String(s).replace(/<->|<=>/g, '⇄').replace(/->|=>/g, '→').replace(/\^([0-9]*[+-])/g, (_, c) => [...c].map((ch) => SUP[ch]).join(''))
    .replace(/([A-Za-zА-Яа-я)\]])(\d+)/g, (_, a, n) => a + [...n].map((d) => SUB[d]).join('')).replace(/\*/g, '·');
}
// Состав формулы: { элемент: число атомов }; понимает скобки и кристаллогидраты (CuSO4*5H2O)
function parseFormula(f) {
  const total = {};
  for (const part of String(f).replace(/\s+/g, '').replace(/[·•]/g, '*').split('*')) {
    if (!part) throw new Error('Пустая формула');
    const lead = /^\d+/.exec(part);
    const mult = lead ? Number(lead[0]) : 1;
    const str = lead ? part.slice(lead[0].length) : part;
    let i = 0;
    const group = () => {
      const acc = {};
      while (i < str.length && str[i] !== ')' && str[i] !== ']') {
        let inner;
        if (str[i] === '(' || str[i] === '[') { i++; inner = group(); if (str[i] !== ')' && str[i] !== ']') throw new Error('Не закрыта скобка'); i++; }
        else { const m = /^[A-Z][a-z]?/.exec(str.slice(i)); if (!m) throw new Error(`Не понимаю «${str[i]}»: символы элементов пишутся латиницей, с заглавной буквы`); if (!(m[0] in MASS)) throw new Error(`Нет элемента «${m[0]}»`); i += m[0].length; inner = { [m[0]]: 1 }; }
        const n = /^\d+/.exec(str.slice(i)); const k = n ? Number(n[0]) : 1; if (n) i += n[0].length;
        for (const [e, v] of Object.entries(inner)) acc[e] = (acc[e] || 0) + v * k;
      }
      return acc;
    };
    const res = group();
    if (i < str.length) throw new Error('Лишняя закрывающая скобка');
    for (const [e, v] of Object.entries(res)) total[e] = (total[e] || 0) + v * mult;
  }
  if (!Object.keys(total).length) throw new Error('Пустая формула');
  return total;
}
function molarMass(f) {
  const comp = parseFormula(f);
  const rows = Object.entries(comp).map(([e, n]) => ({ e, n, m: MASS[e] * n }));
  const M = rows.reduce((s, r) => s + r.m, 0);
  return { M, rows: rows.map((r) => ({ ...r, share: (r.m / M) * 100 })) };
}
// Расстановка коэффициентов: решаем систему «число атомов каждого элемента слева и справа равно» в дробях
function balance(eq) {
  const sides = String(eq).replace(/→|->|=>|⇄/g, '=').split('=');
  if (sides.length !== 2) throw new Error('Запишите уравнение со знаком «=» или «->»');
  const names = sides.map((s) => s.split('+').map((x) => x.trim().replace(/^\d+\s*/, '')).filter(Boolean));
  if (!names[0].length || !names[1].length) throw new Error('Нужны вещества слева и справа');
  const all = [...names[0], ...names[1]], comps = all.map(parseFormula);
  const els = [...new Set(comps.flatMap((c) => Object.keys(c)))];
  const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
  const fr = (n, d = 1n) => { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return [n / g, d / g]; };
  const sub = (a, b) => fr(a[0] * b[1] - b[0] * a[1], a[1] * b[1]), mul = (a, b) => fr(a[0] * b[0], a[1] * b[1]), div = (a, b) => fr(a[0] * b[1], a[1] * b[0]);
  const M = els.map((e) => comps.map((c, j) => fr(BigInt((c[e] || 0) * (j < names[0].length ? 1 : -1)))));
  const n = all.length, pivots = [];
  let r = 0;
  for (let c = 0; c < n && r < M.length; c++) {
    const p = M.findIndex((row, idx) => idx >= r && row[c][0] !== 0n);
    if (p < 0) continue;
    [M[r], M[p]] = [M[p], M[r]];
    const pv = M[r][c]; M[r] = M[r].map((v) => div(v, pv));
    for (let k = 0; k < M.length; k++) if (k !== r && M[k][c][0] !== 0n) { const f = M[k][c]; M[k] = M[k].map((v, j) => sub(v, mul(f, M[r][j]))); }
    pivots.push(c); r++;
  }
  const free = [...Array(n).keys()].filter((c) => !pivots.includes(c));
  if (free.length !== 1) throw new Error(free.length ? 'У уравнения несколько независимых решений — проверьте формулы' : 'Уравнять нельзя: проверьте формулы веществ');
  const sol = Array(n).fill(null); sol[free[0]] = [1n, 1n];
  pivots.forEach((c, row) => { sol[c] = fr(-M[row][free[0]][0], M[row][free[0]][1]); });
  const lcm = sol.reduce((l, v) => (l * v[1]) / gcd(l, v[1]), 1n);
  let ints = sol.map((v) => (v[0] * lcm) / v[1]);
  if (ints.every((v) => v <= 0n)) ints = ints.map((v) => -v);
  if (ints.some((v) => v <= 0n)) throw new Error('Уравнять нельзя: проверьте формулы веществ');
  const g = ints.reduce((a, b) => gcd(a, b));
  ints = ints.map((v) => Number(v / g));
  const side = (list, off) => list.map((f, j) => (ints[off + j] === 1 ? '' : ints[off + j]) + prettyChem(f)).join(' + ');
  return { coef: ints, text: side(names[0], 0) + ' → ' + side(names[1], names[0].length) };
}

/* ============================== ИНТЕРФЕЙС ИНСТРУМЕНТОВ ============================== */
const Tools = {
  calculator() {
    const inp = h('input', { placeholder: 'Например: 2^10 + sqrt(144) / 3', 'aria-label': 'Выражение' }), out = h('div', { class: 'formula' }, '0');
    let deg = true;
    const calc = () => { try { out.textContent = '= ' + fmt(compile(inp.value, deg)(0)); } catch (e) { out.textContent = inp.value.trim() ? e.message : '0'; } };
    const put = (t) => { const s = inp.selectionStart ?? inp.value.length; inp.setRangeText(t, s, inp.selectionEnd ?? s, 'end'); inp.focus(); calc(); };
    inp.addEventListener('input', calc);
    const keys = ['7', '8', '9', '/', 'sqrt(', '4', '5', '6', '*', '^', '1', '2', '3', '-', '(', '0', ',', 'pi', '+', ')', 'sin(', 'cos(', 'tg(', 'ln(', 'lg('];
    const mode = h('button', { class: 'sm on', onclick: () => { deg = !deg; mode.textContent = deg ? 'Градусы' : 'Радианы'; calc(); } }, 'Градусы');
    return h('div', { class: 'col' }, inp, out, h('div', { class: 'calc' }, keys.map((k) => h('button', { onclick: () => put(k) }, k.replace('(', '').replace('sqrt', '√').replace('pi', 'π').replace('*', '×').replace('/', '÷')))),
      h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => { inp.value = ''; calc(); } }, 'Очистить'), h('button', { class: 'sm', onclick: () => { inp.value = inp.value.slice(0, -1); calc(); } }, '⌫'), mode, h('span', { class: 'small muted' }, 'Функции: sqrt, sin, cos, tg, ctg, ln, lg, abs; константы π и e')));
  },
  solver() {
    const inp = h('input', { placeholder: 'Например: x^2 - 5x + 6 = 0', 'aria-label': 'Уравнение' }), out = h('div', { class: 'col' });
    const go = () => {
      out.textContent = '';
      try {
        const r = solveEquation(inp.value);
        out.append(...r.steps.map((s) => h('div', {}, s)), h('div', { class: 'formula' }, r.roots === null ? 'x — любое число' : r.roots.length ? r.roots.map((x, i) => `x${r.roots.length > 1 ? SUB[i + 1] : ''} = ${fmt(x)}`).join(';   ') : 'Корней нет'));
      } catch (e) { out.append(h('div', { class: 'bad' }, e.message)); }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('div', { class: 'col' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, inp), h('button', { class: 'primary', onclick: go }, 'Решить')), h('div', { class: 'small muted' }, 'Неизвестная — x. Линейные и квадратные уравнения решаются точно, остальные — приближённо.'), out);
  },
  grapher() {
    const cv = h('canvas', { style: 'width:100%;display:block;border-radius:14px;background:#fff;touch-action:none;cursor:grab' });
    const inputs = ['x^2 - 4', '', ''].map((v, i) => h('input', { value: v, placeholder: `y = … (функция ${i + 1})`, 'aria-label': `Функция ${i + 1}` }));
    const colors = ['#2f7bf6', '#e5484d', '#1f9d63'], msg = h('div', { class: 'small bad' });
    let scale = 40, ox = 0, oy = 0;
    const draw = () => {
      const w = cv.clientWidth; if (!w) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2), hh = Math.round(w * 0.6);
      cv.width = w * dpr; cv.height = hh * dpr; cv.style.height = hh + 'px';
      const g = cv.getContext('2d'); g.scale(dpr, dpr); g.fillStyle = '#fff'; g.fillRect(0, 0, w, hh);
      const cx = w / 2 + ox, cy = hh / 2 + oy;
      let step = 1; while (step * scale < 28) step *= step.toString().startsWith('2') ? 2.5 : 2; while (step * scale > 90) step /= 2;
      g.lineWidth = 1; g.font = '11px sans-serif'; g.fillStyle = '#556';
      for (let x = Math.ceil((-cx / scale) / step) * step; x * scale + cx < w; x += step) { const px = x * scale + cx; g.strokeStyle = '#dde6f2'; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, hh); g.stroke(); if (Math.abs(x) > 1e-9) g.fillText(fmt(x), px + 2, Math.min(hh - 4, Math.max(11, cy + 12))); }
      for (let y = Math.ceil(((cy - hh) / scale) / step) * step; cy - y * scale > 0; y += step) { const py = cy - y * scale; g.strokeStyle = '#dde6f2'; g.beginPath(); g.moveTo(0, py); g.lineTo(w, py); g.stroke(); if (Math.abs(y) > 1e-9) g.fillText(fmt(y), Math.min(w - 26, Math.max(2, cx + 4)), py - 2); }
      g.strokeStyle = '#223'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(0, cy); g.lineTo(w, cy); g.moveTo(cx, 0); g.lineTo(cx, hh); g.stroke();
      msg.textContent = '';
      inputs.forEach((inp, i) => {
        if (!inp.value.trim()) return;
        let f; try { f = compile(inp.value.replace(/^\s*y\s*=/i, '')); } catch (e) { msg.textContent = `Функция ${i + 1}: ${e.message}`; return; }
        g.strokeStyle = colors[i]; g.lineWidth = 2; g.beginPath();
        let pen = false, prev = 0;
        for (let px = 0; px <= w; px += 0.5) { const y = f((px - cx) / scale), py = cy - y * scale; if (!Number.isFinite(y) || Math.abs(py - prev) > hh * 2) { pen = false; prev = py; continue; } if (pen) g.lineTo(px, py); else g.moveTo(px, py); pen = true; prev = py; }
        g.stroke();
      });
    };
    inputs.forEach((i) => i.addEventListener('input', draw));
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { drag = [e.clientX - ox, e.clientY - oy]; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (drag) { ox = e.clientX - drag[0]; oy = e.clientY - drag[1]; draw(); } });
    cv.addEventListener('pointerup', () => { drag = null; });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); scale = Math.min(400, Math.max(4, scale * (e.deltaY < 0 ? 1.15 : 0.87))); draw(); }, { passive: false });
    new ResizeObserver(draw).observe(cv);
    return h('div', { class: 'col' }, inputs.map((inp, i) => h('div', { class: 'row' }, h('span', { style: `width:12px;height:12px;border-radius:50%;background:${colors[i]}` }), h('div', { class: 'grow' }, inp))),
      h('div', { class: 'row' }, h('button', { class: 'sm', onclick: () => { scale = Math.min(400, scale * 1.4); draw(); } }, '＋ Ближе'), h('button', { class: 'sm', onclick: () => { scale = Math.max(4, scale / 1.4); draw(); } }, '－ Дальше'), h('button', { class: 'sm', onclick: () => { scale = 40; ox = oy = 0; draw(); } }, 'Сбросить'), msg), cv);
  },
  chemFormula() {
    const inp = h('input', { placeholder: 'Например: 2H2 + O2 -> 2H2O или Fe^3+ + 3OH^- -> Fe(OH)3', 'aria-label': 'Формула' }), out = h('div', { class: 'formula' }, '');
    inp.addEventListener('input', () => { out.textContent = prettyChem(inp.value); });
    return h('div', { class: 'col' }, inp, out, h('div', { class: 'row' }, ['→', '⇄', '↑', '↓', '°C', 'Δ'].map((s) => h('button', { class: 'sm', onclick: () => { inp.value += ' ' + s + ' '; out.textContent = prettyChem(inp.value); inp.focus(); } }, s)),
      h('button', { class: 'sm', onclick: () => navigator.clipboard && navigator.clipboard.writeText(out.textContent).catch(() => {}) }, 'Скопировать')),
      h('div', { class: 'small muted' }, 'Цифры после символов становятся индексами, заряд пишется через ^: SO4^2-. Стрелка: ->'));
  },
  chemBalance() {
    const inp = h('input', { placeholder: 'Например: Fe + O2 = Fe2O3', 'aria-label': 'Уравнение реакции' }), out = h('div', { class: 'formula' }, '');
    const go = () => { try { out.textContent = balance(inp.value).text; out.classList.remove('bad'); } catch (e) { out.textContent = e.message; out.classList.add('bad'); } };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('div', { class: 'col' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, inp), h('button', { class: 'primary', onclick: go }, 'Расставить коэффициенты')), out);
  },
  chemMass() {
    const inp = h('input', { placeholder: 'Например: H2SO4 или CuSO4*5H2O', 'aria-label': 'Формула вещества' }), out = h('div', { class: 'col' });
    const go = () => {
      out.textContent = '';
      try {
        const r = molarMass(inp.value);
        out.append(h('div', { class: 'formula' }, `M(${prettyChem(inp.value.trim())}) = ${fmt(Math.round(r.M * 1000) / 1000)} г/моль`),
          h('div', { class: 'tablewrap' }, h('table', {}, h('tr', {}, ['Элемент', 'Атомов', 'Масса, г/моль', 'Массовая доля'].map((t) => h('th', {}, t))), r.rows.map((x) => h('tr', {}, h('td', {}, x.e), h('td', {}, x.n), h('td', {}, fmt(Math.round(x.m * 1000) / 1000)), h('td', {}, fmt(Math.round(x.share * 100) / 100) + ' %'))))));
      } catch (e) { out.append(h('div', { class: 'bad' }, e.message)); }
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return h('div', { class: 'col' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, inp), h('button', { class: 'primary', onclick: go }, 'Посчитать')), out);
  },
  periodic() {
    const info = h('div', { class: 'formula', style: 'font-size:16px' }, 'Нажмите на элемент');
    const grid = h('div', { class: 'pt' }, ELEMENTS.map((e) => { const [p, g] = elementPlace(e.z); return h('div', { class: 'el ' + elementKind(e.z), style: `grid-row:${p > 8 ? p : p};grid-column:${g}`, title: e.name, onclick: () => { info.textContent = `${e.z}. ${e.name} (${e.sym}) — относительная атомная масса ${fmt(e.mass)}`; } }, e.z, h('b', {}, e.sym)); }),
      h('div', { style: 'grid-row:8;grid-column:1/19;height:8px' }));
    return h('div', { class: 'col' }, info, h('div', { class: 'tablewrap' }, grid), h('div', { class: 'small muted' }, 'Строки 9 и 10 — лантаноиды и актиноиды.'));
  },
  solubility() {
    return h('div', { class: 'col' }, h('div', { class: 'tablewrap' }, h('table', { class: 'sol' }, h('tr', {}, h('th', {}, ''), SOL.cations.map((c) => h('th', {}, c))),
      SOL.rows.map(([an, row]) => h('tr', {}, h('th', {}, an), [...row].map((v) => h('td', { class: v }, v.trim() || ''))))),
    ), h('div', { class: 'small muted' }, 'Р — растворимо, М — малорастворимо, Н — нерастворимо, «—» — не существует или разлагается водой. В разных изданиях таблицы отдельные клетки могут отличаться.'));
  },
  reference(subject) {
    const cards = REF[subject] || [];
    return h('div', { class: 'grid' }, cards.map(([title, lines]) => h('div', { class: 'card' }, h('h3', {}, title), lines.map((l) => h('div', { class: 'small' }, l)))));
  },
  notes(key) {
    const ta = h('textarea', { style: 'min-height:220px', placeholder: 'Черновик: пишите здесь. Текст сохраняется в этом браузере.' }), cnt = h('span', { class: 'small muted' });
    try { ta.value = localStorage.getItem('rukup-notes-' + key) || ''; } catch { /* хранилище недоступно */ }
    const upd = () => { const t = ta.value.trim(); cnt.textContent = `Слов: ${t ? t.split(/\s+/).length : 0}, знаков: ${ta.value.length}`; try { localStorage.setItem('rukup-notes-' + key, ta.value); } catch { /* не сохранилось */ } };
    ta.addEventListener('input', upd); upd();
    return h('div', { class: 'col' }, ta, cnt);
  },
  converter() {
    const U = { 'Скорость': [['м/с', 1], ['км/ч', 1 / 3.6]], 'Длина': [['м', 1], ['км', 1000], ['см', 0.01], ['мм', 0.001]], 'Масса': [['кг', 1], ['г', 0.001], ['т', 1000], ['мг', 1e-6]], 'Время': [['с', 1], ['мин', 60], ['ч', 3600]], 'Давление': [['Па', 1], ['кПа', 1000], ['атм', 101325], ['мм рт. ст.', 133.322]], 'Энергия': [['Дж', 1], ['кДж', 1000], ['кВт·ч', 3.6e6], ['кал', 4.1868]] };
    const kind = h('select', {}, Object.keys(U).map((k) => h('option', {}, k))), from = h('select', {}), to = h('select', {}), val = h('input', { type: 'number', value: '1', 'aria-label': 'Значение' }), out = h('div', { class: 'formula' });
    const fill = () => { for (const s of [from, to]) { s.textContent = ''; s.append(...U[kind.value].map(([n]) => h('option', {}, n))); } to.selectedIndex = 1; calc(); };
    const calc = () => { const a = U[kind.value][from.selectedIndex][1], b = U[kind.value][to.selectedIndex][1]; out.textContent = `${fmt(Number(val.value) || 0)} ${from.value} = ${fmt(((Number(val.value) || 0) * a) / b)} ${to.value}`; };
    kind.addEventListener('change', fill); for (const el of [from, to, val]) el.addEventListener('input', calc);
    fill();
    return h('div', { class: 'col' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, kind), h('div', { class: 'grow' }, val), h('div', { class: 'grow' }, from), '→', h('div', { class: 'grow' }, to)), out);
  },
};

// Какие инструменты есть у предмета: [название вкладки, функция, которая строит инструмент]
function subjectTools(subject) {
  const board = ['Доска', () => new Board({}).el];
  const ref = ['Шпаргалка', () => Tools.reference(subject)], notes = ['Черновик', () => Tools.notes(subject)];
  switch (subject) {
    case 'Информатика': return [['Редактор кода', () => new CodeEditor({}).el], ['Калькулятор', Tools.calculator], board];
    case 'Математика': return [board, ['Калькулятор', Tools.calculator], ['Уравнения', Tools.solver], ['Графики', Tools.grapher]];
    case 'Химия': return [['Формулы', Tools.chemFormula], ['Коэффициенты', Tools.chemBalance], ['Молярная масса', Tools.chemMass], ['Таблица Менделеева', Tools.periodic], ['Растворимость', Tools.solubility], board];
    case 'Физика': return [ref, ['Единицы', Tools.converter], ['Калькулятор', Tools.calculator], ['Графики', Tools.grapher], board];
    case 'Биология': return [ref, board, notes];
    default: return [ref, notes, board];
  }
}
if (typeof module !== 'undefined') module.exports = { compile, solveEquation, prettyChem, parseFormula, molarMass, balance, highlight, fmt };
