#!/usr/bin/env node
/**
 * filter_wallet_browser.js — Filter wallet lewat WEB DeBank (bukan API langsung).
 *
 * Alur (pakai Chromium headless via Playwright):
 *   1. Baca file wallet (balance|address|pvkey), baris kosong dilewati.
 *   2. Buka Chromium headless, buka halaman https://debank.com/profile/<address>
 *      satu wallet satu halaman, seperti membuka web DeBank di browser.
 *   3. Tunggu data profil termuat, lalu baca angka total yang tampil
 *      di layar itu (total di kanan atas, diikuti persentase perubahan,
 *      misal "$1" lalu "-10.62%"). Label "Net Worth" tidak ada di
 *      halaman DeBank saat ini, jadi script tidak mencari label itu.
 *   4. Update balance -> buang yang < $0.20 -> urutkan terbesar ke terkecil
 *      -> tulis ke file hasil dengan format SAMA: balance|address|pvkey.
 *
 * Catatan jujur (teruji 21 Nov 2026):
 *   - Halaman DeBank itu SPA: balance di layar dimuat halaman itu sendiri
 *     dari backend DeBank. Jadi kalau backend-nya membatasi (429),
 *     versi web ini kena juga — buka web tidak menghilangkan 429.
 *   - Versi ini juga lebih lambat & lebih berat daripada versi API
 *     (tiap wallet = satu halaman web yang di-render), dan DeBank bisa
 *     menampilkan verifikasi bot (Cloudflare) ke browser otomatis.
 *   - PRESISI (diperbaiki 21 Nov 2026, dari hasil probe_net.js):
 *     angka layar dibulatkan ke dolar penuh ("$1", tanpa sen), jadi
 *     TIDAK dipakai sebagai sumber utama. Total presisi diambil dari
 *     data JSON yang halaman itu sendiri muat saat dibuka:
 *       total = jumlah balance_list tiap chain (token: usd_value,
 *               atau amount*price kalau usd_value tidak ada)
 *             + jumlah project_list (DeFi: stats.net_usd_value
 *               per portfolio item SAJA — asset/debt jangan ikut
 *               dijumlah, itu hitung ganda)
 *     total_net_curve (titik terakhir) dipakai sebagai pembanding /
 *     cadangan kalau penjumlahan di atas tidak ketemu. cache_balance_list
 *     dipakai hanya kalau tidak ada satu pun balance_list per chain.
 *     Angka layar hanya cadangan terakhir, dan dicatat sumbernya di log
 *     tiap wallet, misal "presisi: token $0.60 + DeFi $0.00 = $0.60".
 *     Perhatian: jangan jumlahkan SEMUA field bernama *usd* secara
 *     rekursif — balance_list yang punya total_usd_value di atas plus
 *     usd_value per token akan terhitung ganda (teruji: $0.60 jadi $1.20).
 *   - Kalau halaman menampilkan verifikasi bot, wallet itu dicatat
 *     gagal di <output>.failed.txt, bukan diam-diam hilang.
 *   - Hasil disimpan bertahap: setelah tiap wallet selesai dicek,
 *     file hasil dan file .failed.txt langsung ditulis ulang. Jadi
 *     kalau run 5 jam ini di-stop (Ctrl+C) atau screen/VPS mati di
 *     tengah jalan, hasil wallet yang sudah dicek tidak hilang —
 *     tinggal lanjutkan dari file .failed.txt saja.
 *
 * Cara pakai:
 *   npm install            (sekali saja, menginstal Playwright)
 *   npx playwright install chromium   (sekali saja, mengunduh Chromium)
 *   npm run browser
 *   atau: node filter_wallet_browser.js wallets.txt filtered.txt
 *
 * Proxy: sama seperti versi API — isi proxy.txt (satu per baris,
 * http / https / socks5), kosongkan prompt untuk pakai proxy.txt.
 * Tiap wallet dibuka lewat proxy berikutnya (round-robin); untuk
 * rotating gateway, IP keluar ganti-ganti di sisi proxy.
 *
 * Env (opsional):
 *   MIN_BALANCE      default 0.2  (dolar)
 *   DELAY_MS         jeda antar wallet, default 2000 ms.
 *   DEBANK_PROFILE_BASE_URL   khusus tes: ganti alamat halaman profil
 *                    (default https://debank.com/profile).
 *
 * Butuh Node.js 18+ dan Chromium yang diunduh Playwright.
 */

const fs = require('fs');
const readline = require('readline');
const { chromium } = require('playwright');

const MIN_BALANCE = parseFloat(process.env.MIN_BALANCE || '0.2');
const DELAY_MS = parseInt(process.env.DELAY_MS || '2000', 10);
const PROFILE_BASE_URL = (process.env.DEBANK_PROFILE_BASE_URL || 'https://debank.com/profile').replace(/\/$/, '');
const DEFAULT_PROXY_FILE = 'proxy.txt';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatBalance(v) {
  return Number(v).toFixed(2);
}

function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a || '');
}

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
// Proxy: parse & daftar (format sama seperti filter_wallet.js).
// ---------------------------------------------------------------------------

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
  const parts = s.split(':');
  if (parts.length === 4 && /^\d+$/.test(parts[1])) {
    if (!auth) auth = { user: parts[2], pass: parts[3] };
    s = parts[0] + ':' + parts[1];
  }
  const hostPort = s.split(':');
  if (hostPort.length !== 2 || !hostPort[0] || !/^\d+$/.test(hostPort[1])) return null;
  return { type, host: hostPort[0], port: parseInt(hostPort[1], 10), auth };
}

function maskProxy(p) {
  const auth = p.auth ? '***@' : '';
  return `${p.type}://${auth}${p.host}:${p.port}`;
}

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

let PROXIES = [];
let proxyIndex = 0;
function nextProxy() {
  if (PROXIES.length === 0) return null;
  const p = PROXIES[proxyIndex % PROXIES.length];
  proxyIndex++;
  return p;
}

// Proxy Playwright: { server, username, password }.
function toPlaywrightProxy(p) {
  if (!p) return undefined;
  const proxy = { server: `${p.type}://${p.host}:${p.port}` };
  if (p.auth) { proxy.username = p.auth.user; proxy.password = p.auth.pass; }
  return proxy;
}

// ---------------------------------------------------------------------------
// Input / prompt (sama seperti filter_wallet.js).
// ---------------------------------------------------------------------------

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
  let argProxy = (process.argv[4] && !process.argv[4].startsWith('--proxy=')) ? process.argv[4] : '';
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--proxy=')) argProxy = a.slice('--proxy='.length);
  }

  const defaultProxy = fs.existsSync(DEFAULT_PROXY_FILE) ? DEFAULT_PROXY_FILE : '';
  const defaultProxyCount = defaultProxy ? loadProxies(defaultProxy).length : 0;

  if (argInput || argOutput || argProxy) {
    return {
      inputFile: argInput || 'wallets.txt',
      outputFile: argOutput || 'filtered.txt',
      proxyRaw: argProxy || process.env.PROXY || process.env.PROXY_FILE || defaultProxy,
    };
  }

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

// ---------------------------------------------------------------------------
// Baca balance dari HALAMAN web yang sudah dibuka di Chromium.
// ---------------------------------------------------------------------------

// Baca total balance dari teks halaman profil DeBank (layout nyata, 21 Nov 2026).
// Teks halaman (dari atas): alamat wallet, lalu "This user has not added a
// bio yet", lalu total "$1", lalu perubahan "-10.62%". Label "Net Worth"
// TIDAK ada di halaman ini, jadi jangan cari label itu.
// Urutan pola yang dicoba (yang pertama cocok dipakai):
//   1. "$X" yang langsung diikuti persentase perubahan ("$1" + "-10.62%")
//      -> total di kanan atas halaman.
//   2. "$X" setelah "has not added a bio yet".
//   3. "Net Worth" + "$X" (jaga-jaga kalau layout berubah lagi).
//   4. "$X" setelah judul bagian "Wallet".
// Perhatian: angka yang tampil di layar dibulatkan ke dolar penuh ("$1",
// tanpa sen). Jadi nilai dari layar ini KASAR dan hanya dipakai sebagai
// jalan terakhir — nilai persisnya diambil dari data halaman (lihat
// readBalanceFromPage). Ambang $0.20 tidak bisa diandalkan dari angka layar:
// wallet $0.30 bisa tampil "$0" dan wallet $0.15 bisa tampil "$1".
function parseTotalFromText(text) {
  const money = (s) => {
    const v = parseFloat(s.replace(/,/g, ''));
    return isNaN(v) ? null : v;
  };
  // 1. Total + persentase: "$1\n-10.62%" atau "$1,234\n+2.50%".
  let m = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)\s*\n?\s*-?\+?\d+\.\d+%/);
  if (m) return money(m[1]);
  // 2. Setelah baris bio.
  m = text.match(/has not added a bio yet\s*\n?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (m) return money(m[1]);
  // 3. Label Net Worth (kalau muncul lagi di layout lain).
  const idx = text.search(/net worth/i);
  if (idx !== -1) {
    m = text.slice(idx, idx + 300).match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    if (m) return money(m[1]);
  }
  // 4. Bagian Wallet.
  m = text.match(/Wallet\s*\n\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (m) return money(m[1]);
  return null;
}

// ---------------------------------------------------------------------------
// Total PRESISI dari data JSON yang halaman itu sendiri muat.
// (Hasil probe_net.js 21 Nov 2026: halaman memanggil total_net_curve,
// balance_list per chain, project_list, dan cache_balance_list —
// TIDAK PERNAH memanggil /user/total_balance, jadi fallback lama itu
// tidak pernah ketangkap dan yang kepakai selalu angka layar yang bulat.)
// ---------------------------------------------------------------------------
function _num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

// total_net_curve -> titik terakhir kurva (total saat ini).
function parseTotalNetCurve(j) {
  const pickLast = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const last = arr[arr.length - 1];
    if (Array.isArray(last)) return _num(last[1]);
    if (last && typeof last === 'object') {
      return _num(last.usd_value) ?? _num(last.total_usd_value) ?? _num(last.value);
    }
    return _num(last);
  };
  if (!j || typeof j !== 'object') return null;
  if (j.data && typeof j.data === 'object' && !Array.isArray(j.data)) {
    const v = pickLast(j.data.usd_value_list) ?? pickLast(j.data.data);
    if (v !== null) return v;
  }
  return pickLast(j.data) ?? pickLast(j.usd_value_list) ?? (Array.isArray(j) ? pickLast(j) : null);
}

// balance_list satu chain -> { total, tokens }.
// Kalau ada total_usd_value di atas, pakai itu; kalau tidak, jumlahkan
// usd_value per token (atau amount*price). JANGAN jumlahkan keduanya.
function parseBalanceList(j) {
  if (!j || typeof j !== 'object') return null;
  const tokens = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : null);
  if (!tokens) return null;
  if (_num(j.total_usd_value) !== null) return { total: j.total_usd_value, tokens: tokens.length };
  let total = 0;
  for (const t of tokens) {
    if (!t || typeof t !== 'object') continue;
    if (_num(t.usd_value) !== null) total += t.usd_value;
    else if (_num(t.amount) !== null && _num(t.price) !== null) total += t.amount * t.price;
  }
  return { total, tokens: tokens.length };
}

// project_list (DeFi) -> { total, items }.
// HANYA stats.net_usd_value per portfolio item. asset_usd_value dan
// debt_usd_value adalah komponen net, menjumlah semuanya = hitung ganda.
function parseProjectList(j) {
  if (!j || typeof j !== 'object') return null;
  const protocols = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : null);
  if (!protocols) return null;
  let total = 0, items = 0;
  for (const p of protocols) {
    const list = p && Array.isArray(p.portfolio_item_list) ? p.portfolio_item_list : [];
    for (const it of list) {
      const s = it && it.stats ? it.stats : null;
      if (!s) continue;
      items++;
      if (_num(s.net_usd_value) !== null) total += s.net_usd_value;
      else if (_num(s.asset_usd_value) !== null) total += s.asset_usd_value - (_num(s.debt_usd_value) || 0);
    }
  }
  return { total, items };
}

async function readBalanceFromPage(page, address) {
  const url = `${PROFILE_BASE_URL}/${address}`;

  // Tangkap data JSON yang halaman itu sendiri muat saat dibuka.
  const captured = { curve: null, perChain: new Map(), project: null, cache: null };
  const onResponse = async (res) => {
    try {
      const u = res.url();
      if (res.status() !== 200) return;
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      if (u.includes('/asset/total_net_curve')) {
        captured.curve = parseTotalNetCurve(await res.json());
      } else if (u.includes('/token/balance_list')) {
        const chain = (u.match(/[?&]chain=([^&]+)/) || [])[1] || 'unknown';
        const parsed = parseBalanceList(await res.json());
        if (parsed) captured.perChain.set(chain, parsed);
      } else if (u.includes('/portfolio/project_list')) {
        captured.project = parseProjectList(await res.json());
      } else if (u.includes('/token/cache_balance_list')) {
        captured.cache = parseBalanceList(await res.json());
      }
    } catch { /* abaikan: satu response gagal dibaca bukan alasan gagal total */ }
  };
  page.on('response', onResponse);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Deteksi halaman verifikasi bot / blokir.
    const earlyText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 2000);
    if (/verify you are human|attention required|are you a robot|just a moment/i.test(earlyText)) {
      throw new Error('DeBank menampilkan verifikasi bot (Cloudflare)');
    }

    // Tunggu data profil termuat, lalu beri waktu semua chain selesai
    // dimuat (balance_list datang per chain, belakangan).
    try {
      await page.waitForFunction(() => {
        const t = document.body.innerText || '';
        return /Data updated/i.test(t) || /\$\s*[\d,]+\s*\n?\s*-?\+?\d+\.\d+%/.test(t);
      }, { timeout: 30000 });
    } catch {
      // Lanjut ke pembacaan, mungkin tandanya sudah ada tapi beda ejaan.
    }
    await page.waitForTimeout(5000); // balance_list per chain + project_list

    const text = await page.evaluate(() => document.body.innerText || '');
    if (/verify you are human|attention required|are you a robot|just a moment/i.test(text.slice(0, 2000))) {
      throw new Error('DeBank menampilkan verifikasi bot (Cloudflare)');
    }

    // 1. Total presisi = token semua chain + DeFi.
    let tokenTotal = null, tokenDetail = '';
    if (captured.perChain.size > 0) {
      tokenTotal = 0;
      const parts = [];
      for (const [chain, p] of captured.perChain) {
        tokenTotal += p.total;
        parts.push(`${chain} $${p.total.toFixed(2)}`);
      }
      tokenDetail = parts.join(' + ');
    } else if (captured.cache) {
      tokenTotal = captured.cache.total;
      tokenDetail = `cache ${captured.cache.tokens} token`;
    }
    const defiTotal = captured.project ? captured.project.total : null;
    if (tokenTotal !== null) {
      const total = tokenTotal + (defiTotal || 0);
      let detail = `token $${tokenTotal.toFixed(2)} (${tokenDetail}) + DeFi $${(defiTotal || 0).toFixed(2)}`;
      if (captured.curve !== null && Math.abs(captured.curve - total) > Math.max(0.05, total * 0.1)) {
        detail += ` [curve $${captured.curve.toFixed(2)} beda, cek manual]`;
      }
      return { value: total, source: 'presisi', detail };
    }

    // 2. Cadangan: titik terakhir total_net_curve.
    if (captured.curve !== null) {
      return { value: captured.curve, source: 'curve', detail: `total_net_curve $${captured.curve.toFixed(2)}` };
    }

    // 3. Cadangan terakhir: angka layar (DIBULATKAN ke dolar penuh).
    const fromScreen = parseTotalFromText(text);
    if (fromScreen !== null) {
      return { value: fromScreen, source: 'layar-bulat', detail: `layar $${fromScreen.toFixed(2)} (bulat, kurang presisi)` };
    }

    throw new Error('total balance tidak ketemu di halaman (layout DeBank mungkin berubah)');
  } finally {
    page.off('response', onResponse);
  }
}

// Buka satu wallet di Chromium, dengan retry. Tiap percobaan pakai
// context baru (proxy berikutnya kalau ada).
async function fetchBalanceViaBrowser(browser, address) {
  const maxTries = 3;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const proxy = nextProxy();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      proxy: toPlaywrightProxy(proxy),
    });
    const page = await context.newPage();
    try {
      const value = await readBalanceFromPage(page, address);
      await context.close();
      return value;
    } catch (e) {
      await context.close().catch(() => {});
      const via = proxy ? ` via ${maskProxy(proxy)}` : '';
      console.log(`  [${shortAddr(address)}] gagal${via}: ${e.message} (${attempt}/${maxTries})...`);
      if (attempt < maxTries) await sleep(5000 * attempt);
    }
  }
  throw new Error('gagal baca balance dari halaman DeBank setelah 3 percobaan');
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  const { inputFile, outputFile, proxyRaw } = await resolveFiles();
  const failedFile = outputFile + '.failed.txt';

  PROXIES = loadProxies(proxyRaw);
  if (proxyRaw && PROXIES.length === 0) {
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
    console.error('Jalankan lagi dan masukkan nama file yang benar, atau: node filter_wallet_browser.js wallets.txt filtered.txt');
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
    if (seen.has(key)) continue;
    seen.add(key);
    wallets.push({ address, pvkey, oldBalance: parts[0].trim() });
  }

  console.log(`Dibaca ${wallets.length} wallet dari ${inputFile} (skip ${invalid} baris tidak valid).`);
  console.log(`Mode: Chromium headless buka ${PROFILE_BASE_URL}/<address>, baca total PRESISI dari data JSON halaman (token semua chain + DeFi), bukan angka layar yang bulat.`);
  console.log(`Batas filter: >= $${MIN_BALANCE}, jeda ${DELAY_MS}ms.`);
  console.log(PROXIES.length > 0
    ? `Proxy: ${PROXIES.length} proxy, dipakai bergiliran — ${PROXIES.map(maskProxy).join(', ')}`
    : 'Proxy: tidak ada (request langsung dari IP VPS).');
  console.log(`Output: ${outputFile}`);
  const estimateMs = wallets.length * (DELAY_MS + 13000);
  console.log(`Perkiraan waktu: ~${formatDuration(estimateMs)} (buka web lebih lambat dari API).`);
  console.log('Mulai...\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const passed = [];
  const failed = [];
  let skipped = 0;
  const startTime = Date.now();

  // Simpan bertahap: tulis ulang file hasil (lolos, urut terbesar ke
  // terkecil) dan file gagal setiap kali satu wallet selesai dicek,
  // supaya hasil tidak hilang kalau run panjang ini terputus di tengah.
  function saveProgress(outputFile, failedFile, passed, failed) {
    const sorted = [...passed].sort((a, b) => b.balance - a.balance);
    const out = sorted.map((w) => `${formatBalance(w.balance)}|${w.address}|${w.pvkey}`).join('\n');
    fs.writeFileSync(outputFile, out ? out + '\n' : '');
    if (failed.length > 0) {
      fs.writeFileSync(failedFile, failed.map((w) => `${w.oldBalance}|${w.address}|${w.pvkey}`).join('\n') + '\n');
    }
  }
  const frames = ['|', '/', '-', '\\'];
  let frame = 0;

  try {
    for (let i = 0; i < wallets.length; i++) {
      const w = wallets[i];
      const spinner = setInterval(() => {
        process.stdout.write(`\r${frames[frame++ % frames.length]} [${i + 1}/${wallets.length}] buka web ${shortAddr(w.address)} ...`);
      }, 120);

      let balance;
      try {
        balance = await fetchBalanceViaBrowser(browser, w.address);
      } catch (e) {
        clearInterval(spinner);
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
        console.log(`[${i + 1}/${wallets.length}] ${shortAddr(w.address)} ... GAGAL: ${e.message}`);
        failed.push(w);
      } finally {
        clearInterval(spinner);
      }

      if (balance === undefined) {
        // Sudah dicatat gagal di atas, lanjut ke wallet berikutnya.
      } else if (balance.value < MIN_BALANCE) {
        skipped++;
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
        console.log(`[${i + 1}/${wallets.length}] ${shortAddr(w.address)} ... $${formatBalance(balance.value)} -> buang (< $${MIN_BALANCE}) [${balance.source}: ${balance.detail}]`);
      } else {
        passed.push({ ...w, balance: balance.value });
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
        console.log(`[${i + 1}/${wallets.length}] ${shortAddr(w.address)} ... $${formatBalance(balance.value)} -> LOLOS [${balance.source}: ${balance.detail}]`);
      }

      const elapsed = Date.now() - startTime;
      const done = i + 1;
      saveProgress(outputFile, failedFile, passed, failed);
      const pct = Math.round((done / wallets.length) * 100);
      const barLen = 30;
      const filled = Math.round((done / wallets.length) * barLen);
      const eta = done > 0 ? Math.round((elapsed / done) * (wallets.length - done)) : 0;
      console.log(`[${'█'.repeat(filled)}${'░'.repeat(barLen - filled)}] ${pct}% (${done}/${wallets.length}) | lolos: ${passed.length} | buang: ${skipped} | gagal: ${failed.length} | jalan ${formatDuration(elapsed)} | ETA ${formatDuration(eta)}`);

      if (i < wallets.length - 1) await sleep(DELAY_MS);
    }
  } finally {
    await browser.close();
  }

  passed.sort((a, b) => b.balance - a.balance);
  const out = passed.map((w) => `${formatBalance(w.balance)}|${w.address}|${w.pvkey}`).join('\n');
  fs.writeFileSync(outputFile, out ? out + '\n' : '');
  if (failed.length > 0) {
    fs.writeFileSync(failedFile, failed.map((w) => `${w.oldBalance}|${w.address}|${w.pvkey}`).join('\n') + '\n');
  }

  const total = Date.now() - startTime;
  console.log(`\nSelesai dalam ${formatDuration(total)}. Lolos ${passed.length}/${wallets.length}, buang ${skipped}, gagal baca ${failed.length}.`);
  console.log(`Output: ${outputFile}`);
  if (failed.length > 0) console.log(`Yang gagal ada di: ${failedFile} (bisa diulang nanti)`);
  if (passed.length > 0) {
    console.log(`Tertinggi: $${formatBalance(passed[0].balance)} ${passed[0].address}`);
    console.log(`Terendah lolos: $${formatBalance(passed[passed.length - 1].balance)} ${passed[passed.length - 1].address}`);
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
