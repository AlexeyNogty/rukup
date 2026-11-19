'use strict';
// Проверка «можно ли показать сайт внутри нашей страницы (iframe)». Многие сайты запрещают это заголовками
// X-Frame-Options / Content-Security-Policy: frame-ancestors — тогда на сайте мы предлагаем открыть его в новой вкладке.
// Запрос идёт с нашего сервера, поэтому он защищён от SSRF: только http/https, обычные порты, адрес назначения проверяется
// (никаких локальных и внутренних сетей), каждый редирект проверяется заново, соединение идёт строго на проверенный адрес.
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const bl = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) bl.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) bl.addSubnet(a, p, 'ipv6');

const isBlockedAddress = (ip) => { const f = net.isIP(ip); return !f || bl.check(ip, f === 6 ? 'ipv6' : 'ipv4'); };
const PORTS = new Set(['', '80', '443', '8080', '8443']);

// По заголовкам ответа: можно ли встроить страницу
function evaluate(headers) {
  const xfo = String(headers['x-frame-options'] || '').toLowerCase();
  if (/deny|sameorigin/.test(xfo)) return { embeddable: false, reason: 'X-Frame-Options' };
  const csp = String(headers['content-security-policy'] || '');
  const m = /frame-ancestors\s+([^;]+)/i.exec(csp);
  if (m && !m[1].split(/\s+/).includes('*')) return { embeddable: false, reason: 'frame-ancestors' };
  return { embeddable: true };
}

async function resolveSafe(host) {
  if (net.isIP(host)) { if (isBlockedAddress(host)) throw new Error('blocked'); return { address: host, family: net.isIP(host) }; }
  const list = await dns.promises.lookup(host, { all: true });
  if (!list.length || list.some((a) => isBlockedAddress(a.address))) throw new Error('blocked');
  return list[0];
}

function headOnce(u, addr, timeout) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      host: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', timeout,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RepetitorFrameCheck/1.0)', Accept: 'text/html,*/*;q=0.5' },
      // соединяемся строго с адресом, который мы только что проверили (защита от подмены DNS)
      lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
    }, (res) => { resolve({ status: res.statusCode, headers: res.headers }); res.destroy(); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function checkEmbeddable(urlStr, { hops = 3, timeout = 4000 } = {}) {
  let u;
  try { u = new URL(String(urlStr)); } catch { return { embeddable: true, unknown: true }; }
  try {
    for (let i = 0; i <= hops; i++) {
      if (!/^https?:$/.test(u.protocol) || !PORTS.has(u.port) || u.username || u.password) return { embeddable: true, unknown: true };
      const addr = await resolveSafe(u.hostname.replace(/^\[|\]$/g, ''));
      const r = await headOnce(u, addr, timeout);
      if (r.status >= 300 && r.status < 400 && r.headers.location) { u = new URL(r.headers.location, u); continue; }
      return evaluate(r.headers);
    }
  } catch { /* недоступно с сервера — не мешаем, браузер покажет свою ошибку */ }
  return { embeddable: true, unknown: true };
}

module.exports = { isBlockedAddress, evaluate, checkEmbeddable };
