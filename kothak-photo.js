/* ===================================================
   KOTHAK PHOTO — Kiosk Photobooth Application Logic
   =================================================== */

(function () {
  'use strict';

  // ── Runtime Config ──
  const KothakConfig = window.KothakConfig || {};

  // ── State ──
  const PACKAGE_RULES = typeof KothakConfig.getPackageRules === 'function'
    ? KothakConfig.getPackageRules()
    : {
      reguler: {
        captureTimeSeconds: 60,
        allowedFrames: ['birthday'],
        allowedFilters: ['original', 'bw', 'warm'],
        printCopies: 1,
      },
      premium: {
        captureTimeSeconds: 90,
        allowedFrames: ['birthday', 'friends', 'picture-perfect'],
        allowedFilters: ['original', 'bw', 'vintage', 'warm', 'cool', 'dramatic', 'pastel', 'retro'],
        printCopies: 1,
      },
      group: {
        captureTimeSeconds: 120,
        allowedFrames: 'all',
        allowedFilters: ['original', 'bw', 'vintage', 'warm', 'cool', 'dramatic', 'pastel', 'retro'],
        printCopies: 2,
      },
    };

  const state = {
    currentScreen: 'screen-landing',
    history: [],
    selectedPackage: 'premium',
    packagePrices: { reguler: 25000, premium: 40000, group: 50000 },
    discount: 0,
    userName: '',
    userPhone: '',
    selectedFrame: 'birthday',
    selectedFramePhotos: 3,
    photos: [],
    currentPhotoIndex: 0,
    selectedFilter: 'original',
    orderId: '',
    paymentCompleted: false,
    paymentPollTimer: null,
    paymentTimer: null,
    paymentSeconds: 299,
    paymentTotalSeconds: 299,
    paymentExpiryAt: 0,
    paymentTransaction: null,
    returnTimer: null,
    returnSeconds: 30,
    cameraStream: null,
    resultDownloadUrl: '',
    resultShareUrl: '',
    resultShareQrDataUrl: '',
    resultToken: '',
    printRequested: false,
    printJobId: '',
    printJobStatus: '',
    printPollTimer: null,
    photoSessionTimer: null,
    photoSessionSeconds: 0,
  };

  let defaultPaymentQrMarkup = '';
  let defaultDownloadQrMarkup = '';

  // ── DOM Helpers ──
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

  const API_BASE_CANDIDATES = typeof KothakConfig.buildApiBaseCandidates === 'function'
    ? KothakConfig.buildApiBaseCandidates()
    : ['http://localhost:3000', 'http://127.0.0.1:3000'];
  const INTERNAL_API_KEY = typeof KothakConfig.getInternalApiKey === 'function'
    ? KothakConfig.getInternalApiKey()
    : '';


  async function apiFetchJson(path, options = {}) {
    let lastError = null;

    for (const baseUrl of API_BASE_CANDIDATES) {
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          ...options,
          headers: {
            Accept: 'application/json',
            ...(INTERNAL_API_KEY ? { 'x-internal-api-key': INTERNAL_API_KEY } : {}),
            ...(options.headers || {}),
          },
        });

        const rawText = await response.text();
        let payload = null;

        try {
          payload = rawText ? JSON.parse(rawText) : {};
        } catch {
          payload = rawText;
        }

        const contentType = response.headers.get('content-type') || '';
        const looksJson = contentType.includes('application/json') || typeof payload === 'object';

        if (!response.ok) {
          const message = typeof payload === 'object' && payload
            ? payload.error || payload.message || rawText
            : rawText;
          throw new Error(message || `Request failed with status ${response.status}`);
        }

        if (!looksJson) {
          throw new Error('API response is not JSON');
        }

        return payload;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('API request failed');
  }

  function getPackageRule() {
    return PACKAGE_RULES[state.selectedPackage] || PACKAGE_RULES.premium;
  }

  function formatSeconds(totalSeconds) {
    const sec = Math.max(0, Number(totalSeconds) || 0);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function ensureCameraTimerEl() {
    const instruction = $('#camera-instruction');
    if (!instruction) return null;
    let timerEl = $('#camera-session-timer');
    if (timerEl) return timerEl;

    timerEl = document.createElement('p');
    timerEl.id = 'camera-session-timer';
    timerEl.className = 'camera-session-timer';
    instruction.insertAdjacentElement('afterend', timerEl);
    return timerEl;
  }

  function renderCameraSessionTimer() {
    const timerEl = ensureCameraTimerEl();
    if (!timerEl) return;
    timerEl.textContent = `Sisa waktu sesi foto: ${formatSeconds(state.photoSessionSeconds)}`;
    timerEl.classList.toggle('danger', state.photoSessionSeconds <= 10);
  }

  function stopPhotoSessionTimer() {
    clearInterval(state.photoSessionTimer);
    state.photoSessionTimer = null;
  }

  function finishPhotoSessionDueToTimeout() {
    stopPhotoSessionTimer();
    if (state.currentScreen !== 'screen-camera') return;

    if (state.photos.length > 0) {
      showToast('Waktu habis, lanjut ke filter');
      goToScreen('screen-filter');
      return;
    }

    showToast('Waktu habis, silakan pilih frame lagi');
    goBack();
  }

  function startPhotoSessionTimer() {
    stopPhotoSessionTimer();
    const rule = getPackageRule();
    state.photoSessionSeconds = Math.max(15, Number(rule.captureTimeSeconds) || 90);
    renderCameraSessionTimer();

    state.photoSessionTimer = setInterval(() => {
      if (state.currentScreen !== 'screen-camera') return;
      state.photoSessionSeconds -= 1;
      renderCameraSessionTimer();
      if (state.photoSessionSeconds <= 0) {
        finishPhotoSessionDueToTimeout();
      }
    }, 1000);
  }

  function applyPackageFeatureVisibility() {
    const rule = getPackageRule();

    const allowedFrames = rule.allowedFrames === 'all'
      ? null
      : new Set(rule.allowedFrames || []);

    $$('.frame-card').forEach((card) => {
      const frameKey = card.dataset.frame;
      const allowed = !allowedFrames || allowedFrames.has(frameKey);
      card.classList.toggle('package-locked', !allowed);
      card.dataset.locked = allowed ? 'false' : 'true';
      card.style.opacity = allowed ? '' : '0.45';
      card.style.pointerEvents = allowed ? '' : 'none';
    });

    if (allowedFrames && !allowedFrames.has(state.selectedFrame)) {
      const fallback = (rule.allowedFrames || [])[0];
      if (fallback) {
        state.selectedFrame = fallback;
        const fallbackCard = $(`.frame-card[data-frame="${fallback}"]`);
        if (fallbackCard) {
          state.selectedFramePhotos = Number(fallbackCard.dataset.photos || 3);
        }
      }
    }

    $$('.frame-card').forEach((card) => {
      card.classList.toggle('selected', card.dataset.frame === state.selectedFrame);
    });

    const allowedFilters = new Set(rule.allowedFilters || []);
    if (!allowedFilters.has(state.selectedFilter)) {
      state.selectedFilter = 'original';
    }

    $$('.filter-chip').forEach((chip) => {
      const filterKey = chip.dataset.filter;
      const allowed = allowedFilters.has(filterKey);
      chip.disabled = !allowed;
      chip.classList.toggle('package-locked', !allowed);
      chip.style.opacity = allowed ? '' : '0.45';
      chip.style.pointerEvents = allowed ? '' : 'none';
      chip.classList.toggle('active', filterKey === state.selectedFilter);
    });
  }

  // ── Screen Navigation ──
  function goToScreen(id) {
    const current = $(`#${state.currentScreen}`);
    const next = $(`#${id}`);
    if (!current || !next || id === state.currentScreen) return;

    const leaveId = state.currentScreen;
    state.history.push(state.currentScreen);
    onScreenLeave(leaveId);
    current.classList.remove('active');
    current.classList.add('exit');
    setTimeout(() => current.classList.remove('exit'), 350);

    next.classList.add('active');
    state.currentScreen = id;

    // Screen-specific init
    onScreenEnter(id);
  }

  function goBack() {
    if (state.history.length === 0) return;
    const prevId = state.history.pop();
    const current = $(`#${state.currentScreen}`);
    const prev = $(`#${prevId}`);
    if (!current || !prev) return;

    const leaveId = state.currentScreen;
    onScreenLeave(leaveId);
    current.classList.remove('active');
    prev.classList.add('active');
    state.currentScreen = prevId;

    onScreenEnter(prevId);
  }

  function onScreenEnter(id) {
    switch (id) {
      case 'screen-payment': startPaymentTimer(); break;
      case 'screen-frame': applyPackageFeatureVisibility(); break;
      case 'screen-camera': initCamera(); break;
      case 'screen-filter':
        applyPackageFeatureVisibility();
        renderFilterPreview();
        break;
      case 'screen-result': initResult(); break;
    }
  }

  function onScreenLeave(id) {
    switch (id) {
      case 'screen-payment':
        clearInterval(state.paymentTimer);
        clearInterval(state.paymentPollTimer);
        if (!state.paymentCompleted) {
          void cancelPaymentSession();
        }
        const sandboxBadge = $('#sandbox-badge');
        if (sandboxBadge) sandboxBadge.style.display = 'none';
        break;
      case 'screen-camera':
        stopPhotoSessionTimer();
        stopCamera();
        break;
      case 'screen-result':
        clearInterval(state.returnTimer);
        clearInterval(state.printPollTimer);
        window.onafterprint = null;
        break;
    }
  }

  // ── Landing ──
  function initLanding() {
    $('#btn-start').addEventListener('click', () => goToScreen('screen-package'));
  }

  // ── Package Selection ──
  function initPackage() {
    $$('.package-card').forEach(card => {
      card.addEventListener('click', () => {
        $$('.package-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        state.selectedPackage = card.dataset.package;
        applyPackageFeatureVisibility();
        updatePriceSummary();
      });
    });
  }

  function updatePriceSummary() {
    const price = state.packagePrices[state.selectedPackage];
    const name = state.selectedPackage.charAt(0).toUpperCase() + state.selectedPackage.slice(1);
    const priceRow = $('#price-summary .price-row:first-child span:first-child');
    if (priceRow) priceRow.textContent = `Paket ${name}`;

    const origEl = $('#price-original');
    const totalEl = $('#price-total');
    const payTotal = $('#pay-total');

    if (state.discount > 0) {
      origEl.textContent = formatRp(price);
      origEl.classList.add('struck');
      const final = Math.max(0, price - state.discount);
      totalEl.textContent = formatRp(final);
      if (payTotal) payTotal.textContent = formatRp(final);
    } else {
      origEl.textContent = formatRp(price);
      origEl.classList.remove('struck');
      totalEl.textContent = formatRp(price);
      if (payTotal) payTotal.textContent = formatRp(price);
    }
  }

  function formatRp(num) {
    return `Rp ${num.toLocaleString('id-ID')}`;
  }

  function getCurrentAmount() {
    return Math.max(0, state.packagePrices[state.selectedPackage] - state.discount);
  }

  function createOrderId() {
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `KP-${timestamp}-${randomPart}`;
  }

  function setPaymentStatus(message, success = false) {
    const statusEl = $('.payment-status span:last-child');
    if (statusEl) statusEl.textContent = message;

    const dots = $('.status-dots');
    if (dots) {
      dots.innerHTML = success
        ? '<span class="material-symbols-rounded" style="color:#4ADE80;font-size:1.2rem">check_circle</span>'
        : '<span></span><span></span><span></span>';
    }
  }

  function renderPaymentQr(qrDataUrl) {
    const container = $('#qr-container');
    if (!container) return;

    if (!defaultPaymentQrMarkup) {
      defaultPaymentQrMarkup = container.innerHTML;
    }

    if (qrDataUrl) {
      container.innerHTML = `<img class="qr-image" src="${qrDataUrl}" alt="QRIS payment code" />`;
      return;
    }

    container.innerHTML = defaultPaymentQrMarkup;
  }

  function renderDownloadQr(qrDataUrl) {
    const container = $('#download-qr');
    if (!container) return;

    if (!defaultDownloadQrMarkup) {
      defaultDownloadQrMarkup = container.innerHTML;
    }

    if (qrDataUrl) {
      container.innerHTML = `<img class="mini-qr" src="${qrDataUrl}" alt="QR untuk download foto" />`;
      return;
    }

    container.innerHTML = defaultDownloadQrMarkup;
  }

  async function createPaymentSession() {
    return apiFetchJson('/api/qris/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: state.orderId,
        amount: getCurrentAmount(),
        packageId: state.selectedPackage,
        customerName: state.userName,
        customerPhone: state.userPhone,
      }),
    });

  }

  async function cancelPaymentSession() {
    if (!state.orderId) return;

    try {
      await apiFetchJson(`/api/qris/${encodeURIComponent(state.orderId)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: getCurrentAmount(),
          packageId: state.selectedPackage,
        }),
      });
    } catch (error) {
      console.warn('Failed to cancel payment session', error);
    }
  }

  function updatePaymentCountdown() {
    const remainingSeconds = state.paymentExpiryAt
      ? Math.max(0, Math.ceil((state.paymentExpiryAt - Date.now()) / 1000))
      : state.paymentSeconds;

    state.paymentSeconds = remainingSeconds;

    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    const text = $('#timer-text');
    if (text) text.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    const totalSeconds = Math.max(state.paymentTotalSeconds || 1, 1);
    const pct = Math.max(0, Math.min(100, (remainingSeconds / totalSeconds) * 100));
    const fill = $('#timer-fill');
    if (fill) fill.style.strokeDasharray = `${pct}, 100`;
  }

  function startPaymentCountdown() {
    clearInterval(state.paymentTimer);

    updatePaymentCountdown();

    state.paymentTimer = setInterval(() => {
      if (state.currentScreen !== 'screen-payment') return;

      updatePaymentCountdown();

      if (state.paymentSeconds <= 0) {
        clearInterval(state.paymentTimer);
      }
    }, 1000);
  }

  async function pollPaymentStatus() {
    if (!state.orderId || state.currentScreen !== 'screen-payment') return;

    try {
      const payload = await apiFetchJson(`/api/qris/${encodeURIComponent(state.orderId)}/status`);
      const status = (payload.status || payload.transaction?.status || payload.payment?.status || '').toLowerCase();

      if (['completed', 'paid', 'success'].includes(status)) {
        handlePaymentSuccess(payload);
        return;
      }

      if (['expired', 'canceled', 'cancelled', 'failed'].includes(status)) {
        handlePaymentExpired();
      }
    } catch (error) {
      console.warn('Payment status poll failed', error);
    }
  }

  function handlePaymentSuccess(payload) {
    if (state.paymentCompleted) return;

    state.paymentCompleted = true;
    clearInterval(state.paymentTimer);
    clearInterval(state.paymentPollTimer);
    state.paymentExpiryAt = 0;
    setPaymentStatus('Pembayaran berhasil! ✓', true);

    const transaction = payload?.payment || payload?.transaction || payload || {};
    state.paymentTransaction = transaction;
    state.resultShareUrl = payload?.downloadUrl
      || payload?.download_url
      || transaction?.downloadUrl
      || transaction?.download_url
      || state.resultShareUrl;

    const btnDone = $('#btn-payment-done');
    if (btnDone) btnDone.classList.remove('hidden');

    const timerText = $('#timer-text');
    if (timerText) timerText.textContent = '00:00';

    const fill = $('#timer-fill');
    if (fill) fill.style.strokeDasharray = '100, 100';

  }

  function handlePaymentExpired() {
    if (state.currentScreen !== 'screen-payment') return;

    clearInterval(state.paymentTimer);
    clearInterval(state.paymentPollTimer);
    setPaymentStatus('Pembayaran kedaluwarsa');
    showToast('Pembayaran kedaluwarsa');
    goBack();
  }

  function startMockPaymentSession() {
    state.paymentCompleted = false;
    state.paymentTransaction = null;
    state.paymentExpiryAt = Date.now() + (299 * 1000);
    state.paymentTotalSeconds = 299;
    state.paymentSeconds = 299;

    setPaymentStatus('Mode demo aktif - menunggu pembayaran...');
    const btnDone = $('#btn-payment-done');
    if (btnDone) btnDone.classList.add('hidden');

    startPaymentCountdown();

    clearInterval(state.paymentPollTimer);
    state.paymentPollTimer = setInterval(() => {
      if (state.currentScreen !== 'screen-payment') return;
      if (state.paymentSeconds <= 0) {
        clearInterval(state.paymentPollTimer);
      }
    }, 1000);

    setTimeout(() => {
      if (state.currentScreen !== 'screen-payment') return;
      handlePaymentSuccess({ payment: { status: 'completed' } });
    }, 5000);
  }

  // ── Data & Voucher ──
  const validateFormRules = {
    name: window.KothakValidators?.name || ((value) => {
      value = value.trim();
      if (!value) return 'Nama tidak boleh kosong';
      if (value.length < 3) return 'Nama minimal 3 karakter';
      if (!/^[a-zA-Z\s'-\.]+$/.test(value)) return 'Nama hanya boleh mengandung huruf';
      return null;
    }),
    phone: window.KothakValidators?.phone || ((value) => {
      value = value.trim().replace(/\s+/g, '');
      if (!value) return 'Nomor WhatsApp tidak boleh kosong';
      // Accept: 08xxx, +628xxx, 628xxx formats
      if (!/^(\+?62|0)8[0-9]{7,11}$/.test(value)) {
        return 'Format nomor WhatsApp tidak valid (0812xxx)';
      }
      return null;
    }),
  };

  function validateField(fieldName, value) {
    const rule = validateFormRules[fieldName];
    if (!rule) return null;
    return rule(value);
  }

  function updateFieldError(fieldName, error) {
    const input = fieldName === 'name' ? $('#input-name') : $('#input-phone');
    const errorEl = fieldName === 'name' ? $('#error-name') : $('#error-phone');
    const inputBox = input.parentElement;

    if (error) {
      inputBox.classList.add('error');
      errorEl.textContent = error;
      errorEl.classList.add('show');
    } else {
      inputBox.classList.remove('error');
      errorEl.textContent = '';
      errorEl.classList.remove('show');
    }

    return !error; // Return true if valid
  }

  function validateFormData() {
    const nameError = validateField('name', state.userName);
    const phoneError = validateField('phone', state.userPhone);

    const nameValid = updateFieldError('name', nameError);
    const phoneValid = updateFieldError('phone', phoneError);

    return nameValid && phoneValid;
  }

  function updatePaymentButtonState() {
    const btn = $$('.btn-next').find(b => b.dataset.goto === 'screen-payment');
    if (!btn) return;

    const isValid = validateFormData();
    btn.disabled = !isValid;
    btn.style.opacity = isValid ? '1' : '0.5';
    btn.style.cursor = isValid ? 'pointer' : 'not-allowed';
  }

  function initData() {
    const nameInput = $('#input-name');
    const phoneInput = $('#input-phone');

    if (nameInput) {
      nameInput.addEventListener('input', (event) => {
        state.userName = event.target.value.trim();
        validateField('name', state.userName);
        updateFieldError('name', validateField('name', state.userName));
        updatePaymentButtonState();
      });
    }

    if (phoneInput) {
      phoneInput.addEventListener('input', (event) => {
        state.userPhone = event.target.value.trim();
        validateField('phone', state.userPhone);
        updateFieldError('phone', validateField('phone', state.userPhone));
        updatePaymentButtonState();
      });
    }

    $('#btn-check-voucher').addEventListener('click', () => {
      const code = $('#input-voucher').value.trim().toUpperCase();
      const voucherEl = $('#voucher-success');
      const discountRow = $('#discount-row');

      if (code === 'PROMO10' || code === 'DISKON' || code === 'KOTHAK') {
        state.discount = 10000;
        voucherEl.classList.remove('hidden');
        discountRow.classList.remove('hidden');
        updatePriceSummary();
      } else if (code.length > 0) {
        state.discount = 0;
        voucherEl.classList.add('hidden');
        discountRow.classList.add('hidden');
        updatePriceSummary();
        showToast('Kode voucher tidak valid');
      }
    });

    // Initial state of payment button
    updatePaymentButtonState();
  }

  function showToast(msg) {
    let toast = $('#kiosk-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'kiosk-toast';
      toast.style.cssText = `
        position: fixed; bottom: 100px; left: 50%; transform: translateX(-50%);
        background: #ffb4ab; color: #690005; padding: 12px 24px;
        border-radius: 12px; font-family: var(--font-body); font-size: 0.9rem;
        font-weight: 600; z-index: 100; opacity: 0; transition: opacity 0.3s;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    setTimeout(() => toast.style.opacity = '0', 2500);
  }

  // ── Payment ──
  async function startPaymentTimer() {
    clearInterval(state.paymentTimer);
    clearInterval(state.paymentPollTimer);

    state.paymentCompleted = false;
    state.paymentTransaction = null;
    state.orderId = createOrderId();
    state.paymentExpiryAt = 0;
    state.paymentTotalSeconds = 299;
    state.paymentSeconds = 299;

    const btnDone = $('#btn-payment-done');
    if (btnDone) btnDone.classList.add('hidden');

    setPaymentStatus('Membuat QRIS...');
    updatePaymentCountdown();

    try {
      const data = await createPaymentSession();
      if (state.currentScreen !== 'screen-payment') return;

      const payment = data.payment || data.transaction || {};
      state.paymentTransaction = payment;

      // Extract QR with preference for direct qrDataUrl
      const qrDataUrl = data.qrDataUrl || data.qr_data_url || payment.qrDataUrl || payment.qr_data_url;
      
      if (!qrDataUrl) {
        throw new Error('QR Code tidak diterima dari API');
      }
      
      if (!qrDataUrl.startsWith('data:image')) {
        console.warn('⚠️ QR Code format unexpected:', { qrDataUrl: qrDataUrl.slice(0, 50) });
      }

      const expiration = data.expiresAt || payment.expired_at ? Date.parse(data.expiresAt || payment.expired_at) : NaN;
      state.paymentExpiryAt = Number.isFinite(expiration) ? expiration : (Date.now() + (299 * 1000));
      state.paymentSeconds = Math.max(0, Math.ceil((state.paymentExpiryAt - Date.now()) / 1000));
      state.paymentTotalSeconds = Math.max(state.paymentSeconds, 1);

      renderPaymentQr(qrDataUrl);
      setPaymentStatus('Menunggu pembayaran QRIS...');
      updatePaymentCountdown();
      startPaymentCountdown();

      // Show sandbox badge and hide after some time
      const sandboxBadge = $('#sandbox-badge');
      if (sandboxBadge) sandboxBadge.style.display = 'flex';

      // Auto-approve payment after 10 seconds for sandbox testing
      let sandboxCountdown = 10;
      clearInterval(state.paymentPollTimer);
      state.paymentPollTimer = setInterval(() => {
        if (state.currentScreen !== 'screen-payment') return;
        sandboxCountdown--;
        const countdownEl = $('#sandbox-countdown');
        if (countdownEl) countdownEl.textContent = Math.max(0, sandboxCountdown);
        
        if (sandboxCountdown <= 0) {
          clearInterval(state.paymentPollTimer);
          if (state.currentScreen === 'screen-payment') {
            handlePaymentSuccess({ payment: { status: 'completed' } });
          }
        }
      }, 1000);

      // Fallback polling in case user manually pays (every 3 seconds)
      void pollPaymentStatus();
    } catch (error) {
      console.error('❌ Payment session creation failed:', error);
      if (state.currentScreen !== 'screen-payment') return;
      console.info('ℹ️ Falling back to demo mode...');
      renderPaymentQr(null);
      setPaymentStatus('Mode demo (Backend tidak tersedia)');
      
      // Hide sandbox badge for fallback
      const sandboxBadge = $('#sandbox-badge');
      if (sandboxBadge) sandboxBadge.style.display = 'none';
      
      startMockPaymentSession();
    }
  }

  function updateTimerDisplay() {
    const remainingSeconds = state.paymentExpiryAt
      ? Math.max(0, Math.ceil((state.paymentExpiryAt - Date.now()) / 1000))
      : state.paymentSeconds;

    state.paymentSeconds = remainingSeconds;

    const m = Math.floor(remainingSeconds / 60);
    const s = remainingSeconds % 60;
    const text = $('#timer-text');
    if (text) text.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    const pct = (remainingSeconds / Math.max(state.paymentTotalSeconds || 1, 1)) * 100;
    const fill = $('#timer-fill');
    if (fill) fill.style.strokeDasharray = `${pct}, 100`;
  }

  // ── Frame Selection ──
  function initFrame() {
    // Category filter
    $$('.cat-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        $$('.cat-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const cat = chip.dataset.cat;
        filterFrames(cat);
      });
    });

    // Frame card selection
    $$('.frame-card').forEach(card => {
      card.addEventListener('click', () => {
        if (card.dataset.locked === 'true') {
          showToast('Frame ini tidak tersedia di paket kamu');
          return;
        }
        $$('.frame-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        state.selectedFrame = card.dataset.frame;
        state.selectedFramePhotos = parseInt(card.dataset.photos);
      });
    });
  }

  function filterFrames(cat) {
    $$('.frame-card').forEach(card => {
      if (cat === 'all' || card.dataset.cat === cat) {
        card.style.display = '';
      } else {
        card.style.display = 'none';
      }
    });
  }

  // ── Camera ──
  async function initCamera() {
    state.photos = [];
    state.currentPhotoIndex = 0;
    updateCameraUI();
    startPhotoSessionTimer();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false
      });
      state.cameraStream = stream;
      const video = $('#camera-feed');
      video.srcObject = stream;
    } catch (err) {
      console.warn('Camera not available, using placeholder:', err.message);
      // Draw placeholder on viewfinder
      const viewfinder = $('#viewfinder');
      viewfinder.style.background = 'linear-gradient(135deg, #142032, #1f2a3d)';
      viewfinder.querySelector('.viewfinder-overlay').innerHTML = `
        <div style="text-align:center;color:var(--outline)">
          <span class="material-symbols-rounded" style="font-size:3rem">photo_camera</span>
          <p style="margin-top:8px;font-size:0.85rem">Kamera tidak tersedia<br/>Mode demo aktif</p>
        </div>`;
    }

    // Capture button
    const btnCapture = $('#btn-capture');
    btnCapture.onclick = startCountdown;

    // Retake
    const btnRetake = $('#btn-retake');
    btnRetake.onclick = () => {
      state.photos.pop();
      btnRetake.classList.add('hidden');
      $('#btn-photo-ok').classList.add('hidden');
      btnCapture.classList.remove('hidden');
      updateCameraUI();
    };

    // OK
    const btnOk = $('#btn-photo-ok');
    btnOk.onclick = () => {
      state.currentPhotoIndex++;
      btnRetake.classList.add('hidden');
      btnOk.classList.add('hidden');
      btnCapture.classList.remove('hidden');

      if (state.currentPhotoIndex >= state.selectedFramePhotos) {
        // All photos taken
        stopPhotoSessionTimer();
        goToScreen('screen-filter');
      } else {
        updateCameraUI();
      }
    };
  }

  function updateCameraUI() {
    const idx = state.currentPhotoIndex;
    const total = state.selectedFramePhotos;

    // Update progress dots
    const progress = $('#photo-progress');
    progress.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      if (i < idx) dot.classList.add('done');
      if (i === idx) dot.classList.add('active');
      progress.appendChild(dot);
    }

    // Update text
    $('#photo-num').textContent = idx + 1;
    $('#photo-total').textContent = total;

    // Update thumbnails
    const thumbs = $('#photo-thumbnails');
    thumbs.innerHTML = '';
    state.photos.forEach((photo, i) => {
      const div = document.createElement('div');
      div.className = 'thumb' + (i === idx ? ' current' : '');
      const img = document.createElement('img');
      img.src = photo;
      div.appendChild(img);
      thumbs.appendChild(div);
    });
  }

  function startCountdown() {
    const overlay = $('#countdown-overlay');
    const numEl = $('#countdown-num');
    overlay.classList.remove('hidden');
    $('#btn-capture').classList.add('hidden');

    let count = 3;
    numEl.textContent = count;

    const interval = setInterval(() => {
      count--;
      if (count > 0) {
        numEl.textContent = count;
        numEl.style.animation = 'none';
        numEl.offsetHeight; // trigger reflow
        numEl.style.animation = 'count-pop 1s ease-out';
      } else {
        clearInterval(interval);
        overlay.classList.add('hidden');
        capturePhoto();
      }
    }, 1000);
  }

  function capturePhoto() {
    // Flash effect
    const flash = $('#flash-overlay');
    flash.classList.remove('hidden');
    setTimeout(() => flash.classList.add('hidden'), 300);

    // Capture from video or generate placeholder
    const canvas = $('#hidden-canvas');
    const ctx = canvas.getContext('2d');
    const video = $('#camera-feed');

    if (state.cameraStream && video.videoWidth > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.save();
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0);
      ctx.restore();
    } else {
      // Demo placeholder
      canvas.width = 640;
      canvas.height = 480;
      const grad = ctx.createLinearGradient(0, 0, 640, 480);
      const colors = ['#1f2a3d', '#2a3548', '#142032', '#0a1628'];
      const idx = state.currentPhotoIndex % colors.length;
      grad.addColorStop(0, colors[idx]);
      grad.addColorStop(1, colors[(idx + 1) % colors.length]);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = 'rgba(255, 219, 60, 0.15)';
      ctx.beginPath();
      ctx.arc(320, 200, 80, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#bbc7df';
      ctx.font = '600 20px "Plus Jakarta Sans"';
      ctx.textAlign = 'center';
      ctx.fillText(`Foto ${state.currentPhotoIndex + 1}`, 320, 360);
    }

    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    state.photos.push(dataUrl);

    // Show retake / OK buttons
    $('#btn-retake').classList.remove('hidden');
    $('#btn-photo-ok').classList.remove('hidden');
    updateCameraUI();
  }

  function stopCamera() {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach(t => t.stop());
      state.cameraStream = null;
    }
  }

  // ── Filters ──
  function initFilter() {
    $$('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        $$('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.selectedFilter = chip.dataset.filter;
        renderFilterPreview();
      });
    });

    $('#btn-finish').addEventListener('click', () => {
      goToScreen('screen-result');
    });
  }

  async function renderFilterPreview() {
    const canvas = $('#filter-canvas');
    const ctx = canvas.getContext('2d');

    // ── Custom overlay frame config dengan transparent holes ──
    // holes: koordinat relatif (0-1) untuk tiap lubang foto
    // Frame PNG sudah punya transparansi di area lubang
    const OVERLAY_FRAMES = {
      'birthday': {
        src: 'assets/frames/birthday.png',
        holes: [
          { rx: 0.106, ry: 0.169, rw: 0.757, rh: 0.180 },
          { rx: 0.122, ry: 0.410, rw: 0.730, rh: 0.178 },
          { rx: 0.102, ry: 0.658, rw: 0.757, rh: 0.177 }
        ]
      },
      'friends': {
        src: 'assets/frames/friends.png',
        holes: [
          { rx: 0.138, ry: 0.046, rw: 0.728, rh: 0.236 },
          { rx: 0.136, ry: 0.337, rw: 0.730, rh: 0.239 },
          { rx: 0.141, ry: 0.636, rw: 0.723, rh: 0.235 }
        ]
      },
      'newspaper': {
        src: 'assets/frames/newspaper.png',
        holes: [
          { rx: 0.384, ry: 0.337, rw: 0.588, rh: 0.297 },
          { rx: 0.033, ry: 0.688, rw: 0.290, rh: 0.182 },
          { rx: 0.683, ry: 0.688, rw: 0.289, rh: 0.183 }
        ]
      },
      'filmstrip': {
        src: 'assets/frames/filmstrip.png',
        holes: [
          { rx: 0.117, ry: 0.337, rw: 0.770, rh: 0.100 },
          { rx: 0.117, ry: 0.450, rw: 0.770, rh: 0.100 },
          { rx: 0.117, ry: 0.563, rw: 0.770, rh: 0.100 }
        ]
      },
      'fish': {
        src: 'assets/frames/fish.png',
        holes: [
          { rx: 0.079, ry: 0.118, rw: 0.842, rh: 0.384 },
          { rx: 0.077, ry: 0.538, rw: 0.842, rh: 0.380 }
        ]
      },
      'moments-friends': {
        src: 'assets/frames/frame-cleaned (1).png',
        holes: [
          { rx: 0.135785, ry: 0.055500, rw: 0.729844, rh: 0.161500 },
          { rx: 0.135785, ry: 0.295000, rw: 0.729844, rh: 0.161500 },
          { rx: 0.137199, ry: 0.534000, rw: 0.729844, rh: 0.162000 }
        ]
      },
      'live-moment': {
        src: 'assets/frames/frame-cleaned (2).png',
        holes: [
          { rx: 0.141667, ry: 0.064583, rw: 0.716667, rh: 0.226562 },
          { rx: 0.141667, ry: 0.321875, rw: 0.716667, rh: 0.226562 },
          { rx: 0.141667, ry: 0.579167, rw: 0.716667, rh: 0.226562 }
        ]
      },
      'picture-perfect': {
        src: 'assets/frames/frame-cleaned.png',
        holes: [
          { rx: 0.063889, ry: 0.035417, rw: 0.871296, rh: 0.289583 },
          { rx: 0.063889, ry: 0.355208, rw: 0.871296, rh: 0.289583 },
          { rx: 0.063889, ry: 0.675000, rw: 0.871296, rh: 0.289583 }
        ]
      }
    };

    if (OVERLAY_FRAMES[state.selectedFrame]) {
      const config = OVERLAY_FRAMES[state.selectedFrame];

      // Load frame image
      const frameImg = await new Promise((resolve) => {
        const img = new Image();
        img.src = config.src;
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
      });

      if (!frameImg) { return; }

      // Set canvas to high resolution matching frame aspect ratio
      const RENDER_WIDTH = 1080;
      canvas.width = RENDER_WIDTH;
      canvas.height = Math.round(RENDER_WIDTH * (frameImg.height / frameImg.width));

      const W = canvas.width;
      const H = canvas.height;
      const holes = config.holes;
      const photos = state.photos.length > 0 ? state.photos : [];

      // Load user photos
      const loadedImages = await Promise.all(holes.map((hole, i) => {
        return new Promise((resolve) => {
          if (!photos[i]) return resolve(null);
          const img = new Image();
          img.src = photos[i];
          img.onload = () => resolve(img);
          img.onerror = () => resolve(null);
        });
      }));

      function drawCover(ctx, img, x, y, w, h) {
        // Smart aspect ratio matching: crop photo untuk pas dengan hole
        const holeAspect = w / h;
        const photoAspect = img.width / img.height;

        let sx = 0, sy = 0, sw = img.width, sh = img.height;

        if (photoAspect > holeAspect) {
          // Photo lebih lebar: crop width
          sw = img.height * holeAspect;
          sx = (img.width - sw) / 2;
        } else {
          // Photo lebih tinggi: crop height
          sh = img.width / holeAspect;
          sy = (img.height - sh) / 2;
        }

        ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
      }

      // STEP 1: White background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);

      // STEP 2: Draw photos dalam posisi lubang (clipped)
      holes.forEach((hole, i) => {
        const x = Math.round(W * hole.rx);
        const y = Math.round(H * hole.ry);
        const w = Math.round(W * hole.rw);
        const h = Math.round(H * hole.rh);

        const img = loadedImages[i];
        if (img) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
          drawCover(ctx, img, x, y, w, h);
          applyFilter(ctx, x, y, w, h, state.selectedFilter);
          ctx.restore();
        }
      });

      // STEP 3: Draw frame PNG di atas foto - transparent hole akan menampilkan foto di bawah
      ctx.drawImage(frameImg, 0, 0, W, H);

      return;
    }

    if (canvas.height !== 560) {
      canvas.height = 560;
    }
    const w = canvas.width;
    const h = canvas.height;
    const photos = state.photos.length > 0 ? state.photos : [];

    switch (state.selectedFrame) {
      case 'newspaper': ctx.fillStyle = '#F5E6C8'; break;
      case 'love':
        let gradLove = ctx.createLinearGradient(0, 0, w, h);
        gradLove.addColorStop(0, '#FFB6C1'); gradLove.addColorStop(1, '#FF69B4');
        ctx.fillStyle = gradLove; break;
      case 'corgi':
        let gradCorgi = ctx.createLinearGradient(0, 0, 0, h);
        gradCorgi.addColorStop(0, '#B5D8F7'); gradCorgi.addColorStop(1, '#8EC5E5');
        ctx.fillStyle = gradCorgi; break;
      case 'classic': ctx.fillStyle = '#ffffff'; break;
      case 'vintage':
        let gradVint = ctx.createLinearGradient(0, 0, w, h);
        gradVint.addColorStop(0, '#D4A76A'); gradVint.addColorStop(1, '#C4965A');
        ctx.fillStyle = gradVint; break;
      case 'floral': ctx.fillStyle = '#fce4ec'; break;
      case 'neon': ctx.fillStyle = '#0a0a1a'; break;
      case 'aesthetic': ctx.fillStyle = '#ffffff'; break;
      case 'moments-friends': ctx.fillStyle = '#f5f5f5'; break;
      case 'live-moment': ctx.fillStyle = '#f0e8e0'; break;
      case 'picture-perfect': ctx.fillStyle = '#ffffff'; break;
      default: ctx.fillStyle = '#142032';
    }
    ctx.fillRect(0, 0, w, h);

    function drawBgDecorations() {
      if (state.selectedFrame === 'newspaper') {
        ctx.fillStyle = '#2C1810';
        ctx.textAlign = 'center';
        ctx.font = 'italic 700 24px "Playfair Display", serif';
        ctx.fillText('The Kothak Times', w / 2, 35);
        ctx.fillRect(20, 50, w - 40, 2);
        ctx.font = '900 28px "Playfair Display", serif';
        ctx.fillText('TOENDJOENGAN', w / 2, 85);
        ctx.fillText('TEMPOE DOELOE', w / 2, 115);
        ctx.font = 'italic 12px serif';
        ctx.fillStyle = '#6B5745';
        ctx.fillText('Kisah Sejarah dalam Satu Bingkai', w / 2, 135);
        ctx.fillRect(20, h - 30, w - 40, 1);
        ctx.font = '10px serif';
        ctx.fillText('Kothak Photo Edition', w / 2, h - 15);
      }
    }

    function drawFgDecorations() {
      if (state.selectedFrame === 'classic') {
        ctx.fillStyle = '#000';
        ctx.textAlign = 'left';
        ctx.font = '700 16px "Plus Jakarta Sans"';
        ctx.fillText('Kothak Photo', 20, h - 20);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#888';
        ctx.font = '400 12px "Plus Jakarta Sans"';
        ctx.fillText('03.04.2026', w - 20, h - 20);
      } else if (state.selectedFrame === 'corgi') {
        ctx.fillStyle = '#2e5f8a';
        ctx.textAlign = 'center';
        ctx.font = '800 24px "Plus Jakarta Sans"';
        ctx.fillText('WOOF WOOF! 🐕', w / 2, 40);
        ctx.font = '600 14px "Plus Jakarta Sans"';
        ctx.fillText('Kothak Photo 🐾', w / 2, h - 20);
      } else if (state.selectedFrame === 'love') {
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.textAlign = 'center';
        ctx.font = 'italic 36px Georgia, serif';
        ctx.fillText('Love', w / 2, h - 45);
        ctx.font = '14px sans-serif';
        ctx.fillText('Kothak Photo ♥', w / 2, h - 20);
      } else if (state.selectedFrame === 'vintage') {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.textAlign = 'center';
        ctx.font = 'italic 18px Georgia, serif';
        ctx.fillText('Kothak Vintage', w / 2, h - 15);
      } else if (state.selectedFrame !== 'newspaper') {
        ctx.fillStyle = (state.selectedFrame === 'neon') ? '#00ffff' : '#d4a76a';
        ctx.textAlign = 'center';
        ctx.font = '800 16px "Plus Jakarta Sans"';
        ctx.fillText('KOTHAK PHOTO', w / 2, h - 20);
      }
    }

    drawBgDecorations();

    let layout = [];
    if (state.selectedFrame === 'newspaper') {
      layout = [
        { x: 20, y: 155, w: w - 40, h: 210 },
        { x: 20, y: 375, w: (w - 50) / 2, h: 140 },
        { x: 20 + (w - 50) / 2 + 10, y: 375, w: (w - 50) / 2, h: 140 }
      ];
    } else if (state.selectedFrame === 'classic' || state.selectedFrame === 'neon') {
      const p = 20; const cellH = (h - 80 - p * 2 - 3 * 10) / 4;
      for (let i = 0; i < 4; i++) layout.push({ x: p, y: p + i * (cellH + 10), w: w - p * 2, h: cellH });
    } else {
      const cols = 2;
      const rows = Math.ceil(state.selectedFramePhotos / cols);
      const padding = 20;
      const gap = 10;
      const cellW = (w - padding * 2 - gap * (cols - 1)) / cols;
      const cellTopPad = (state.selectedFrame === 'corgi') ? 60 : padding;
      const cellBotPad = 70;
      const cellH = (h - cellTopPad - cellBotPad - gap * (rows - 1)) / rows;

      for (let i = 0; i < state.selectedFramePhotos; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        layout.push({ x: padding + col * (cellW + gap), y: cellTopPad + row * (cellH + gap), w: cellW, h: cellH });
      }
    }

    const loadedImages = await Promise.all(layout.map((rect, i) => {
      return new Promise((resolve) => {
        if (!photos[i]) return resolve(null);
        const img = new Image();
        img.src = photos[i];
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
      });
    }));

    layout.forEach((rect, i) => {
      ctx.fillStyle = '#1f2a3d';
      if (state.selectedFrame === 'classic') ctx.fillStyle = '#e8e8e8';
      if (state.selectedFrame === 'newspaper') ctx.fillStyle = '#d4c4a8';
      if (state.selectedFrame === 'neon') { ctx.fillStyle = '#1a0033'; ctx.strokeStyle = '#00ffff'; ctx.strokeRect(rect.x, rect.y, rect.w, rect.h); }

      if (state.selectedFrame === 'vintage') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(rect.x - 6, rect.y - 6, rect.w + 12, rect.h + 30);
        ctx.fillStyle = '#e0d4c4';
      }

      if (state.selectedFrame !== 'vintage' && state.selectedFrame !== 'neon') {
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      } else if (state.selectedFrame === 'vintage') {
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      }

      if (state.selectedFrame === 'classic' || state.selectedFrame === 'newspaper') {
        ctx.strokeStyle = (state.selectedFrame === 'classic') ? '#d0d0d0' : '#b8a88c';
        ctx.lineWidth = 2;
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      }

      const img = loadedImages[i];
      if (img) {
        ctx.save();
        if (state.selectedFrame === 'corgi') {
          ctx.beginPath();
          ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, Math.min(rect.w, rect.h) / 2, 0, Math.PI * 2);
          ctx.clip();
        } else {
          ctx.beginPath();
          ctx.rect(rect.x, rect.y, rect.w, rect.h);
          ctx.clip();
        }

        const scale = Math.max(rect.w / img.width, rect.h / img.height);
        const iw = img.width * scale;
        const ih = img.height * scale;
        ctx.drawImage(img, rect.x + (rect.w - iw) / 2, rect.y + (rect.h - ih) / 2, iw, ih);
        applyFilter(ctx, rect.x, rect.y, rect.w, rect.h, state.selectedFilter);
        ctx.restore();

        if (state.selectedFrame === 'corgi') {
          ctx.beginPath();
          ctx.arc(rect.x + rect.w / 2, rect.y + rect.h / 2, Math.min(rect.w, rect.h) / 2, 0, Math.PI * 2);
          ctx.lineWidth = 4;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        }
      }
    });

    drawFgDecorations();
  }

  function applyFilter(ctx, x, y, w, h, filter) {
    switch (filter) {
      case 'bw':
        ctx.fillStyle = 'rgba(0,0,0,0.15)';
        ctx.fillRect(x, y, w, h);
        ctx.globalCompositeOperation = 'saturation';
        ctx.fillStyle = 'gray';
        ctx.fillRect(x, y, w, h);
        ctx.globalCompositeOperation = 'source-over';
        break;
      case 'vintage':
        ctx.fillStyle = 'rgba(180, 130, 60, 0.2)';
        ctx.fillRect(x, y, w, h);
        break;
      case 'warm':
        ctx.fillStyle = 'rgba(255, 140, 50, 0.12)';
        ctx.fillRect(x, y, w, h);
        break;
      case 'cool':
        ctx.fillStyle = 'rgba(60, 130, 255, 0.12)';
        ctx.fillRect(x, y, w, h);
        break;
      case 'dramatic':
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.fillRect(x, y, w, h);
        break;
      case 'pastel':
        ctx.fillStyle = 'rgba(255, 200, 220, 0.15)';
        ctx.fillRect(x, y, w, h);
        break;
      case 'retro':
        ctx.fillStyle = 'rgba(200, 150, 50, 0.18)';
        ctx.fillRect(x, y, w, h);
        break;
    }
  }

  function getResultFileName() {
    return `kothak-photo-${state.orderId || Date.now()}.png`;
  }

  function downloadCanvasImage(canvas, fileName) {
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function createResultShareSession() {
    const resultCanvas = $('#result-canvas');
    if (!resultCanvas) return null;

    return apiFetchJson('/api/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: state.orderId,
        packageId: state.selectedPackage,
        customerName: state.userName,
        imageDataUrl: resultCanvas.toDataURL('image/png'),
      }),
    });

  }

  function updatePrintUi(status, message) {
    const printStatus = $('#print-status-text');
    const printIcon = $('.print-icon');
    const printBar = $('#print-bar');

    if (printStatus && message) printStatus.textContent = message;

    if (!printIcon || !printBar) return;

    if (status === 'queued') {
      printIcon.classList.add('spinning');
      printIcon.textContent = 'sync';
      printIcon.style.color = '';
      printBar.style.width = '30%';
      return;
    }

    if (status === 'printing') {
      printIcon.classList.add('spinning');
      printIcon.textContent = 'print';
      printIcon.style.color = '';
      printBar.style.width = '70%';
      return;
    }

    if (status === 'done') {
      printIcon.classList.remove('spinning');
      printIcon.textContent = 'check_circle';
      printIcon.style.color = '#4ADE80';
      printBar.style.width = '100%';
      return;
    }

    if (status === 'failed') {
      printIcon.classList.remove('spinning');
      printIcon.textContent = 'error';
      printIcon.style.color = '#FF6B6B';
      printBar.style.width = '100%';
    }
  }

  async function requestServerPrint() {
    if (!state.resultToken) {
      updatePrintUi('failed', 'Token hasil tidak tersedia');
      return;
    }

      const job = await apiFetchJson('/api/print-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: state.resultToken,
        orderId: state.orderId,
        copies: getPackageRule().printCopies || 1,
      }),
    });

    state.printJobId = job.id || '';
    state.printJobStatus = job.status || 'queued';
    updatePrintUi(state.printJobStatus, state.printJobStatus === 'done' ? 'Cetak selesai' : 'Job cetak dibuat');

    if (!state.printJobId) return;

    clearInterval(state.printPollTimer);
    state.printPollTimer = setInterval(async () => {
      try {
        const latest = await apiFetchJson(`/api/print-jobs/${encodeURIComponent(state.printJobId)}`);
        state.printJobStatus = latest.status || state.printJobStatus;

        if (state.printJobStatus === 'queued') updatePrintUi('queued', 'Antrian cetak...');
        if (state.printJobStatus === 'printing') updatePrintUi('printing', 'Sedang mencetak...');
        if (state.printJobStatus === 'done') {
          updatePrintUi('done', 'Cetak selesai');
          clearInterval(state.printPollTimer);
        }
        if (state.printJobStatus === 'failed') {
          updatePrintUi('failed', `Cetak gagal: ${latest.error || 'unknown error'}`);
          clearInterval(state.printPollTimer);
        }
      } catch (error) {
        console.warn('Print status poll failed', error);
      }
    }, 1500);
  }

  function syncResultActions() {
    const resultCanvas = $('#result-canvas');
    const btnDownload = $('#btn-download');
    const btnPrint = $('#btn-print');

    if (resultCanvas) {
      state.resultDownloadUrl = resultCanvas.toDataURL('image/png');
    }

    if (btnDownload) {
      btnDownload.onclick = () => {
        if (!resultCanvas) {
          showToast('Hasil belum siap');
          return;
        }

        downloadCanvasImage(resultCanvas, getResultFileName());
      };
    }

    if (btnPrint) {
      btnPrint.onclick = async () => {
        try {
          state.printRequested = true;
          updatePrintUi('queued', 'Mengirim job cetak...');
          await requestServerPrint();
        } catch (error) {
          console.warn('Server print failed, fallback to browser print', error);
          updatePrintUi('failed', 'Server print gagal, buka dialog cetak manual');
          window.print();
        }
      };
    }

    renderDownloadQr(
      state.resultShareQrDataUrl
        || state.paymentTransaction?.downloadQrDataUrl
        || state.paymentTransaction?.download_qr_data_url
        || null,
    );
  }

  function preparePrintHooks() {
    const printStatus = $('#print-status-text');
    const printIcon = $('.print-icon');
    const printBar = $('#print-bar');

    const markReady = () => {
      if (printStatus) printStatus.textContent = 'Siap kirim ke printer';
      if (printIcon) {
        printIcon.classList.remove('spinning');
        printIcon.textContent = 'print';
        printIcon.style.color = '#4ADE80';
      }
      if (printBar) printBar.style.width = '100%';
    };

    if (state.printRequested) {
      markReady();
      return;
    }

    markReady();

    window.onafterprint = () => {
      state.printRequested = false;
      if (printStatus) printStatus.textContent = 'Cetak selesai';
      if (printIcon) {
        printIcon.classList.remove('spinning');
        printIcon.textContent = 'check_circle';
      }
    };
  }

  // ── Result ──
  async function initResult() {
    await renderFilterPreview();
    const srcCanvas = $('#filter-canvas');
    const destCanvas = $('#result-canvas');
    destCanvas.width = srcCanvas.width;
    destCanvas.height = srcCanvas.height;
    const ctx = destCanvas.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0);

    state.resultDownloadUrl = destCanvas.toDataURL('image/png');
    state.resultShareUrl = state.paymentTransaction?.downloadUrl || state.paymentTransaction?.download_url || '';
    state.resultShareQrDataUrl = '';
    state.resultToken = '';

    try {
      const shareSession = await createResultShareSession();
      if (shareSession) {
        state.resultShareUrl = shareSession.downloadUrl || shareSession.download_url || state.resultShareUrl;
        state.resultShareQrDataUrl = shareSession.downloadQrDataUrl || shareSession.download_qr_data_url || '';
        state.resultToken = shareSession.token || '';
      }
    } catch (error) {
      console.warn('Failed to create result share session', error);
    }

    syncResultActions();
    preparePrintHooks();

    // Confetti
    launchConfetti();

    // Auto-return timer
    state.returnSeconds = 30;
    const returnEl = $('#return-timer');
    state.returnTimer = setInterval(() => {
      state.returnSeconds--;
      if (returnEl) returnEl.textContent = state.returnSeconds;
      if (state.returnSeconds <= 0) {
        clearInterval(state.returnTimer);
        resetApp();
      }
    }, 1000);

    // Done button
    $('#btn-done').onclick = () => {
      clearInterval(state.returnTimer);
      resetApp();
    };
  }

  function launchConfetti() {
    const container = $('#confetti');
    container.innerHTML = '';
    const colors = ['#ffdb3c', '#ff69b4', '#4ADE80', '#bbc7df', '#ffe16d', '#00ffff'];

    for (let i = 0; i < 40; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + '%';
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDelay = (Math.random() * 2) + 's';
      piece.style.animationDuration = (2 + Math.random() * 2) + 's';
      piece.style.width = (4 + Math.random() * 8) + 'px';
      piece.style.height = (8 + Math.random() * 12) + 'px';
      piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
      container.appendChild(piece);
    }
  }

  function resetApp() {
    // Clean up
    stopCamera();
    clearInterval(state.paymentTimer);
    clearInterval(state.paymentPollTimer);
    clearInterval(state.returnTimer);
    clearInterval(state.printPollTimer);
    window.onafterprint = null;

    // Reset state
    state.photos = [];
    state.currentPhotoIndex = 0;
    state.discount = 0;
    state.userName = '';
    state.userPhone = '';
    state.selectedPackage = 'premium';
    state.selectedFrame = 'birthday';
    state.selectedFramePhotos = 3;
    state.selectedFilter = 'original';
    state.history = [];
    state.orderId = '';
    state.paymentCompleted = false;
    state.paymentSeconds = 299;
    state.paymentTotalSeconds = 299;
    state.paymentExpiryAt = 0;
    state.paymentTransaction = null;
    state.resultDownloadUrl = '';
    state.resultShareUrl = '';
    state.resultToken = '';
    state.printRequested = false;
    state.printJobId = '';
    state.printJobStatus = '';
    state.photoSessionSeconds = 0;
    stopPhotoSessionTimer();

    // Reset UI
    $$('.voucher-success').forEach(el => el.classList.add('hidden'));
    $$('#discount-row').forEach(el => el.classList.add('hidden'));
    $('#input-name').value = '';
    $('#input-phone').value = '';
    $('#input-voucher').value = '';
    $('#btn-payment-done').classList.add('hidden');
    $$('.package-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.package === state.selectedPackage);
    });
    $$('.frame-card').forEach(card => {
      card.classList.toggle('selected', card.dataset.frame === state.selectedFrame);
    });
    applyPackageFeatureVisibility();
    renderPaymentQr(null);
    renderDownloadQr(null);
    setPaymentStatus('Siap memulai pembayaran');
    $$('.filter-chip').forEach(c => c.classList.remove('active'));
    $$('.filter-chip')[0]?.classList.add('active');
    const printStatus = $('#print-status-text');
    if (printStatus) printStatus.textContent = 'Sedang mencetak...';
    const printIcon = $('.print-icon');
    if (printIcon) {
      printIcon.classList.add('spinning');
      printIcon.textContent = 'sync';
      printIcon.style.color = '';
    }
    const printBar = $('#print-bar');
    if (printBar) printBar.style.width = '0%';

    updatePriceSummary();

    // Go to landing
    $$('.screen').forEach(s => s.classList.remove('active', 'exit'));
    $('#screen-landing').classList.add('active');
    state.currentScreen = 'screen-landing';
  }

  // ── Navigation Handlers ──
  function initNavigation() {
    // All next buttons
    $$('.btn-next').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.goto;
        
        // Validate form if going to payment
        if (target === 'screen-payment') {
          if (!validateFormData()) {
            showToast('Harap isi data dengan benar sebelum melanjutkan');
            return;
          }
        }
        
        if (target) goToScreen(target);
      });
    });

    // All back buttons
    $$('[data-action="back"]').forEach(btn => {
      btn.addEventListener('click', goBack);
    });
  }

  // ── Bootstrap ──
  function init() {
    initNavigation();
    initLanding();
    initPackage();
    initData();
    initFrame();
    initFilter();
    applyPackageFeatureVisibility();
    updatePriceSummary();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
