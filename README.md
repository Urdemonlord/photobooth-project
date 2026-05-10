# Kothak Photo

Kios photobooth berbasis HTML, CSS, dan JavaScript dengan backend Express untuk QRIS Pakasir dan share hasil foto.

## Files

- `kothak-photo.html` - entry UI utama
- `kothak-photo.css` - layout, responsive shell, dan print styles
- `kothak-photo.js` - alur kamera, frame, filter, pembayaran, dan hasil
- `server.js` - backend Express untuk Pakasir QRIS dan share hasil
- `.env.example` - variabel konfigurasi backend

## Menjalankan

1. Copy `.env.example` ke `.env` lalu isi minimal `PAKASIR_PROJECT`, `PAKASIR_API_KEY`, dan `INTERNAL_API_KEY`.
2. Install dependency Node.
3. Jalankan server dengan `npm start`.

Contoh:

```powershell
npm install
npm start
```

Lalu buka `http://localhost:3000`.

## Backend

- `POST /api/qris/create` untuk membuat transaksi QRIS Pakasir.
- `GET /api/qris/:orderId/status` untuk polling status transaksi.
- `POST /api/qris/:orderId/cancel` untuk membatalkan transaksi.
- `POST /api/results` untuk menyimpan hasil foto dan membuat tautan share.
- `GET /share/:token` untuk halaman unduh hasil.

## Security & Operasional

- `CORS_ORIGINS` untuk whitelist origin frontend (pisahkan dengan koma).
- `INTERNAL_API_KEY` untuk proteksi endpoint `/api/*`.
  - Kirim header `x-internal-api-key: <INTERNAL_API_KEY>` dari frontend/backend caller.
- Rate limit API via `API_RATE_LIMIT_PER_MIN` (default 120 req/menit/IP).
- Batas ukuran upload hasil foto via `RESULT_MAX_BYTES` (default 10MB).
- Retensi file hasil via `RESULTS_TTL_HOURS` (default 24 jam), auto-cleanup tiap 1 jam.
- Session pembayaran disimpan persisten di `data/payment-sessions.json` agar tidak hilang saat restart.

## Catatan

- QRIS akan aktif jika env Pakasir sudah terisi.
- Tombol cetak memakai dialog print browser.
- Unduhan hasil foto dibuat dari canvas asli lalu bisa dibagikan lewat tautan share.
