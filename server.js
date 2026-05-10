const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { execFile } = require('child_process');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
require('dotenv').config();

const app = express();
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const SESSIONS_PATH = path.join(DATA_DIR, 'payment-sessions.json');
const PRINT_JOBS_PATH = path.join(DATA_DIR, 'print-jobs.json');
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const PUBLIC_RESULTS_BASE_URL = String(process.env.PUBLIC_RESULTS_BASE_URL || '').trim().replace(/\/$/, '');
const R2_ENDPOINT = String(process.env.R2_ENDPOINT || '').trim().replace(/\/$/, '');
const R2_BUCKET = String(process.env.R2_BUCKET || '').trim();
const R2_ACCESS_KEY_ID = String(process.env.R2_ACCESS_KEY_ID || '').trim();
const R2_SECRET_ACCESS_KEY = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
const R2_REGION = String(process.env.R2_REGION || 'auto').trim();
const PAKASIR_BASE_URL = process.env.PAKASIR_BASE_URL || 'https://app.pakasir.com';
const PAKASIR_PROJECT = process.env.PAKASIR_PROJECT || process.env.PAKASIR_SLUG || '';
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY || '';
const PAKASIR_METHOD = process.env.PAKASIR_METHOD || 'qris';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const RESULTS_TTL_HOURS = Number(process.env.RESULTS_TTL_HOURS || 24);
const RESULT_MAX_BYTES = Number(process.env.RESULT_MAX_BYTES || 10 * 1024 * 1024);
const PRINT_ENABLED = String(process.env.PRINT_ENABLED || 'false').toLowerCase() === 'true';
const PRINT_STRATEGY = String(process.env.PRINT_STRATEGY || 'lp').toLowerCase();
const PRINT_COMMAND = process.env.PRINT_COMMAND || 'lp';
const PRINT_PRINTER_NAME = process.env.PRINT_PRINTER_NAME || '';
const PRINT_TIMEOUT_MS = Number(process.env.PRINT_TIMEOUT_MS || 30000);
const PRINT_MAX_RETRIES = Number(process.env.PRINT_MAX_RETRIES || 2);
const PRINT_JOB_RETENTION_HOURS = Number(process.env.PRINT_JOB_RETENTION_HOURS || 168);
const PRINT_LOG_PATH = path.join(DATA_DIR, 'print-events.log');
const ADMIN_DASHBOARD_USER = process.env.ADMIN_DASHBOARD_USER || 'operator';
const ADMIN_DASHBOARD_PASSWORD = process.env.ADMIN_DASHBOARD_PASSWORD || '';
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
const PORT = Number(process.env.PORT || 3000);
const paymentSessions = new Map();
const printJobs = new Map();
const printQueue = [];
let isPrintWorkerRunning = false;
const printMetrics = {
  totalQueued: 0,
  totalDone: 0,
  totalFailed: 0,
  totalCancelled: 0,
  lastSuccessAt: '',
  lastFailureAt: '',
  lastError: '',
};

const hasR2Config = Boolean(R2_ENDPOINT && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
const r2Client = hasR2Config
  ? new S3Client({
    region: R2_REGION,
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  })
  : null;

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

function requireAdminDashboardAuth(req, res, next) {
  if (!ADMIN_DASHBOARD_PASSWORD) {
    return next();
  }

  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Photobooth Operator"');
    return res.status(401).send('Authentication required');
  }

  let decoded = '';
  try {
    decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  } catch {
    res.setHeader('WWW-Authenticate', 'Basic realm="Photobooth Operator"');
    return res.status(401).send('Invalid auth header');
  }

  const sepIndex = decoded.indexOf(':');
  const username = sepIndex >= 0 ? decoded.slice(0, sepIndex) : '';
  const password = sepIndex >= 0 ? decoded.slice(sepIndex + 1) : '';

  if (username !== ADMIN_DASHBOARD_USER || password !== ADMIN_DASHBOARD_PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Photobooth Operator"');
    return res.status(401).send('Invalid credentials');
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

function getPublicResultDirectUrl(req, fileName = '') {
  if (!fileName) return '';
  if (PUBLIC_RESULTS_BASE_URL) return `${PUBLIC_RESULTS_BASE_URL}/${encodeURIComponent(fileName)}`;
  return `${getBaseUrl(req)}/data/results/${encodeURIComponent(fileName)}`;
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

async function persistPrintJobsToDisk() {
  const payload = {
    jobs: Array.from(printJobs.values()),
    queue: [...printQueue],
  };
  await writeJson(PRINT_JOBS_PATH, payload);
}

async function loadPrintJobsFromDisk() {
  const stored = await readJsonIfExists(PRINT_JOBS_PATH);
  if (!stored || typeof stored !== 'object') return;

  const jobs = Array.isArray(stored.jobs) ? stored.jobs : [];
  const queue = Array.isArray(stored.queue) ? stored.queue : [];

  for (const job of jobs) {
    if (!job?.id) continue;

    if (job.status === 'printing' || job.status === 'queued') {
      job.status = 'queued';
      job.updatedAt = new Date().toISOString();
      queue.push(job.id);
    }

    printJobs.set(job.id, job);
  }

  for (const id of queue) {
    if (typeof id !== 'string') continue;
    if (!printJobs.has(id)) continue;
    if (!printQueue.includes(id)) printQueue.push(id);
  }

  recomputePrintMetrics();
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

async function appendPrintEvent(event, payload = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...payload,
  });
  await fsp.appendFile(PRINT_LOG_PATH, `${line}\n`);
}

function recomputePrintMetrics() {
  printMetrics.totalQueued = 0;
  printMetrics.totalDone = 0;
  printMetrics.totalFailed = 0;
  printMetrics.totalCancelled = 0;

  for (const job of printJobs.values()) {
    if (job.status === 'queued' || job.status === 'printing') printMetrics.totalQueued += 1;
    if (job.status === 'done') printMetrics.totalDone += 1;
    if (job.status === 'failed') printMetrics.totalFailed += 1;
    if (job.status === 'cancelled') printMetrics.totalCancelled += 1;
  }
}

async function pruneOldPrintJobs() {
  const retentionMs = Math.max(1, PRINT_JOB_RETENTION_HOURS) * 60 * 60 * 1000;
  const now = Date.now();
  let removed = 0;

  for (const [jobId, job] of printJobs.entries()) {
    if (!['done', 'failed', 'cancelled'].includes(job.status)) continue;
    const refAt = Date.parse(job.finishedAt || job.updatedAt || job.createdAt || 0);
    if (!Number.isFinite(refAt)) continue;
    if ((now - refAt) < retentionMs) continue;

    printJobs.delete(jobId);
    removeJobFromQueue(jobId);
    removed += 1;
  }

  if (removed > 0) {
    recomputePrintMetrics();
    await persistPrintJobsToDisk();
    await appendPrintEvent('print_jobs_pruned', { removed });
  }

  return removed;
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

  if (r2Client) {
    try {
      await r2Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: fileName,
        Body: buffer,
        ContentType: mimeType,
      }));
    } catch (error) {
      console.error('R2 upload failed:', error.message);
    }
  }

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

function resolveResultFileByToken(token) {
  const safeToken = String(token || '').replace(/[^a-zA-Z0-9]/g, '');
  if (!safeToken) return null;

  const metaPath = path.join(RESULTS_DIR, `${safeToken}.json`);
  if (!fs.existsSync(metaPath)) return null;

  try {
    const record = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const filePath = path.join(RESULTS_DIR, record.fileName || '');
    if (!record?.fileName || !fs.existsSync(filePath)) return null;
    return { token: safeToken, filePath, record };
  } catch {
    return null;
  }
}

function runPrintCommand(filePath) {
  return new Promise((resolve, reject) => {
    if (!PRINT_ENABLED) {
      const error = new Error('Printing is disabled on server');
      error.code = 'PRINT_DISABLED';
      reject(error);
      return;
    }

    if (PRINT_STRATEGY !== 'lp') {
      const error = new Error(`Unsupported print strategy: ${PRINT_STRATEGY}`);
      error.code = 'PRINT_STRATEGY_UNSUPPORTED';
      reject(error);
      return;
    }

    const args = [];
    if (PRINT_PRINTER_NAME) args.push('-d', PRINT_PRINTER_NAME);
    args.push(filePath);

    execFile(PRINT_COMMAND, args, { timeout: PRINT_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error(stderr || error.message || 'Print command failed');
        wrapped.code = error.code || 'PRINT_COMMAND_FAILED';
        reject(wrapped);
        return;
      }
      resolve({ stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
    });
  });
}

function removeJobFromQueue(jobId) {
  const nextQueue = printQueue.filter((id) => id !== jobId);
  printQueue.length = 0;
  printQueue.push(...nextQueue);
}

async function processPrintQueue() {
  if (isPrintWorkerRunning) return;
  isPrintWorkerRunning = true;

  while (printQueue.length > 0) {
    const jobId = printQueue.shift();
    const job = printJobs.get(jobId);
    if (!job) continue;

    job.status = 'printing';
    job.startedAt = job.startedAt || new Date().toISOString();
    job.updatedAt = new Date().toISOString();

    try {
      const result = await runPrintCommand(job.filePath);
      job.status = 'done';
      job.output = result.stdout;
      job.error = '';
      job.errorCode = '';
      job.finishedAt = new Date().toISOString();
      printMetrics.lastSuccessAt = job.finishedAt;
      printMetrics.lastError = '';
      await appendPrintEvent('print_job_done', { jobId: job.id, orderId: job.orderId, token: job.token, attempts: job.attempts });
    } catch (error) {
      job.attempts = Number(job.attempts || 0) + 1;
      job.error = error.message;
      job.errorCode = error.code || '';

      if (job.attempts <= PRINT_MAX_RETRIES) {
        job.status = 'queued';
        printQueue.push(job.id);
        await appendPrintEvent('print_job_retry_queued', { jobId: job.id, attempts: job.attempts, error: job.error, errorCode: job.errorCode });
      } else {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        printMetrics.lastFailureAt = job.finishedAt;
        printMetrics.lastError = job.error;
        await appendPrintEvent('print_job_failed', { jobId: job.id, attempts: job.attempts, error: job.error, errorCode: job.errorCode });
      }
    }

    job.updatedAt = new Date().toISOString();
    printJobs.set(jobId, job);
    recomputePrintMetrics();
    await persistPrintJobsToDisk();
  }

  isPrintWorkerRunning = false;
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

app.get('/admin/print-jobs', requireAdminDashboardAuth, (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Operator Print Queue</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #0b1220; color: #e5e7eb; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 20px; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 16px; margin-bottom: 12px; }
    input, select, button { padding: 10px; border-radius: 8px; border: 1px solid #374151; background: #0f172a; color: #e5e7eb; }
    button { cursor: pointer; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .muted { color: #94a3b8; }
    .ok { color: #22c55e; }
    .err { color: #ef4444; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; border-bottom: 1px solid #1f2937; padding: 8px; vertical-align: top; }
    .pill { padding: 2px 8px; border-radius: 999px; font-size: 12px; display: inline-block; }
    .queued { background: #1d4ed8; }
    .printing { background: #9333ea; }
    .done { background: #15803d; }
    .failed { background: #b91c1c; }
    .cancelled { background: #6b7280; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Operator Print Queue</h1>
    <div class="card row">
      <input id="apiKey" type="password" placeholder="INTERNAL_API_KEY" style="min-width:240px" />
      <select id="statusFilter">
        <option value="">Semua status</option>
        <option value="queued">queued</option>
        <option value="printing">printing</option>
        <option value="done">done</option>
        <option value="failed">failed</option>
        <option value="cancelled">cancelled</option>
      </select>
      <button id="reloadBtn">Reload</button>
      <span id="meta" class="muted"></span>
    </div>

    <div id="flash" class="muted"></div>

    <div class="card">
      <table>
        <thead>
          <tr>
            <th>ID</th><th>Order</th><th>Status</th><th>Attempts</th><th>Error</th><th>Updated</th><th>Aksi</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>

<script>
const rowsEl = document.getElementById('rows');
const metaEl = document.getElementById('meta');
const flashEl = document.getElementById('flash');
const apiKeyEl = document.getElementById('apiKey');
const statusFilterEl = document.getElementById('statusFilter');

function h(type, attrs = {}, text = '') {
  const el = document.createElement(type);
  Object.entries(attrs).forEach(([k,v]) => el.setAttribute(k, v));
  if (text) el.textContent = text;
  return el;
}

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const key = apiKeyEl.value.trim();
  if (key) headers['x-internal-api-key'] = key;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Request failed');
  return payload;
}

function show(msg, cls='muted') {
  flashEl.className = cls;
  flashEl.textContent = msg;
}

function renderJobs(items) {
  rowsEl.innerHTML = '';
  if (!items.length) {
    const tr = h('tr');
    const td = h('td', { colspan: '7', class: 'muted' }, 'Belum ada print job.');
    tr.appendChild(td);
    rowsEl.appendChild(tr);
    return;
  }

  for (const job of items) {
    const tr = h('tr');
    tr.appendChild(h('td', {}, job.id || '-'));
    tr.appendChild(h('td', {}, job.orderId || '-'));

    const statusTd = h('td');
    const statusPill = h('span', { class: 'pill ' + (job.status || '') }, job.status || '-');
    statusTd.appendChild(statusPill);
    tr.appendChild(statusTd);

    tr.appendChild(h('td', {}, String(job.attempts || 0)));
    tr.appendChild(h('td', {}, job.error || '-'));
    tr.appendChild(h('td', {}, job.updatedAt ? new Date(job.updatedAt).toLocaleString('id-ID') : '-'));

    const actionTd = h('td');
    const retryBtn = h('button', {}, 'Retry');
    retryBtn.disabled = !(job.status === 'failed' || job.status === 'cancelled');
    retryBtn.onclick = async () => {
      try {
        await api('/api/print-jobs/' + encodeURIComponent(job.id) + '/retry', { method: 'POST' });
        show('Retry queued: ' + job.id, 'ok');
        await loadJobs();
      } catch (e) { show(e.message, 'err'); }
    };

    const cancelBtn = h('button', {}, 'Cancel');
    cancelBtn.disabled = !(job.status === 'queued');
    cancelBtn.onclick = async () => {
      try {
        await api('/api/print-jobs/' + encodeURIComponent(job.id) + '/cancel', { method: 'POST' });
        show('Job cancelled: ' + job.id, 'ok');
        await loadJobs();
      } catch (e) { show(e.message, 'err'); }
    };

    actionTd.appendChild(retryBtn);
    actionTd.appendChild(document.createTextNode(' '));
    actionTd.appendChild(cancelBtn);
    tr.appendChild(actionTd);

    rowsEl.appendChild(tr);
  }
}

async function loadJobs() {
  try {
    const status = statusFilterEl.value;
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    qs.set('limit', '200');
    const data = await api('/api/print-jobs?' + qs.toString());
    renderJobs(data.items || []);
    metaEl.textContent = 'total: ' + (data.total || 0) + ' · queue: ' + (data.queueLength || 0) + ' · updated: ' + new Date().toLocaleTimeString('id-ID');
  } catch (e) {
    show(e.message, 'err');
  }
}

document.getElementById('reloadBtn').onclick = loadJobs;
statusFilterEl.onchange = loadJobs;
loadJobs();
setInterval(loadJobs, 5000);
</script>
</body>
</html>`);
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

    const fallbackShareUrl = `${getBaseUrl(req)}/share/${record.token}`;
    const directPublicUrl = getPublicResultDirectUrl(req, record.fileName);
    const downloadUrl = directPublicUrl || `${fallbackShareUrl}/download`;
    const shareUrl = directPublicUrl || fallbackShareUrl;
    const downloadQrDataUrl = await createQrDataUrl(downloadUrl);

    res.json({
      token: record.token,
      shareUrl,
      downloadUrl,
      directPublicUrl,
      downloadQrDataUrl,
      createdAt: record.createdAt,
    });
  } catch (error) {
    res.status(400).json({
      error: error.message,
    });
  }
});

app.post('/api/print-jobs', requireInternalApiKey, async (req, res) => {
  try {
    const { token, orderId = '', copies = 1, paperSize = 'auto', force = false } = req.body || {};
    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    const resolved = resolveResultFileByToken(token);
    if (!resolved) {
      return res.status(404).json({ error: 'Result token not found' });
    }

    const normalizedOrderId = String(orderId || resolved.record.orderId || '').trim();

    const existingByToken = Array.from(printJobs.values()).find((job) => job.token === resolved.token && job.status !== 'failed');
    if (existingByToken) {
      return res.json(existingByToken);
    }

    if (!force && normalizedOrderId) {
      const existingByOrder = Array.from(printJobs.values()).find((job) => job.orderId === normalizedOrderId && job.status !== 'failed');
      if (existingByOrder) {
        return res.status(409).json({
          error: 'Print job for this order already exists',
          existingJobId: existingByOrder.id,
          status: existingByOrder.status,
        });
      }
    }

    const jobId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const now = new Date().toISOString();
    const job = {
      id: jobId,
      token: resolved.token,
      orderId: normalizedOrderId,
      filePath: resolved.filePath,
      copies: Math.max(1, Number(copies) || 1),
      paperSize: String(paperSize || 'auto'),
      status: 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: '',
      finishedAt: '',
      error: '',
      errorCode: '',
      output: '',
    };

    printJobs.set(jobId, job);
    printQueue.push(jobId);
    recomputePrintMetrics();
    await persistPrintJobsToDisk();
    await appendPrintEvent('print_job_created', { jobId, orderId: normalizedOrderId, token: resolved.token });
    void processPrintQueue();

    res.status(202).json(job);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/print-jobs', requireInternalApiKey, (req, res) => {
  const status = String(req.query.status || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));

  let items = Array.from(printJobs.values()).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  if (status) {
    items = items.filter((job) => String(job.status || '').toLowerCase() === status);
  }

  return res.json({
    total: items.length,
    queueLength: printQueue.length,
    workerRunning: isPrintWorkerRunning,
    items: items.slice(0, limit),
  });
});

app.get('/api/print-jobs/:id', requireInternalApiKey, (req, res) => {
  const job = printJobs.get(String(req.params.id || ''));
  if (!job) {
    return res.status(404).json({ error: 'Print job not found' });
  }

  return res.json(job);
});

app.post('/api/print-jobs/:id/retry', requireInternalApiKey, async (req, res) => {
  const jobId = String(req.params.id || '').trim();
  const job = printJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Print job not found' });
  }

  if (!['failed', 'cancelled'].includes(job.status)) {
    return res.status(409).json({ error: 'Only failed/cancelled job can be retried' });
  }

  job.status = 'queued';
  job.error = '';
  job.errorCode = '';
  job.output = '';
  job.finishedAt = '';
  job.updatedAt = new Date().toISOString();
  if (!printQueue.includes(jobId)) {
    printQueue.push(jobId);
  }

  printJobs.set(jobId, job);
  recomputePrintMetrics();
  await persistPrintJobsToDisk();
  await appendPrintEvent('print_job_retry_manual', { jobId });
  void processPrintQueue();
  return res.json(job);
});

app.post('/api/print-jobs/:id/cancel', requireInternalApiKey, async (req, res) => {
  const jobId = String(req.params.id || '').trim();
  const job = printJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Print job not found' });
  }

  if (job.status !== 'queued') {
    return res.status(409).json({ error: 'Only queued job can be cancelled' });
  }

  removeJobFromQueue(jobId);
  job.status = 'cancelled';
  job.error = 'Cancelled by operator';
  job.errorCode = 'OPERATOR_CANCELLED';
  job.finishedAt = new Date().toISOString();
  job.updatedAt = job.finishedAt;

  printJobs.set(jobId, job);
  recomputePrintMetrics();
  await persistPrintJobsToDisk();
  await appendPrintEvent('print_job_cancelled', { jobId });

  return res.json(job);
});

app.get('/health/printer', (_req, res) => {
  res.json({
    ok: true,
    printEnabled: PRINT_ENABLED,
    strategy: PRINT_STRATEGY,
    queueLength: printQueue.length,
    workerRunning: isPrintWorkerRunning,
    printerName: PRINT_PRINTER_NAME || null,
    metrics: {
      totalQueued: printMetrics.totalQueued,
      totalDone: printMetrics.totalDone,
      totalFailed: printMetrics.totalFailed,
      totalCancelled: printMetrics.totalCancelled,
      lastSuccessAt: printMetrics.lastSuccessAt || null,
      lastFailureAt: printMetrics.lastFailureAt || null,
      lastError: printMetrics.lastError || null,
    },
  });
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
  await loadPrintJobsFromDisk();
  await cleanupExpiredResults();
  await pruneOldPrintJobs();

  setInterval(() => {
    cleanupExpiredResults().catch((error) => console.error('cleanupExpiredResults error:', error.message));
  }, 60 * 60 * 1000).unref();

  setInterval(() => {
    pruneOldPrintJobs().catch((error) => console.error('pruneOldPrintJobs error:', error.message));
  }, 60 * 60 * 1000).unref();

  if (printQueue.length > 0) {
    void processPrintQueue();
  }

  app.listen(PORT, () => {
    console.log(`Kothak Photo server running on http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
