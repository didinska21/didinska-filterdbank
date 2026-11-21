#!/usr/bin/env node
/**
 * filter_wallet_browser.js — Filter wallet lewat WEB DeBank (bukan API langsung).
 *
 * Alur (pakai Chromium headless via Playwright):
 *   1. Baca file wallet (balance|address|pvkey), baris kosong dilewati.
 *   2. Buka Chromium headless, buka halaman https://debank.com/profile/<address>
 *      satu wallet satu halaman, seperti membuka web DeBank di browser.
 *   3. Tunggu tulisan "Net Worth" muncul di halaman, lalu baca angka
 *      balance yang tampil di layar itu (bukan manggil API dari script).
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
 *   - Fallback: kalau angka di layar tidak terbaca, script memakai data
 *     yang halaman itu sendiri minta saat dimuat (bukan request API
 *     dari script). Kalau halaman menampilkan verifikasi bot, wallet
 *     itu dicatat gagal di <output>.failed.txt, bukan diam-diam hilang.
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

// Ambil angka "$1,234.56" pertama yang muncul setelah tulisan "Net Worth".
function parseNetWorthFromText(text) {
  const idx = text.search(/net worth/i);
  if (idx === -1) return null;
  const after = text.slice(idx, idx + 300);
  const m = after.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ''));
  return isNaN(v) ? null : v;
}

async function readBalanceFromPage(page, address) {
  const url = `${PROFILE_BASE_URL}/${address}`;

  // Fallback: tangkap data yang halaman itu sendiri minta saat dimuat.
  // Dipakai hanya kalau angka di layar tidak terbaca.
  let pageData = null;
  const onResponse = async (res) => {
    try {
      if (res.url().includes('/user/total_balance') && res.status() === 200) {
        const json = await res.json();
        if (json && typeof json.total_usd_value === 'number') pageData = json.total_usd_value;
      }
    } catch { /* abaikan */ }
  };
  page.on('response', onResponse);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Deteksi halaman verifikasi bot / blokir.
    const earlyText = (await page.evaluate(() => document.body.innerText || '')).slice(0, 2000);
    if (/verify you are human|attention required|are you a robot|just a moment/i.test(earlyText)) {
      throw new Error('DeBank menampilkan verifikasi bot (Cloudflare)');
    }

    // Tunggu tulisan "Net Worth" muncul (halaman SPA, balance dimuat belakangan).
    try {
      await page.getByText(/net worth/i).first().waitFor({ timeout: 30000 });
    } catch {
      // Lanjut ke pembacaan teks, mungkin labelnya sudah ada tapi beda ejaan.
    }
    await page.waitForTimeout(2000); // beri waktu angka-nya ter-render

    const text = await page.evaluate(() => document.body.innerText || '');
    if (/verify you are human|attention required|are you a robot|just a moment/i.test(text.slice(0, 2000))) {
      throw new Error('DeBank menampilkan verifikasi bot (Cloudflare)');
    }
    const fromScreen = parseNetWorthFromText(text);
    if (fromScreen !== null) return fromScreen;

    // Fallback: data yang halaman itu sendiri minta.
    if (pageData !== null) return pageData;

    throw new Error('angka Net Worth tidak ketemu di halaman (layout DeBank mungkin berubah)');
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
  console.log(`Mode: Chromium headless buka ${PROFILE_BASE_URL}/<address>, baca Net Worth dari layar.`);
  console.log(`Batas filter: >= $${MIN_BALANCE}, jeda ${DELAY_MS}ms.`);
  console.log(PROXIES.length > 0
    ? `Proxy: ${PROXIES.length} proxy, dipakai bergiliran — ${PROXIES.map(maskProxy).join(', ')}`
    : 'Proxy: tidak ada (request langsung dari IP VPS).');
  console.log(`Output: ${outputFile}`);
  const estimateMs = wallets.length * (DELAY_MS + 8000);
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
      } else if (balance < MIN_BALANCE) {
        skipped++;
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
        console.log(`[${i + 1}/${wallets.length}] ${shortAddr(w.address)} ... $${formatBalance(balance)} -> buang (< $${MIN_BALANCE})`);
      } else {
        passed.push({ ...w, balance });
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
        console.log(`[${i + 1}/${wallets.length}] ${shortAddr(w.address)} ... $${formatBalance(balance)} -> LOLOS`);
      }

      const elapsed = Date.now() - startTime;
      const done = i + 1;
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
