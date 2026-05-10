const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const SESSIONS_PATH = path.join(DATA_DIR, 'payment-sessions.json');
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const PAKASIR_BASE_URL = process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com';
const PAKASIR_PROJECT = process.env.PAKASIR_PROJECT || process.env.PAKASIR_SLUG || '';
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY || '';
const PAKASIR_METHOD = process.env.PAKASIR_METHOD || 'qris';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const RESULTS_TTL_HOURS = Number(process.env.RESULTS_TTL_HOURS || 24);
const RESULT_MAX_BYTES = Number(process.env.RESULT_MAX_BYTES || 10 * 1024 * 1024);
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
const PORT = Number(process.env.PORT || 3000);
const paymentSessions = new Map();

app.set('trust proxy', 1);
app.use((req, res, next) => {
  const requestOrigin = req.headers.origin;
  if (!requestOrigin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (CORS_ORIGINS.length === 0 || CORS_ORIGINS.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_PER_MIN || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(ROOT_DIR));
app.use('/api', apiLimiter);

function requireInternalApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const headerKey = req.headers['x-internal-api-key'];
  const candidate = String(headerKey || bearer || '').trim();

  if (!candidate || candidate !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Amount must be a positive number');
  }
  return Math.round(amount);
}

function getBaseUrl(req) {
  if (PUBLIC_URL) {
    return PUBLIC_URL.replace(/\/$/, '');
  }

  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${protocol}://${host}`;
}

async function ensureDirectories() {
  await fsp.mkdir(RESULTS_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function persistSessionsToDisk() {
  const payload = Object.fromEntries(paymentSessions.entries());
  await writeJson(SESSIONS_PATH, payload);
}

async function loadSessionsFromDisk() {
  const stored = await readJsonIfExists(SESSIONS_PATH);
  if (!stored || typeof stored !== 'object') return;

  for (const [orderId, value] of Object.entries(stored)) {
    if (!orderId || !value || typeof value !== 'object') continue;
    paymentSessions.set(orderId, value);
  }
}

async function cleanupExpiredResults() {
  const ttlMs = Math.max(1, RESULTS_TTL_HOURS) * 60 * 60 * 1000;
  const now = Date.now();
  const entries = await fsp.readdir(RESULTS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const metaPath = path.join(RESULTS_DIR, entry.name);
    const record = await readJsonIfExists(metaPath);
    if (!record?.createdAt || !record?.fileName) continue;

    const createdAt = Date.parse(record.createdAt);
    if (!Number.isFinite(createdAt) || now - createdAt < ttlMs) continue;

    const imagePath = path.join(RESULTS_DIR, record.fileName);
    await Promise.allSettled([
      fsp.unlink(metaPath),
      fsp.unlink(imagePath),
    ]);
  }
}

function parseDataUrl(imageDataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(imageDataUrl || '');
  if (!match) {
    throw new Error('imageDataUrl must be a base64 data URL');
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

async function readJsonIfExists(filePath) {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2));
}

function extractTransactionStatus(payload) {
  const status = firstDefined(
    payload?.payment?.status,
    payload?.status,
    payload?.transaction_status,
    payload?.payment_status,
    payload?.data?.status,
    payload?.data?.transaction_status,
    payload?.data?.payment_status,
  );

  return String(status || 'pending').toLowerCase();
}

function extractPaymentMethod(payload) {
  return firstDefined(
    payload?.payment?.payment_method,
    payload?.payment?.paymentMethod,
    payload?.payment_method,
    payload?.paymentMethod,
    payload?.method,
    payload?.data?.payment_method,
    payload?.data?.paymentMethod,
    payload?.data?.method,
  );
}

function extractQrText(payload) {
  return firstDefined(
    payload?.payment?.payment_number,
    payload?.payment?.qr_string,
    payload?.payment?.qris_string,
    payload?.qr_string,
    payload?.qris_string,
    payload?.qr,
    payload?.qris,
    payload?.qr_code,
    payload?.qrCode,
    payload?.payment_url,
    payload?.paymentUrl,
    payload?.checkout_url,
    payload?.checkoutUrl,
    payload?.url,
    payload?.link,
    payload?.data?.payment_number,
    payload?.data?.qr_string,
    payload?.data?.qris_string,
    payload?.data?.qr,
    payload?.data?.qris,
    payload?.data?.qr_code,
    payload?.data?.payment_url,
    payload?.data?.checkout_url,
    payload?.data?.url,
    payload?.data?.link,
  );
}

function extractPaymentUrl(payload) {
  return firstDefined(
    payload?.payment_url,
    payload?.paymentUrl,
    payload?.checkout_url,
    payload?.checkoutUrl,
    payload?.url,
    payload?.link,
    payload?.data?.payment_url,
    payload?.data?.paymentUrl,
    payload?.data?.checkout_url,
    payload?.data?.checkoutUrl,
    payload?.data?.url,
    payload?.data?.link,
  );
}

function extractExpiry(payload) {
  const value = firstDefined(
    payload?.payment?.expired_at,
    payload?.payment?.expiresAt,
    payload?.payment?.expires_at,
    payload?.expired_at,
    payload?.expires_at,
    payload?.expiry_at,
    payload?.data?.expired_at,
    payload?.data?.expires_at,
    payload?.data?.expiry_at,
  );

  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function createQrDataUrl(text) {
  if (!text) {
    return '';
  }

  return QRCode.toDataURL(String(text), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
}

async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        ...(options && options.headers ? options.headers : {}),
      },
    });

    const rawText = await response.text();
    let parsed = null;

    try {
      parsed = rawText ? JSON.parse(rawText) : {};
    } catch {
      parsed = { message: rawText };
    }

    if (!response.ok) {
      const message = firstDefined(parsed?.message, parsed?.error, rawText, `Request failed with status ${response.status}`);
      const error = new Error(message);
      error.statusCode = response.status;
      error.payload = parsed;
      throw error;
    }

    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function callPakasirJson(endpoint, body) {
  if (!PAKASIR_PROJECT || !PAKASIR_API_KEY) {
    const error = new Error('Pakasir is not configured. Set PAKASIR_PROJECT and PAKASIR_API_KEY.');
    error.statusCode = 503;
    throw error;
  }

  return fetchJson(`${PAKASIR_BASE_URL.replace(/\/$/, '')}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function normalizeTransactionPayload(payload) {
  const qrText = extractQrText(payload);
  const paymentUrl = extractPaymentUrl(payload);
  const status = extractTransactionStatus(payload);
  const paymentMethod = extractPaymentMethod(payload);
  const orderId = firstDefined(payload?.payment?.order_id, payload?.order_id, payload?.orderId, payload?.data?.order_id, payload?.data?.orderId);
  const amount = firstDefined(payload?.payment?.amount, payload?.amount, payload?.data?.amount);
  const expiresAt = extractExpiry(payload);

  return {
    raw: payload,
    status,
    paymentMethod,
    orderId,
    amount,
    paymentUrl,
    qrText,
    expiresAt,
  };
}

async function createPakasirSession({ orderId, amount }) {
  const payload = {
    project: PAKASIR_PROJECT,
    order_id: orderId,
    amount,
    api_key: PAKASIR_API_KEY,
    qris_only: 1,
  };

  const response = await fetchJson(`${PAKASIR_BASE_URL.replace(/\/$/, '')}/api/transactioncreate/${encodeURIComponent(PAKASIR_METHOD)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const normalized = normalizeTransactionPayload(response);
  const qrSource = firstDefined(normalized.qrText, normalized.paymentUrl);
  
  let qrDataUrl = '';
  if (qrSource) {
    try {
      qrDataUrl = await createQrDataUrl(qrSource);
      console.log(`✅ QR Generated for order ${orderId} (length: ${qrDataUrl.length})`);
    } catch (qrError) {
      console.error(`❌ QR Generation failed:`, qrError.message);
    }
  } else {
    console.warn(`⚠️ No QR source found. Response:`, { payment_number: normalized.qrText, status: normalized.status });
  }

  return {
    ...normalized,
    qrDataUrl,
    provider: 'pakasir',
  };
}

async function getPakasirTransactionDetail({ orderId, amount }) {
  const response = await fetchJson(
    `${PAKASIR_BASE_URL.replace(/\/$/, '')}/api/transactiondetail?project=${encodeURIComponent(PAKASIR_PROJECT)}&amount=${encodeURIComponent(amount)}&order_id=${encodeURIComponent(orderId)}&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`,
    {
      method: 'GET',
    },
  );

  return normalizeTransactionPayload(response);
}

async function cancelPakasirTransaction({ orderId, amount }) {
  const response = await fetchJson(`${PAKASIR_BASE_URL.replace(/\/$/, '')}/api/transactioncancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project: PAKASIR_PROJECT,
      order_id: orderId,
      amount,
      api_key: PAKASIR_API_KEY,
    }),
  });

  return normalizeTransactionPayload(response);
}

async function saveResultShare({ orderId, packageId, customerName, imageDataUrl }) {
  await ensureDirectories();

  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const { mimeType, buffer } = parseDataUrl(imageDataUrl);
  const extension = mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const fileName = `${token}.${extension}`;
  const metaFileName = `${token}.json`;
  const filePath = path.join(RESULTS_DIR, fileName);
  const metaPath = path.join(RESULTS_DIR, metaFileName);

  await fsp.writeFile(filePath, buffer);

  const record = {
    token,
    orderId: orderId || '',
    packageId: packageId || '',
    customerName: customerName || '',
    mimeType,
    fileName,
    createdAt: new Date().toISOString(),
  };

  await writeJson(metaPath, record);

  return {
    ...record,
    filePath,
    metaPath,
  };
}

async function loadResultShare(token) {
  if (!token) {
    return null;
  }

  const safeToken = token.replace(/[^a-zA-Z0-9]/g, '');
  if (!safeToken) {
    return null;
  }

  const metaPath = path.join(RESULTS_DIR, `${safeToken}.json`);
  const record = await readJsonIfExists(metaPath);
  if (!record) {
    return null;
  }

  const filePath = path.join(RESULTS_DIR, record.fileName);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return {
    ...record,
    filePath,
    metaPath,
  };
}

function renderSharePage({ token, downloadUrl, imageUrl, customerName, orderId, createdAt, packageId }) {
  const title = 'Kothak Photo Download';
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #071325;
      --panel: #0f1d33;
      --panel-soft: #13243f;
      --text: #f7f8fc;
      --muted: #b7c0d1;
      --accent: #ffdb3c;
      --accent-2: #ffb86b;
      --border: rgba(255,255,255,.14);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(255,219,60,.18), transparent 30%),
        radial-gradient(circle at bottom right, rgba(255,184,107,.14), transparent 28%),
        linear-gradient(180deg, #081426, #0b172b 45%, #091121);
      color: var(--text);
    }
    .card {
      width: min(900px, 100%);
      border: 1px solid var(--border);
      border-radius: 28px;
      background: rgba(15, 29, 51, .9);
      box-shadow: 0 24px 90px rgba(0,0,0,.35);
      overflow: hidden;
    }
    .hero {
      display: grid;
      grid-template-columns: 1.2fr .8fr;
      gap: 0;
    }
    .content {
      padding: 32px;
    }
    .eyebrow {
      margin: 0 0 12px;
      text-transform: uppercase;
      letter-spacing: .18em;
      color: var(--accent);
      font-size: .78rem;
      font-weight: 700;
    }
    h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 3.4rem);
      line-height: 1;
    }
    p {
      color: var(--muted);
      line-height: 1.6;
    }
    .meta {
      display: grid;
      gap: 8px;
      margin: 24px 0;
      padding: 18px;
      border: 1px solid var(--border);
      border-radius: 20px;
      background: rgba(255,255,255,.03);
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      font-size: .95rem;
    }
    .meta-row strong { color: var(--text); }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 24px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      padding: 0 18px;
      border-radius: 999px;
      text-decoration: none;
      font-weight: 700;
      border: 1px solid transparent;
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #101010;
    }
    .btn-secondary {
      border-color: var(--border);
      color: var(--text);
      background: rgba(255,255,255,.04);
    }
    .preview {
      min-height: 100%;
      background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.02));
      padding: 22px;
      display: grid;
      place-items: center;
    }
    .preview img {
      width: 100%;
      height: auto;
      display: block;
      border-radius: 20px;
      box-shadow: 0 20px 50px rgba(0,0,0,.35);
      border: 1px solid rgba(255,255,255,.08);
      background: #fff;
    }
    @media (max-width: 800px) {
      .hero { grid-template-columns: 1fr; }
      .content { padding: 24px; }
      .preview { order: -1; }
    }
  </style>
</head>
<body>
  <main class="card">
    <section class="hero">
      <div class="content">
        <p class="eyebrow">Kothak Photo</p>
        <h1>Foto kamu sudah siap diunduh</h1>
        <p>Gunakan tombol unduh untuk mengambil file PNG asli. Halaman ini juga bisa dibuka dari QR di layar hasil.</p>
        <div class="meta">
          <div class="meta-row"><span>Order</span><strong>${orderId || token}</strong></div>
          <div class="meta-row"><span>Paket</span><strong>${packageId || '-'}</strong></div>
          <div class="meta-row"><span>Nama</span><strong>${customerName || '-'}</strong></div>
          <div class="meta-row"><span>Dibuat</span><strong>${createdAt ? new Date(createdAt).toLocaleString('id-ID') : '-'}</strong></div>
        </div>
        <div class="actions">
          <a class="btn btn-primary" href="${downloadUrl}">Unduh foto</a>
          <a class="btn btn-secondary" href="/kothak-photo.html">Kembali ke booth</a>
        </div>
      </div>
      <div class="preview">
        <img src="${imageUrl}" alt="Preview foto hasil" />
      </div>
    </section>
  </main>
</body>
</html>`;
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'kothak-photo.html'));
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/qris/create', requireInternalApiKey, async (req, res) => {
  try {
    const orderId = String(req.body.orderId || '').trim() || `KP-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const amount = normalizeAmount(req.body.amount);
    const packageId = String(req.body.packageId || '').trim();
    const customerName = String(req.body.customerName || '').trim();
    const customerPhone = String(req.body.customerPhone || '').trim();

    const payment = await createPakasirSession({ orderId, amount });
    const session = {
      orderId,
      amount,
      packageId,
      customerName,
      customerPhone,
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      paymentUrl: payment.paymentUrl,
      qrText: payment.qrText,
      qrDataUrl: payment.qrDataUrl,
      createdAt: new Date().toISOString(),
      raw: payment.raw,
    };

    paymentSessions.set(orderId, session);
    await persistSessionsToDisk();

    res.json({
      orderId,
      amount,
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      paymentUrl: payment.paymentUrl,
      qrText: payment.qrText,
      qrDataUrl: payment.qrDataUrl,
      expiresAt: payment.expiresAt,
      provider: payment.provider,
      raw: payment.raw,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      detail: error.payload || null,
    });
  }
});

app.get('/api/qris/:orderId/status', requireInternalApiKey, async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    const session = paymentSessions.get(orderId);
    const amount = normalizeAmount(req.query.amount || session?.amount);

    const payment = await getPakasirTransactionDetail({ orderId, amount });
    const mergedSession = {
      ...(session || {}),
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      lastCheckedAt: new Date().toISOString(),
      raw: payment.raw,
    };

    paymentSessions.set(orderId, mergedSession);
    await persistSessionsToDisk();

    res.json({
      orderId,
      amount,
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      paymentUrl: payment.paymentUrl,
      expiresAt: payment.expiresAt,
      raw: payment.raw,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      detail: error.payload || null,
    });
  }
});

app.post('/api/qris/:orderId/cancel', requireInternalApiKey, async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    const session = paymentSessions.get(orderId);
    const amount = normalizeAmount(req.body.amount || session?.amount);

    const payment = await cancelPakasirTransaction({ orderId, amount });
    paymentSessions.set(orderId, {
      ...(session || {}),
      status: 'canceled',
      cancelledAt: new Date().toISOString(),
      raw: payment.raw,
    });
    await persistSessionsToDisk();

    res.json({
      orderId,
      amount,
      status: payment.status,
      raw: payment.raw,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: error.message,
      detail: error.payload || null,
    });
  }
});

app.post('/api/results', requireInternalApiKey, async (req, res) => {
  try {
    const { imageDataUrl, orderId, packageId, customerName } = req.body || {};
    if (!imageDataUrl) {
      return res.status(400).json({ error: 'imageDataUrl is required' });
    }

    const base64Payload = String(imageDataUrl).split(',')[1] || '';
    const decodedSize = Buffer.byteLength(base64Payload, 'base64');
    if (decodedSize > RESULT_MAX_BYTES) {
      return res.status(413).json({ error: `Image too large. Max ${Math.round(RESULT_MAX_BYTES / (1024 * 1024))}MB` });
    }

    const record = await saveResultShare({
      imageDataUrl,
      orderId,
      packageId,
      customerName,
    });

    const shareUrl = `${getBaseUrl(req)}/share/${record.token}`;
    const downloadUrl = `${shareUrl}/download`;
    const downloadQrDataUrl = await createQrDataUrl(shareUrl);

    res.json({
      token: record.token,
      shareUrl,
      downloadUrl,
      downloadQrDataUrl,
      createdAt: record.createdAt,
    });
  } catch (error) {
    res.status(400).json({
      error: error.message,
    });
  }
});

app.get('/share/:token', async (req, res) => {
  try {
    const record = await loadResultShare(req.params.token);
    if (!record) {
      return res.status(404).send('Hasil foto tidak ditemukan');
    }

    const shareUrl = `${getBaseUrl(req)}/share/${record.token}`;
    const downloadUrl = `${shareUrl}/download`;
    res.type('html').send(renderSharePage({
      token: record.token,
      downloadUrl,
      imageUrl: `${shareUrl}/image`,
      customerName: record.customerName,
      orderId: record.orderId,
      createdAt: record.createdAt,
      packageId: record.packageId,
    }));
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/share/:token/image', async (req, res) => {
  try {
    const record = await loadResultShare(req.params.token);
    if (!record) {
      return res.status(404).send('Hasil foto tidak ditemukan');
    }

    if (req.query.download === '1') {
      res.download(record.filePath, `${record.token}.${path.extname(record.filePath).replace('.', '')}`);
      return;
    }

    res.sendFile(record.filePath);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.get('/share/:token/download', async (req, res) => {
  try {
    const record = await loadResultShare(req.params.token);
    if (!record) {
      return res.status(404).send('Hasil foto tidak ditemukan');
    }

    const extension = path.extname(record.filePath).replace('.', '') || 'png';
    res.download(record.filePath, `${record.token}.${extension}`);
  } catch (error) {
    res.status(500).send(error.message);
  }
});

async function start() {
  await ensureDirectories();
  await loadSessionsFromDisk();
  await cleanupExpiredResults();

  setInterval(() => {
    cleanupExpiredResults().catch((error) => console.error('cleanupExpiredResults error:', error.message));
  }, 60 * 60 * 1000).unref();

  app.listen(PORT, () => {
    console.log(`Kothak Photo server running on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
