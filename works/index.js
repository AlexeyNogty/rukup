'use strict';
// Банк работ раздела «Практика»: по одной работе на предмет и класс. Каждая работа — 5 задач с кратким ответом,
// три по 1 баллу и две по 2 балла (максимум 7). Ответы и разборы хранятся только на сервере.
// Формат задачи: { q: условие, a: 'ответ|допустимый вариант', pts: баллы, sol: разбор }
const list = [];
for (const g of [7, 8, 9, 10, 11]) {
  let part = [];
  try { part = require(`./g${g}.js`); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  for (const w of part) {
    const id = `g${g}-${w.key}`;
    const pts = w.tasks.reduce((s, t) => s + t.pts, 0);
    if (w.tasks.length !== 5 || pts !== 7) throw new Error(`Работа ${id}: нужно 5 задач на 7 баллов, а здесь ${w.tasks.length} на ${pts}`);
    list.push({ id, grade: g, subject: w.subject, title: w.title, tasks: w.tasks });
  }
}
module.exports = { list, byId: new Map(list.map((w) => [w.id, w])) };
