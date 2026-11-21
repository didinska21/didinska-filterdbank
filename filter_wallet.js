#!/usr/bin/env node
/**
 * filter_wallet.js — Filter wallet dari DeBank live.
 *
 * Input : file teks, satu wallet per baris, format:
 *           balance|address|pvkey
 *         - balance lama diabaikan, hanya dipakai sebagai fallback kalau
 *           cek live gagal (baris itu masuk file .failed.txt, bukan output).
 *         - yang dikirim ke DeBank HANYA address. pvkey tidak pernah
 *           dikirim, tidak pernah di-log.
 *
 * Proses : ambil address (kolom ke-2) -> cek total balance live di DeBank
 *          -> update balance dengan nilai live (USD)
 *          -> buang yang < $0.20
 *          -> urutkan dari balance terbesar ke terkecil
 *
 * Output: file teks dengan format SAMA persis:
 *           balance|address|pvkey
 *         balance ditulis 2 desimal, contoh: 1234.56|0xabc...|0x123...
 *
 * Cara pakai (mode interaktif, untuk VPS + screen):
 *   node filter_wallet.js
 *   Masukkan file: wallets.txt
 *   Masukkan file hasil: filtered.txt
 *   (kosongkan saja untuk pakai default di atas)
 *
 * Cara pakai (mode argumen, untuk otomatisasi / screen tanpa ketik):
 *   node filter_wallet.js wallets.txt filtered.txt
 *   Kalau argumen diisi, prompt dilewati.
 *   Proxy juga bisa diisi sebagai argumen ke-4, atau --proxy=... :
 *   node filter_wallet.js wallets.txt filtered.txt "http://user:pass@1.2.3.4:8080"
 *   node filter_wallet.js wallets.txt filtered.txt --proxy=proxies.txt
 *
 * Proxy (opsional, biar IP tidak kena 429 dari DeBank):
 *   - Cara yang disarankan: isi proxy.txt di folder yang sama
 *     (satu proxy per baris, contoh format ada di file itu),
 *     lalu jalankan: node filter_wallet.js
 *     Di prompt, kosongkan saja untuk pakai proxy.txt.
 *   - Bisa juga di prompt interaktif, argumen --proxy=..., atau
 *     env PROXY (satu proxy / daftar dipisah koma) / PROXY_FILE.
 *   - Format yang diterima (tipe default http kalau tidak disebut):
 *       http://user:pass@host:port   https://user:pass@host:port
 *       socks5://user:pass@host:port
 *       host:port                    user:pass@host:port
 *       host:port:user:pass          (format umum di file daftar proxy)
 *   - Kalau ada lebih dari satu proxy, dipakai bergiliran (round-robin):
 *     tiap wallet dicek lewat proxy berikutnya, dan kalau satu proxy
 *     kena 429 / error, percobaan berikut pindah ke proxy lain.
 *   - Kredensial proxy TIDAK pernah di-log apa adanya; di log hanya
 *     tampil sebagai ***@host:port. Isi proxy lewat file di VPS atau
 *     env var, jangan kirim proxy ber-password lewat chat.
 *
 * Env (opsional):
 *   DEBANK_API_KEY   kalau diisi, pakai DeBank Cloud API resmi
 *                    (https://pro-openapi.debank.com/v1/user/total_balance,
 *                    header AccessKey). Tanpa ini, pakai endpoint publik
 *                    https://api.debank.com/user/total_balance
 *                    yang rawan 429 kalau request terlalu cepat.
 *   MIN_BALANCE      default 0.2  (dolar)
 *   DELAY_MS         jeda antar request, default 2000 ms.
 *                    Naikkan kalau sering kena 429.
 *   DEBANK_BASE_URL  khusus tes: ganti host API DeBank (default
 *                    https://api.debank.com, atau pro-openapi kalau
 *                    ada DEBANK_API_KEY). Jangan dipakai untuk nyata.
 *
 * Loading (dibuat untuk screen di VPS, prosesnya memang lama):
 *   - spinner berputar selama tiap address dicek
 *   - progress bar + persen + hitungan lolos/buang/gagal
 *   - waktu berjalan + perkiraan sisa (ETA)
 *   - perkiraan total waktu ditampilkan di awal
 *
 * Catatan DeBank (teruji 21 Nov 2026):
 *   - Halaman https://debank.com/profile/<address> itu SPA: HTML-nya
 *     cuma shell kosong, balance tidak ada di HTML. Jadi jangan scrape
 *     HTML-nya, pakai API di atas.
 *   - Endpoint publik tanpa API key gampang 429 dari IP bersama.
 *     Script ini jalan sekuensial (1 request sekali jalan) + retry
 *     dengan backoff, dan yang gagal dicatat di <output>.failed.txt
 *     supaya bisa diulang, bukan diam-diam hilang.
 *
 * Butuh Node.js 18+ (fetch bawaan, tanpa dependency).
 */

const fs = require('fs');
const readline = require('readline');
const net = require('net');
const tls = require('tls');

const MIN_BALANCE = parseFloat(process.env.MIN_BALANCE || '0.2');
const DELAY_MS = parseInt(process.env.DELAY_MS || '2000', 10);
const API_KEY = (process.env.DEBANK_API_KEY || '').trim();

// File proxy default: proxy.txt di folder kerja (satu proxy per baris).
// Kalau file ini ada, dipakai otomatis kalau tidak ada proxy lain yang
// disebut lewat prompt / argumen / env.
const DEFAULT_PROXY_FILE = 'proxy.txt';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatBalance(v) {
  return Number(v).toFixed(2);
}

function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a || '');
}

// 4523000 ms -> "1j 15m 23d" | 125000 ms -> "2m 5d" | 9000 ms -> "9d"
function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}j ${m}m ${sec}d`;
  if (m > 0) return `${m}m ${sec}d`;
  return `${sec}d`;
}

function shortAddr(a) {
  return a.length > 14 ? `${a.slice(0, 8)}...${a.slice(-4)}` : a;
}

// ---------------------------------------------------------------------------
// Proxy: parse, daftar, dan koneksi (tanpa dependency).
// ---------------------------------------------------------------------------

// "http://user:pass@host:port" | "socks5://host:port" | "host:port" |
// "user:pass@host:port" | "host:port:user:pass"  ->  { type, host, port, auth }
// Mengembalikan null kalau formatnya tidak bisa dibaca.
function parseProxy(raw) {
  let s = (raw || '').trim();
  if (!s || s.startsWith('#')) return null;
  let type = 'http';
  const m = s.match(/^(https?|socks5?|socks):\/\//i);
  if (m) { type = m[1].toLowerCase().startsWith('socks') ? 'socks5' : m[1].toLowerCase(); s = s.slice(m[0].length); }
  let auth = null;
  const at = s.lastIndexOf('@');
  if (at !== -1) {
    auth = s.slice(0, at);
    s = s.slice(at + 1);
    if (auth.includes(':')) {
      const i = auth.indexOf(':');
      auth = { user: auth.slice(0, i), pass: auth.slice(i + 1) };
    } else {
      auth = { user: auth, pass: '' };
    }
  }
  // Format umum file proxy: host:port:user:pass
  const parts = s.split(':');
  if (parts.length === 4 && /^\d+$/.test(parts[1])) {
    if (!auth) auth = { user: parts[2], pass: parts[3] };
    s = parts[0] + ':' + parts[1];
  }
  const hostPort = s.split(':');
  if (hostPort.length !== 2 || !hostPort[0] || !/^\d+$/.test(hostPort[1])) return null;
  return { type, host: hostPort[0], port: parseInt(hostPort[1], 10), auth };
}

// Satu proxy untuk log (password selalu disembunyikan).
function maskProxy(p) {
  const auth = p.auth ? '***@' : '';
  return `${p.type}://${auth}${p.host}:${p.port}`;
}

// Nilai mentah (argumen / prompt / env) -> daftar proxy. Kalau nilainya
// adalah path file yang ada, baca isinya satu proxy per baris.
function loadProxies(raw) {
  const values = [];
  if (raw) {
    const v = String(raw).trim();
    if (v && fs.existsSync(v) && fs.statSync(v).isFile()) {
      values.push(...fs.readFileSync(v, 'utf8').split(/\r?\n/));
    } else if (v) {
      values.push(...v.split(','));
    }
  }
  const out = [];
  for (const v of values) {
    const p = parseProxy(v);
    if (p) out.push(p);
  }
  return out;
}

// Daftar proxy global + putaran round-robin.
let PROXIES = [];
let proxyIndex = 0;
function nextProxy() {
  if (PROXIES.length === 0) return null;
  const p = PROXIES[proxyIndex % PROXIES.length];
  proxyIndex++;
  return p;
}

// Baca N byte persis dari socket (untuk handshake SOCKS5).
// Pakai socket.read(n) supaya sisa byte yang sudah masuk tidak hilang:
// versi 'data'-listener lama membuang byte lebihan, dan pembacaan
// berikutnya bisa menggantung menunggu byte yang sudah terbuang.
function readExact(socket, n) {
  return new Promise((resolve, reject) => {
    const onReadable = () => {
      const chunk = socket.read(n);
      if (chunk && chunk.length === n) {
        socket.removeListener('readable', onReadable);
        socket.removeListener('error', onError);
        resolve(chunk);
      }
    };
    const onError = (e) => {
      socket.removeListener('readable', onReadable);
      reject(e);
    };
    socket.on('readable', onReadable);
    socket.once('error', onError);
    onReadable();
  });
}

// HTTP(S) proxy: CONNECT host:443 -> socket mentah yang siap di-TLS-kan.
async function connectViaHttpProxy(proxy, host, port) {
  const socket = net.connect(proxy.port, proxy.host);
  socket.setTimeout(15000);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.once('timeout', () => reject(new Error('timeout konek ke proxy')));
  });
  let req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
  if (proxy.auth) {
    req += `Proxy-Authorization: Basic ${Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString('base64')}\r\n`;
  }
  req += '\r\n';
  socket.write(req);
  const head = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end !== -1) { socket.removeListener('data', onData); resolve(buf.slice(0, end).toString()); }
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  if (!/^HTTP\/\d\.\d 200/.test(head)) {
    socket.destroy();
    throw new Error(`proxy menolak CONNECT: ${head.split('\r\n')[0]}`);
  }
  socket.setTimeout(0);
  socket.pause(); // hentikan mode flowing, biar tls.connect yang mengambil alih
  return socket;
}

// SOCKS5: greeting + (auth user/pass kalau ada) + CONNECT.
async function connectViaSocks5(proxy, host, port) {
  const socket = net.connect(proxy.port, proxy.host);
  socket.setTimeout(15000);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.once('timeout', () => reject(new Error('timeout konek ke proxy')));
  });
  const methods = proxy.auth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
  socket.write(methods);
  const method = await readExact(socket, 2);
  if (method[0] !== 0x05) { socket.destroy(); throw new Error('proxy bukan SOCKS5'); }
  if (method[1] === 0x02) {
    if (!proxy.auth) { socket.destroy(); throw new Error('proxy minta auth, tapi tidak ada user/pass'); }
    const u = Buffer.from(proxy.auth.user);
    const p = Buffer.from(proxy.auth.pass);
    socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    const authRes = await readExact(socket, 2);
    if (authRes[0] !== 0x01 || authRes[1] !== 0x00) { socket.destroy(); throw new Error('auth SOCKS5 gagal'); }
  } else if (method[1] !== 0x00) {
    socket.destroy();
    throw new Error('metode auth SOCKS5 tidak didukung proxy');
  }
  const h = Buffer.from(host);
  const req = Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]);
  socket.write(req);
  const rep = await readExact(socket, 4);
  if (rep[0] !== 0x05 || rep[1] !== 0x00) {
    socket.destroy();
    throw new Error(`SOCKS5 CONNECT gagal (kode ${rep[1]})`);
  }
  // Sisa header balasan: alamat tujuan (tipe 1=IPv4 4 byte, 3=domain, 4=IPv6 16 byte) + port 2 byte.
  const atyp = rep[3];
  const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await readExact(socket, 1))[0] : 0;
  if (addrLen > 0) await readExact(socket, addrLen + 2);
  socket.setTimeout(0);
  socket.pause(); // hentikan mode flowing, biar tls.connect yang mengambil alih
  return socket;
}

// Parse body HTTP mentah: dukung Content-Length, chunked, dan
// Connection: close (baca sampai socket tutup).
function parseHttpResponse(raw) {
  const headEnd = raw.indexOf('\r\n\r\n');
  if (headEnd === -1) throw new Error('balasan HTTP tidak lengkap');
  const head = raw.slice(0, headEnd).toString();
  const lines = head.split('\r\n');
  const status = parseInt((lines[0].match(/HTTP\/\d\.\d (\d+)/) || [])[1] || '0', 10);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i !== -1) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let body = raw.slice(headEnd + 4);
  if ((headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
    let out = Buffer.alloc(0);
    let pos = 0;
    while (pos < body.length) {
      const eol = body.indexOf('\r\n', pos);
      if (eol === -1) break;
      const size = parseInt(body.slice(pos, eol).toString().trim(), 16);
      if (isNaN(size)) break;
      if (size === 0) break;
      out = Buffer.concat([out, body.slice(eol + 2, eol + 2 + size)]);
      pos = eol + 2 + size + 2;
    }
    body = out;
  } else if (headers['content-length']) {
    body = body.slice(0, parseInt(headers['content-length'], 10));
  }
  return { status, text: body.toString() };
}

// GET JSON lewat HTTPS, lewat proxy kalau ada (CONNECT / SOCKS5 + TLS di
// atas socket tunnel), kalau tidak ada proxy pakai fetch bawaan.
// PENTING: request HTTP ditulis manual di atas TLSSocket. Jangan pakai
// https.request({ socket: tlsSocket }) — itu membuat TLS handshake kedua
// di atas channel yang sudah terenkripsi dan gagal dengan
// "wrong version number" (teruji 21 Nov 2026).
async function httpsGetJson(url, headers, proxy) {
  if (!proxy) {
    const res = await fetch(url, { headers });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ditangani pemanggil */ }
    return { status: res.status, ok: res.ok, json, text };
  }
  const u = new URL(url);
  const port = parseInt(u.port || '443', 10);
  const raw = proxy.type === 'socks5'
    ? await connectViaSocks5(proxy, u.hostname, port)
    : await connectViaHttpProxy(proxy, u.hostname, port);
  // TLS di atas tunnel; SNI = host tujuan (bukan host proxy).
  const socket = tls.connect({ socket: raw, servername: u.hostname });
  await new Promise((resolve, reject) => {
    socket.once('secureConnect', resolve);
    socket.once('error', reject);
    socket.setTimeout(20000, () => reject(new Error('timeout TLS ke DeBank')));
  });
  socket.setTimeout(0);
  const reqLines = [`GET ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.hostname}`];
  for (const [k, v] of Object.entries(headers)) reqLines.push(`${k}: ${v}`);
  reqLines.push('Accept-Encoding: identity', 'Connection: close', '', '');
  socket.write(reqLines.join('\r\n'));
  const rawRes = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (c) => { buf = Buffer.concat([buf, c]); });
    socket.once('end', () => resolve(buf));
    socket.once('error', reject);
    socket.setTimeout(20000, () => reject(new Error('timeout request DeBank')));
  });
  socket.destroy();
  const { status, text } = parseHttpResponse(rawRes);
  let json = null;
  try { json = JSON.parse(text); } catch { /* ditangani pemanggil */ }
  return { status, ok: status >= 200 && status < 300, json, text };
}

// Baris progress untuk screen: [██████░░░░] 45% (9/20) | lolos: 3 | buang: 4 | gagal: 2 | jalan 1m23d | ETA 2m10d
function progressLine(done, total, passed, skipped, failed, startTime) {
  const pct = total === 0 ? 100 : Math.round((done / total) * 100);
  const width = 30;
  const filled = Math.round((pct / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const elapsed = Date.now() - startTime;
  const avg = done > 0 ? elapsed / done : 0;
  const eta = avg * (total - done);
  return `[${bar}] ${pct}% (${done}/${total}) | lolos: ${passed} | buang: ${skipped} | gagal: ${failed} | jalan ${formatDuration(elapsed)} | ETA ${formatDuration(eta)}`;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolveFiles() {
  const argInput = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
  const argOutput = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
  // Proxy: argumen ke-4, atau --proxy=... di mana saja.
  let argProxy = (process.argv[4] && !process.argv[4].startsWith('--proxy=')) ? process.argv[4] : '';
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--proxy=')) argProxy = a.slice('--proxy='.length);
  }

  // Proxy default: proxy.txt di folder kerja, kalau file itu ada.
  const defaultProxy = fs.existsSync(DEFAULT_PROXY_FILE) ? DEFAULT_PROXY_FILE : '';
  const defaultProxyCount = defaultProxy ? loadProxies(defaultProxy).length : 0;

  // Kalau argumen CLI diisi, pakai itu dan lewati prompt.
  if (argInput || argOutput || argProxy) {
    return {
      inputFile: argInput || 'wallets.txt',
      outputFile: argOutput || 'filtered.txt',
      proxyRaw: argProxy || process.env.PROXY || process.env.PROXY_FILE || defaultProxy,
    };
  }

  // Kalau stdin bukan terminal (misal di-pipe / dijalankan tanpa interaksi),
  // jangan nunggu prompt selamanya, pakai default / proxy.txt.
  if (!process.stdin.isTTY) {
    return {
      inputFile: 'wallets.txt',
      outputFile: 'filtered.txt',
      proxyRaw: process.env.PROXY || process.env.PROXY_FILE || defaultProxy,
    };
  }

  const input = await ask('Masukkan file: ');
  const output = await ask('Masukkan file hasil: ');
  const proxyHint = defaultProxyCount > 0 ? ` (${defaultProxyCount} proxy di proxy.txt)` : '';
  const proxy = await ask(`Masukkan proxy (opsional, kosongkan untuk pakai proxy.txt${proxyHint}): `);
  return {
    inputFile: input || 'wallets.txt',
    outputFile: output || 'filtered.txt',
    proxyRaw: proxy || process.env.PROXY || process.env.PROXY_FILE || defaultProxy,
  };
}

// Ambil total_usd_value live dari DeBank untuk satu address.
async function fetchTotalBalance(address) {
  // Mode tes saja (bukan untuk pemakaian nyata): kalau env MOCK_BALANCES
  // diisi JSON {"0xabc...": 123.45}, pakai nilai itu tanpa request jaringan.
  // Contoh: MOCK_BALANCES='{"0xd8da...":1500.5,"0x0000...":0}'
  if (process.env.MOCK_BALANCES) {
    const mock = JSON.parse(process.env.MOCK_BALANCES);
    const v = mock[address.toLowerCase()] ?? mock[address];
    if (typeof v === 'number') return v;
    return 0;
  }
  const id = encodeURIComponent(address);
  let url;
  let headers = {
    'User-Agent': 'Mozilla/5.0',
    Accept: 'application/json',
  };

  const baseUrl = (process.env.DEBANK_BASE_URL || '').replace(/\/$/, '') || null;
  if (API_KEY) {
    url = `${baseUrl || 'https://pro-openapi.debank.com/v1'}/user/total_balance?id=${id}`;
    headers.AccessKey = API_KEY;
  } else {
    url = `${baseUrl || 'https://api.debank.com'}/user/total_balance?id=${id}`;
    headers.Origin = 'https://debank.com';
    headers.Referer = `https://debank.com/profile/${address}`;
  }

  const maxTries = 5;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const proxy = nextProxy();
    let res;
    try {
      res = await httpsGetJson(url, headers, proxy);
    } catch (e) {
      // Gagal konek (proxy mati / timeout): coba proxy berikutnya.
      if (PROXIES.length > 0 && attempt < maxTries) {
        console.log(`  [${shortAddr(address)}] proxy ${proxy ? maskProxy(proxy) : '-'} error: ${e.message}, pindah proxy (${attempt}/${maxTries})...`);
        continue;
      }
      throw e;
    }
    const { status, ok, json, text } = res;

    if (ok && json && typeof json.total_usd_value === 'number') {
      return json.total_usd_value;
    }

    // 429 / 5xx: tunggu lalu coba lagi (lewat proxy berikutnya kalau ada).
    if (status === 429 || status >= 500) {
      const wait = 5000 * attempt; // 5s, 10s, 15s, 20s, 25s
      const via = proxy ? ` via ${maskProxy(proxy)}` : '';
      console.log(`  [${shortAddr(address)}] kena ${status}${via}, tunggu ${wait / 1000}s lalu retry (${attempt}/${maxTries})...`);
      await sleep(wait);
      continue;
    }

    // Error lain (mis. address tidak valid, 400, 401 tanpa API key):
    // jangan retry buta, langsung gagal dengan pesan yang jelas.
    const msg = (json && (json.error_msg || json.message)) || text.slice(0, 200);
    throw new Error(`HTTP ${status}: ${msg}`);
  }
  throw new Error('429 berulang: DeBank membatasi request, coba lagi nanti atau isi DEBANK_API_KEY');
}

async function main() {
  const { inputFile, outputFile, proxyRaw } = await resolveFiles();
  const failedFile = outputFile + '.failed.txt';

  PROXIES = loadProxies(proxyRaw);
  if (proxyRaw && PROXIES.length === 0) {
    // Kalau proxyRaw adalah file (misal proxy.txt template yang isinya
    // cuma komentar), itu bukan error — artinya tidak ada proxy aktif,
    // jalan saja tanpa proxy.
    const isFile = fs.existsSync(proxyRaw) && fs.statSync(proxyRaw).isFile();
    if (isFile) {
      console.log(`Proxy: file ${proxyRaw} tidak berisi proxy aktif, jalan tanpa proxy.`);
    } else {
      console.error('Proxy tidak bisa dibaca, cek formatnya. Contoh: http://user:pass@1.2.3.4:8080 atau socks5://1.2.3.4:1080');
      console.error('Perbaiki format proxy lalu jalankan lagi, atau kosongkan proxy untuk jalan tanpa proxy.');
      process.exit(1);
    }
  }

  if (!fs.existsSync(inputFile)) {
    console.error(`File input tidak ketemu: ${inputFile}`);
    console.error('Jalankan lagi dan masukkan nama file yang benar, atau: node filter_wallet.js wallets.txt filtered.txt');
    process.exit(1);
  }

  const lines = fs.readFileSync(inputFile, 'utf8').split(/\r?\n/);
  const wallets = [];
  const seen = new Set();
  let invalid = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|');
    if (parts.length < 3) { invalid++; console.log(`Skip baris tidak valid: ${line.slice(0, 60)}...`); continue; }
    const address = parts[1].trim();
    const pvkey = parts[2].trim();
    if (!isAddress(address) || !pvkey) { invalid++; console.log(`Skip address tidak valid: ${address}`); continue; }
    const key = address.toLowerCase();
    if (seen.has(key)) continue; // duplikat: pakai yang pertama
    seen.add(key);
    wallets.push({ address, pvkey, oldBalance: parts[0].trim() });
  }

  console.log(`Dibaca ${wallets.length} wallet dari ${inputFile} (skip ${invalid} baris tidak valid).`);
  console.log(`Batas filter: >= $${MIN_BALANCE}, jeda ${DELAY_MS}ms, API key: ${API_KEY ? 'ada' : 'tidak ada (pakai endpoint publik)'}.`);
  console.log(PROXIES.length > 0
    ? `Proxy: ${PROXIES.length} proxy, dipakai bergiliran — ${PROXIES.map(maskProxy).join(', ')}`
    : 'Proxy: tidak ada (request langsung, rawan 429 dari IP bersama).');
  console.log(`Output: ${outputFile}`);
  const estimateMs = wallets.length * (DELAY_MS + 1500);
  console.log(`Perkiraan waktu: ~${formatDuration(estimateMs)} (belum termasuk retry kalau kena 429).`);
  console.log('Mulai...\n');

  const passed = [];
  const failed = [];
  let skipped = 0;
  const startTime = Date.now();

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];

    // Spinner loading selama cek address ini (untuk screen).
    const spinnerChars = ['|', '/', '-', '\\'];
    let spin = 0;
    const spinStart = Date.now();
    const spinner = setInterval(() => {
      const c = spinnerChars[spin++ % spinnerChars.length];
      const el = formatDuration(Date.now() - spinStart);
      process.stdout.write(`\r${c} [${i + 1}/${wallets.length}] cek ${shortAddr(w.address)} ... ${el} `);
    }, 200);

    let balance;
    let error = null;
    try {
      balance = await fetchTotalBalance(w.address);
    } catch (e) {
      error = e;
    }
    clearInterval(spinner);
    // Bersihkan baris spinner sebelum tulis hasil.
    process.stdout.write('\r' + ' '.repeat(80) + '\r');

    if (error) {
      console.log(`[${i + 1}/${wallets.length}] ${w.address} ... GAGAL: ${error.message}`);
      failed.push(w);
    } else if (balance >= MIN_BALANCE) {
      passed.push({ balance, address: w.address, pvkey: w.pvkey });
      console.log(`[${i + 1}/${wallets.length}] ${w.address} ... $${formatBalance(balance)} -> LOLOS`);
    } else {
      skipped++;
      console.log(`[${i + 1}/${wallets.length}] ${w.address} ... $${formatBalance(balance)} -> buang (< $${MIN_BALANCE})`);
    }

    // Progress bar setelah tiap wallet selesai (tetap kelihatan di log screen).
    console.log(progressLine(i + 1, wallets.length, passed.length, skipped, failed.length, startTime));

    if (i < wallets.length - 1) await sleep(DELAY_MS);
  }

  // Urutkan terbesar ke terkecil, lalu tulis dengan format yang sama.
  passed.sort((a, b) => b.balance - a.balance);
  const out = passed.map((w) => `${formatBalance(w.balance)}|${w.address}|${w.pvkey}`).join('\n');
  fs.writeFileSync(outputFile, out ? out + '\n' : '');

  if (failed.length > 0) {
    const failOut = failed.map((w) => `${w.oldBalance}|${w.address}|${w.pvkey}`).join('\n');
    fs.writeFileSync(failedFile, failOut + '\n');
  } else if (fs.existsSync(failedFile)) {
    fs.unlinkSync(failedFile);
  }

  console.log(`\nSelesai dalam ${formatDuration(Date.now() - startTime)}. Lolos ${passed.length}/${wallets.length}, buang ${skipped}, gagal cek ${failed.length}.`);
  console.log(`Output: ${outputFile}`);
  if (failed.length > 0) console.log(`Yang gagal (format lama, untuk diulang): ${failedFile}`);
  if (passed.length > 0) {
    console.log(`Tertinggi: $${formatBalance(passed[0].balance)} ${passed[0].address}`);
    console.log(`Terendah lolos: $${formatBalance(passed[passed.length - 1].balance)} ${passed[passed.length - 1].address}`);
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
