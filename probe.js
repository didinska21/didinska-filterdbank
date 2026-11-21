// probe_net.js — cari tahu dari mana halaman profil DeBank memuat total balance.
// Jalankan di VPS:  node probe_net.js [address]
// Kalau tanpa address, pakai wallet pertama dari wallets.txt.
// Output: semua request halaman + JSON yang berisi total_usd_value + teks halaman.
// Hanya membaca (tidak mengubah apa pun). Private key TIDAK dibaca/dikirim.
const fs = require('fs');
const { chromium } = require('playwright');

function parseProxy(raw) {
  let s = (raw || '').trim();
  if (!s || s.startsWith('#')) return null;
  let type = 'http';
  const m = s.match(/^(https?|socks5?|socks):\/\//i);
  if (m) { type = m[1].toLowerCase().startsWith('socks') ? 'socks5' : m[1].toLowerCase(); s = s.slice(m[0].length); }
  let auth = null;
  const at = s.lastIndexOf('@');
  if (at !== -1) { auth = s.slice(0, at); s = s.slice(at + 1); }
  const parts = s.split(':');
  if (parts.length === 4 && /^\d+$/.test(parts[1])) {
    if (!auth) auth = `${parts[2]}:${parts[3]}`;
    s = parts[0] + ':' + parts[1];
  }
  const hp = s.split(':');
  if (hp.length !== 2 || !hp[0] || !/^\d+$/.test(hp[1])) return null;
  const proxy = { server: `${type}://${hp[0]}:${hp[1]}` };
  if (auth && auth.includes(':')) {
    const i = auth.indexOf(':');
    proxy.username = auth.slice(0, i);
    proxy.password = auth.slice(i + 1);
  }
  return proxy;
}

function loadFirstProxy() {
  if (!fs.existsSync('proxy.txt')) return undefined;
  for (const line of fs.readFileSync('proxy.txt', 'utf8').split(/\r?\n/)) {
    const p = parseProxy(line);
    if (p) return p;
  }
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let address = process.argv[2] || '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    const line = fs.readFileSync('wallets.txt', 'utf8').split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'));
    address = line.split('|')[1].trim();
  }
  console.log('PROBE address:', address.slice(0, 8) + '...' + address.slice(-4));

  const proxy = loadFirstProxy();
  console.log('PROBE proxy:', proxy ? proxy.server : '(tidak ada)');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    proxy,
  });
  const page = await context.newPage();

  const seen = [];
  page.on('response', async (res) => {
    const url = res.url();
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    seen.push({ url, status: res.status(), ct });
    try {
      if (ct.includes('json') && res.status() === 200) {
        const body = await res.text();
        if (body.includes('total_usd_value')) {
          let val = null;
          try { const j = JSON.parse(body); if (typeof j.total_usd_value === 'number') val = j.total_usd_value; } catch {}
          console.log('>>> JSON DENGAN total_usd_value:', url, '=> total_usd_value =', val);
          console.log('    potongan body:', body.slice(0, 300));
        }
      }
    } catch {}
  });

  try {
    await page.goto(`https://debank.com/profile/${address}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('PROBE: halaman domcontentloaded, tunggu data termuat (30 detik)...');
    try {
      await page.waitForFunction(() => /Data updated/i.test(document.body.innerText || ''), { timeout: 30000 });
      console.log('PROBE: teks "Data updated" muncul.');
    } catch { console.log('PROBE: teks "Data updated" TIDAK muncul dalam 30 detik.'); }
    await sleep(15000); // beri waktu semua chain selesai dimuat
    const text = await page.evaluate(() => document.body.innerText || '');
    console.log('=== TEKS HALAMAN (lengkap) ===');
    console.log(text);
    console.log('=== AKHIR TEKS ===');
  } catch (e) {
    console.log('PROBE GAGAL buka halaman:', e.message.split('\n')[0]);
  } finally {
    console.log('=== SEMUA REQUEST (yang mengandung balance/total/portfolio/user) ===');
    for (const r of seen) {
      if (/balance|total|portfolio|user/i.test(r.url)) console.log(r.status, r.ct, r.url);
    }
    console.log('=== JUMLAH REQUEST TERCATAT:', seen.length, '===');
    await browser.close();
  }
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
