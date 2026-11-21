# Filter Wallet — DeBank Live

Script Node.js (tanpa dependency, butuh Node 18+) untuk memfilter daftar wallet berdasarkan balance live DeBank.

## Input

File teks, satu wallet per baris:

```
balance|address|pvkey
```

Contoh:

```
0.00|0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045|0x1111111111111111111111111111111111111111111111111111111111111111
```

Balance lama diabaikan — hanya address (kolom ke-2) yang dipakai untuk cek live. `pvkey` tidak pernah dikirim ke DeBank dan tidak pernah di-log.

## Cara pakai

Mode interaktif (untuk VPS + screen):

```bash
node filter_wallet.js
Masukkan file: wallets.txt
Masukkan file hasil: filtered.txt
```

Kosongkan saja untuk pakai default `wallets.txt` dan `filtered.txt`.

Mode argumen (prompt dilewati, untuk otomatisasi):

```bash
node filter_wallet.js wallets.txt filtered.txt
```

- `wallets.txt` = file input kamu
- `filtered.txt` = hasil

## Proxy (biar aman, tidak kena 429 dari satu IP)

Script sudah mendukung proxy HTTP, HTTPS, dan SOCKS5, tanpa dependency. Request ke DeBank jalan lewat tunnel CONNECT (HTTP/HTTPS) atau SOCKS5 + TLS, dan proxy dipakai bergiliran (round-robin) — tiap wallet dicek lewat proxy berikutnya. Kalau satu proxy mati atau kena 429, percobaan berikutnya pindah ke proxy lain.

Cara yang disarankan: isi `proxy.txt` di folder yang sama, satu proxy per baris, lalu jalankan `node filter_wallet.js` dan kosongkan prompt proxy untuk pakai file itu. Template `proxy.txt` sudah dibuatkan, isinya contoh semua format:

```
# http://user:pass@1.2.3.4:8080
# https://user:pass@1.2.3.4:8080
# socks5://user:pass@1.2.3.4:1080
```

Hapus tanda `#` di depan proxy yang mau dipakai, lalu isi dengan proxy asli kamu. Baris `#` diabaikan, jadi file template yang masih kosong tetap jalan tanpa proxy.

Cara isi proxy lainnya, pilih salah satu:

1. Saat prompt interaktif, di pertanyaan ketiga:
   ```
   Masukkan proxy (opsional, kosongkan untuk pakai proxy.txt): http://user:pass@1.2.3.4:8080
   ```
2. Argumen CLI:
   ```bash
   node filter_wallet.js wallets.txt filtered.txt --proxy=http://user:pass@1.2.3.4:8080
   node filter_wallet.js wallets.txt filtered.txt proxy.txt
   ```
3. Env `PROXY` (satu proxy / daftar dipisah koma) atau `PROXY_FILE` (path file).

Format proxy yang diterima:

```
http://user:pass@host:port
https://user:pass@host:port
socks5://user:pass@host:port
user:pass@host:port
host:port
host:port:user:pass
```

Password proxy tidak pernah di-log apa adanya — di log cuma tampil `***@host:port`. Jangan kirim proxy ber-password lewat chat; isi langsung di VPS (file `proxy.txt` atau env var).

Catatan: di VPS biasa proxy HTTP/SOCKS5 jalan normal. Di mesin ini (VM Muse) koneksi TLS langsung ke DeBank diblokir jaringan, jadi tes live ke DeBank lewat proxy di sini gagal — tapi jalur proxy-nya sudah teruji end-to-end di sini melawan server HTTPS lokal: CONNECT tercatat di proxy, TLS berhasil, dan balance terbaca dengan benar.

## Loading di screen

Prosesnya memang lama karena cek satu-satu ke DeBank. Selama jalan kamu akan lihat:

- spinner berputar (`| / - \`) saat tiap address dicek
- progress bar + persen + hitungan lolos / buang / gagal
- waktu berjalan + perkiraan sisa (ETA), plus perkiraan total waktu di awal

Contoh di screen:

```
[██████████░░░░░░░░░░░░░░░░░░░░] 33% (1/3) | lolos: 1 | buang: 0 | gagal: 0 | jalan 4d | ETA 8d
```

Jalankan di screen seperti biasa, misal `screen -S filter`, lalu `node filter_wallet.js`, lalu lepas dengan `Ctrl+A D`. Balik lagi dengan `screen -r filter`.

Yang disimpan di hasil:

- Balance sudah di-update ke total USD live dari DeBank (`total_usd_value`)
- Yang di bawah **$0.20 dibuang**
- Diurutkan **terbesar ke terkecil**
- Format tetap sama: `balance|address|pvkey`, balance 2 desimal

Yang gagal dicek (misal kena rate-limit) tidak hilang diam-diam — dicatat di `filtered.txt.failed.txt` dengan format lama, supaya bisa diulang.

## Pengaturan (opsional, via env)

```bash
MIN_BALANCE=0.2 DELAY_MS=2000 node filter_wallet.js wallets.txt filtered.txt
```

- `MIN_BALANCE` — batas minimal, default `0.2`
- `DELAY_MS` — jeda antar request, default `2000`. Naikkan (misal `5000`) kalau sering kena 429.
- `DEBANK_API_KEY` — kalau punya API key DeBank Cloud, isi ini. Script akan pakai endpoint resmi `pro-openapi.debank.com/v1/user/total_balance` (header `AccessKey`), yang jauh lebih stabil daripada endpoint publik tanpa key.

Tanpa API key, script pakai endpoint publik `api.debank.com/user/total_balance` secara sekuensial (1 request sekali jalan) dengan retry kalau kena 429 / 5xx.

## Catatan penting soal DeBank

Halaman `debank.com/profile/<address>` itu SPA — HTML-nya cuma shell kosong, balance tidak ada di HTML. Jadi script ini tidak scrape HTML, tapi memanggil API di balik halaman itu.

Endpoint publik tanpa key gampang kena `429 Request too fast` dari IP bersama. Kalau itu terjadi, script akan retry dengan backoff dan mencatat yang gagal di file `.failed.txt`. Solusi paling stabil: pakai `DEBANK_API_KEY`.

## Keamanan

- Jangan commit / jangan kirim file `wallets.txt` dan `filtered.txt` ke sembarang tempat — isinya ada private key.
- Jalankan script ini di mesin kamu sendiri, bukan di server orang lain.
