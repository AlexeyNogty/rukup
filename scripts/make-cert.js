'use strict';
// Создаёт самоподписанный SSL-сертификат для работы сайта по https в домашней сети.
// Без сторонних программ: ключ делает встроенный модуль crypto, сертификат собирается вручную в формате X.509.
// Запуск: npm run cert   (файлы появятся в папке certs)
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- кодирование ASN.1 DER (формат, в котором хранятся сертификаты) ---
const len = (n) => { if (n < 128) return Buffer.from([n]); const b = []; while (n) { b.unshift(n & 255); n >>= 8; } return Buffer.from([128 | b.length, ...b]); };
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const int = (buf) => tlv(0x02, buf[0] & 128 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const oid = (s) => { const p = s.split('.').map(Number); const out = [p[0] * 40 + p[1]]; for (const v of p.slice(2)) { const b = [v & 127]; let x = v >> 7; while (x) { b.unshift(128 | (x & 127)); x >>= 7; } out.push(...b); } return tlv(0x06, Buffer.from(out)); };
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const time = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const bits = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const octets = (buf) => tlv(0x04, buf);

// Адреса, для которых сертификат действителен: localhost и все адреса компьютера в локальной сети
const ips = ['127.0.0.1'];
for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
const san = seq(tlv(0x82, Buffer.from('localhost')), ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))));

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const name = seq(set(seq(oid('2.5.4.3'), utf8('РукUP (локальный)'))));
const now = new Date(Date.now() - 60_000), until = new Date(Date.now() + 825 * 86400_000);
const sha256rsa = seq(oid('1.2.840.113549.1.1.11'), tlv(0x05, Buffer.alloc(0)));
const tbs = seq(
  tlv(0xa0, int(Buffer.from([2]))), // версия 3
  int(crypto.randomBytes(16)), // серийный номер
  sha256rsa, name, seq(time(now), time(until)), name,
  publicKey.export({ type: 'spki', format: 'der' }),
  tlv(0xa3, seq(
    seq(oid('2.5.29.17'), octets(san)), // альтернативные имена: localhost и IP-адреса
    seq(oid('2.5.29.19'), octets(seq())), // не является центром сертификации
    seq(oid('2.5.29.37'), octets(seq(oid('1.3.6.1.5.5.7.3.1')))), // для веб-сервера
  )),
);
const cert = seq(tbs, sha256rsa, bits(crypto.sign('sha256', tbs, privateKey)));

const dir = path.join(__dirname, '..', 'certs');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(path.join(dir, 'cert.pem'), `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`);
new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'cert.pem'))); // проверка, что файл читается
console.log(`Сертификат создан в папке certs (действует до ${until.toLocaleDateString('ru-RU')}).`);
console.log('Адреса: https://localhost:3000' + ips.slice(1).map((ip) => `, https://${ip}:3000`).join(''));
console.log('Если адрес компьютера в сети поменяется, запустите команду ещё раз.');
