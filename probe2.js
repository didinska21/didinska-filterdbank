// probe_net2.js — baca ISI data yang dimuat halaman profil DeBank.
// Jalankan di VPS:  node probe_net2.js [address]
// Kalau tanpa address, pakai wallet pertama dari wallets.txt.
// Output: isi total_net_curve, jumlah usd_value per balance_list, isi project_list.
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

// Jumlahkan semua angka di bawah key yang mengandung 'usd' (misal usd_value).
function sumUsdFields(obj) {
  let sum = 0;
  let count = 0;
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (typeof val === 'number' && /usd/i.test(k)) { sum += val; count++; }
        else walk(val);
      }
    }
  };
  walk(obj);
  return { sum, count };
}

(async () => {
  let address = process.argv[2] || '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    const line = fs.readFileSync('wallets.txt', 'utf8').split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('#'));
    address = line.split('|')[1].trim();
  }
  console.log('PROBE2 address:', address.slice(0, 8) + '...' + address.slice(-4));

  const proxy = loadFirstProxy();
  console.log('PROBE2 proxy:', proxy ? proxy.server : '(tidak ada)');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    proxy,
  });
  const page = await context.newPage();

  const bodies = {};
  page.on('response', async (res) => {
    const url = res.url();
    if (!/total_net_curve|cache_balance_list|balance_list|project_list/.test(url)) return;
    try {
      const ct = (res.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json') || res.status() !== 200) return;
      const text = await res.text();
      bodies[url] = text;
    } catch {}
  });

  try {
    await page.goto(`https://debank.com/profile/${address}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('PROBE2: halaman dimuat, tunggu data termuat (30 detik)...');
    try {
      await page.waitForFunction(() => /Data updated/i.test(document.body.innerText || ''), { timeout: 30000 });
    } catch {}
    await sleep(15000);
  } catch (e) {
    console.log('PROBE2 GAGAL buka halaman:', e.message.split('\n')[0]);
  } finally {
    console.log('=== ISI DATA HALAMAN ===');
    let grandTotal = 0;
    for (const [url, body] of Object.entries(bodies)) {
      console.log('\n--- URL:', url);
      console.log('panjang body:', body.length, 'karakter');
      if (/total_net_curve/.test(url)) {
        console.log('ISI LENGKAP total_net_curve:');
        console.log(body);
      } else if (/balance_list/.test(url)) {
        let j = null;
        try { j = JSON.parse(body); } catch {}
        if (j) {
          const arr = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : []);
          const { sum, count } = sumUsdFields(j);
          console.log(`token di body: ${arr.length}, jumlah field usd: ${count}, JUMLAH usd_value: ${sum}`);
          grandTotal += sum;
        }
        console.log('potongan body:', body.slice(0, 400));
      } else if (/project_list/.test(url)) {
        let j = null;
        try { j = JSON.parse(body); } catch {}
        if (j) {
          const { sum, count } = sumUsdFields(j);
          console.log(`jumlah field usd: ${count}, JUMLAH usd_value: ${sum}`);
          grandTotal += sum;
        }
        console.log('potongan body:', body.slice(0, 400));
      } else {
        console.log('potongan body:', body.slice(0, 400));
      }
    }
    console.log('\n=== TOTAL JUMLAH (balance_list semua chain + project_list):', grandTotal, '===');
    console.log('=== (Bandingkan dengan total di layar, tadi $1) ===');
    await browser.close();
  }
})().catch((e) => { console.error('Error:', e.message); process.exit(1); });
