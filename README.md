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
- `POST /api/print-jobs` untuk membuat job cetak dari token hasil foto.
- `GET /api/print-jobs` untuk list job cetak (opsional filter `?status=`).
- `GET /api/print-jobs/:id` untuk polling status cetak (`queued|printing|done|failed|cancelled`).
- `POST /api/print-jobs/:id/retry` untuk requeue job `failed/cancelled`.
- `POST /api/print-jobs/:id/cancel` untuk batalkan job yang masih `queued`.
- `GET /admin/print-jobs` untuk dashboard operator print queue.
- `GET /share/:token` untuk halaman unduh hasil.

## Security & Operasional

- `CORS_ORIGINS` untuk whitelist origin frontend (pisahkan dengan koma).
- `INTERNAL_API_KEY` untuk proteksi endpoint `/api/*`.
  - Kirim header `x-internal-api-key: <INTERNAL_API_KEY>` dari frontend/backend caller.
- Rate limit API via `API_RATE_LIMIT_PER_MIN` (default 120 req/menit/IP).
- Batas ukuran upload hasil foto via `RESULT_MAX_BYTES` (default 10MB).
- Retensi file hasil via `RESULTS_TTL_HOURS` (default 24 jam), auto-cleanup tiap 1 jam.
- Session pembayaran disimpan persisten di `data/payment-sessions.json` agar tidak hilang saat restart.
- Print queue endpoint tersedia via `/api/print-jobs`; konfigurasi printer via `PRINT_*` env.
- Print job sekarang persisten di `data/print-jobs.json` + resume queue saat restart.
- Retry cetak otomatis via `PRINT_MAX_RETRIES` (default 2).
- Auto-prune job cetak lama via `PRINT_JOB_RETENTION_HOURS` (default 168 jam / 7 hari).
- Log event print tersimpan di `data/print-events.log` (JSONL).
- Dashboard operator `/admin/print-jobs` bisa diproteksi Basic Auth via `ADMIN_DASHBOARD_USER` + `ADMIN_DASHBOARD_PASSWORD`.
- Lock anti double-print per `orderId` (bisa override dengan `force: true`).
- Health printer tersedia di `GET /health/printer` (termasuk metrik `totalDone/totalFailed/lastError`).

## Catatan

- QRIS akan aktif jika env Pakasir sudah terisi.
- Tombol cetak memakai dialog print browser.
- Fitur sekarang mengikuti paket:
  - Reguler: frame terbatas + filter basic.
  - Premium: 3 frame pilihan + semua filter.
  - Group: semua frame + extra print (`copies: 2`).
- Di layar kamera ada batas waktu sesi foto per paket (reguler 60s, premium 90s, group 120s).
- Rules paket bisa dioverride dari `kothak-photo.config.js` via `window.KOTHAK_PACKAGE_RULES` / meta `kothak-package-rules` (JSON).
- Operator juga bisa ubah rules langsung dari UI tombol **Atur Paket** (pojok kanan atas) dengan mode checklist (tinggal centang frame/filter). Hasilnya tersimpan lokal di browser kiosk (`localStorage`) dan bisa di-reset ke default.
- Ada tombol preset cepat: **Preset Reguler / Premium / Group** untuk apply rule standar ke semua paket dalam 1 klik sebelum disimpan.
- Pengaturan paket bisa dikunci PIN operator via `window.KOTHAK_OPERATOR_PIN` / `window.__KOTHAK_OPERATOR_PIN__` / meta `kothak-operator-pin` (valid per sesi tab/browser).
- PIN operator juga bisa diubah langsung dari panel **Atur Paket** (input PIN baru + konfirmasi), tersimpan lokal di browser kiosk.
- Unduhan hasil foto dibuat dari canvas asli lalu bisa dibagikan lewat tautan share.
