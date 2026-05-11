(function () {
  'use strict';

  const OPERATOR_PIN_STORAGE_KEY = 'kothak-operator-pin';
  const OPERATOR_QUEUE_STORAGE_KEY = 'kothak-operator-queue';
  const PACKAGE_RULES_STORAGE_KEY = 'kothak-package-rules';
  const PRINT_SIZE_STORAGE_KEY = 'kothak-print-size';

  const PRINT_SIZE_PRESETS = {
    '2x6': { widthMm: 50.8, heightMm: 152.4 },
    '4x6': { widthMm: 101.6, heightMm: 152.4 },
    '2x3': { widthMm: 50.8, heightMm: 76.2 },
  };

  const FRAME_OPTIONS = ['birthday', 'friends', 'newspaper', 'filmstrip', 'fish', 'moments-friends', 'live-moment', 'picture-perfect'];
  const FILTER_OPTIONS = ['original', 'bw', 'vintage', 'warm', 'cool', 'softglow', 'film', 'natural', 'dramatic', 'pastel', 'retro'];
  const PRICE_STORAGE_KEY = 'kothak-package-prices';
  const DEFAULT_PACKAGE_PRICES = { single: 15000, couple: 25000, group: 35000 };
  const PACKAGE_LABELS = {
    single: 'Single',
    couple: 'Duo / Couple',
    group: 'Grup',
  };

  const $ = (s, c = document) => c.querySelector(s);

  let gateUnlocked = false;

  function normalizePackageKey(pkgKey) {
    if (typeof window.KothakConfig?.normalizePackageKey === 'function') {
      return window.KothakConfig.normalizePackageKey(pkgKey);
    }
    const key = String(pkgKey || '').trim().toLowerCase();
    if (key === 'bestie') return 'couple';
    if (key === 'signature') return 'group';
    if (key === 'single' || key === 'couple' || key === 'group') return key;
    return '';
  }

  function getPackageLabel(pkgKey) {
    return PACKAGE_LABELS[normalizePackageKey(pkgKey)] || String(pkgKey || '-');
  }

  function normalizePackagePrices(source) {
    const prices = { ...DEFAULT_PACKAGE_PRICES };
    if (!source || typeof source !== 'object') return prices;
    for (const [rawKey, rawValue] of Object.entries(source)) {
      const key = normalizePackageKey(rawKey);
      if (!key) continue;
      prices[key] = Math.max(0, Number(rawValue) || prices[key] || 0);
    }
    return prices;
  }

  function readPin() {
    const fromStorage = window.localStorage?.getItem(OPERATOR_PIN_STORAGE_KEY);
    if (fromStorage && String(fromStorage).trim()) return String(fromStorage).trim();
    const fromConfig = typeof window.KothakConfig?.getOperatorPin === 'function' ? window.KothakConfig.getOperatorPin() : '';
    return String(fromConfig || '').trim();
  }

  function readQueue() {
    try {
      const raw = window.localStorage?.getItem(OPERATOR_QUEUE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => {
        const packageKey = normalizePackageKey(item?.packageKey || item?.packageId || item?.packageLabel);
        return {
          ...item,
          packageKey: packageKey || item?.packageKey || '',
          packageLabel: getPackageLabel(packageKey || item?.packageKey || item?.packageLabel || ''),
          amount: Number(item?.amount || 0),
        };
      });
    } catch { return []; }
  }

  function writeQueue(items) {
    window.localStorage?.setItem(OPERATOR_QUEUE_STORAGE_KEY, JSON.stringify(items || []));
  }

  function formatRp(amount) { return `Rp ${Number(amount || 0).toLocaleString('id-ID')}`; }

  function renderStats(queue) {
    $('#stat-total').textContent = String(queue.length);
    $('#stat-active').textContent = String(queue.filter((q) => q.status !== 'done').length);
    $('#stat-done').textContent = String(queue.filter((q) => q.status === 'done').length);
  }

  function renderQueue() {
    const list = $('#queue-list');
    const queue = readQueue();
    renderStats(queue);
    if (!queue.length) {
      list.innerHTML = '<p class="empty">Belum ada antrian paket.</p>';
      return;
    }
    list.innerHTML = queue.slice(0, 200).map((item, idx) => `
      <div class="queue-item">
        <div class="queue-row"><strong>${item.packageLabel || item.packageKey || '-'}</strong><strong>${formatRp(item.amount)}</strong></div>
        <div class="meta">${item.atLabel || '-'} • ${item.status === 'done' ? 'DONE' : 'IN-SESSION'} • ${item.id || '-'}</div>
        <div class="badges">
          <span class="mini-pill ${item.paidAt ? 'ok' : ''}">Paid: ${item.paidAt ? 'Yes' : 'No'}</span>
          <span class="mini-pill ${item.printedAt ? 'ok' : ''}">Printed: ${item.printedAt ? 'Yes' : 'No'}</span>
        </div>
        <div class="actions queue-actions">
          <button class="btn" data-action="toggle-paid" data-index="${idx}" type="button">${item.paidAt ? 'Unmark Paid' : 'Mark Paid'}</button>
          <button class="btn" data-action="toggle-printed" data-index="${idx}" type="button">${item.printedAt ? 'Unmark Printed' : 'Mark Printed'}</button>
        </div>
      </div>
    `).join('');
  }

  function setQueueFlag(index, field) {
    const queue = readQueue();
    const item = queue[index];
    if (!item) return;
    item[field] = item[field] ? '' : new Date().toISOString();
    writeQueue(queue);
    renderQueue();
  }

  function renderPinStatus() { $('#pin-status').textContent = readPin() ? 'Aktif' : 'Tidak aktif'; }

  function showGate(show) {
    const gate = $('#pin-gate');
    gate.classList.toggle('hidden', !show);
    gate.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  function setupPinGate() {
    const pin = readPin();
    const input = $('#pin-gate-input');
    const error = $('#pin-gate-error');
    const btnUnlock = $('#btn-pin-unlock');

    gateUnlocked = false;

    if (!pin) {
      showGate(false);
      return;
    }

    showGate(true);

    const unlock = () => {
      if (String(input.value || '').trim() !== pin) {
        error.textContent = 'PIN salah';
        return;
      }
      gateUnlocked = true;
      showGate(false);
      error.textContent = '';
      input.value = '';
    };

    btnUnlock.onclick = unlock;
    input.onkeydown = (e) => { if (e.key === 'Enter') unlock(); };
  }

  function getCurrentRules() {
    const raw = typeof window.KothakConfig?.getPackageRules === 'function'
      ? window.KothakConfig.getPackageRules()
      : window.KothakConfig?.DEFAULT_PACKAGE_RULES || {};
    if (typeof window.KothakConfig?.migratePackageRules === 'function') {
      return window.KothakConfig.migratePackageRules(raw);
    }
    return raw;
  }

  function readPackagePrices() {
    try {
      const raw = window.localStorage?.getItem(PRICE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const normalized = normalizePackagePrices(parsed);
      window.localStorage?.setItem(PRICE_STORAGE_KEY, JSON.stringify(normalized));
      return normalized;
    } catch {}
    return { ...DEFAULT_PACKAGE_PRICES };
  }

  function writePackagePrices(prices) {
    window.localStorage?.setItem(PRICE_STORAGE_KEY, JSON.stringify(normalizePackagePrices(prices)));
  }

  function renderChecks(container, values, selected, includeAll = false) {
    const selectedSet = selected === 'all' ? new Set(values) : new Set(Array.isArray(selected) ? selected : []);
    const allBlock = includeAll ? `<label class="check-item"><input type="checkbox" value="__all__" ${selected === 'all' ? 'checked' : ''}/> Semua</label>` : '';
    container.innerHTML = allBlock + values.map((v) => `<label class="check-item"><input type="checkbox" value="${v}" ${selectedSet.has(v) ? 'checked' : ''}/> ${v}</label>`).join('');
  }

  function loadPackageToForm(pkgKey) {
    const rules = getCurrentRules();
    const prices = readPackagePrices();
    const rule = rules[pkgKey] || {};
    $('#pkg-capture').value = String(rule.captureTimeSeconds || 90);
    $('#pkg-print-copies').value = String(rule.printCopies || 1);
    $('#pkg-price').value = String(prices[pkgKey] || 0);
    renderChecks($('#pkg-frames'), FRAME_OPTIONS, rule.allowedFrames || [], true);
    renderChecks($('#pkg-filters'), FILTER_OPTIONS, rule.allowedFilters || [], false);
  }

  function initPackageEditor() {
    const select = $('#package-select');
    const rules = getCurrentRules();
    const pkgKeys = ['single', 'couple', 'group'].filter((key) => rules[key]);
    select.innerHTML = pkgKeys.map((k) => `<option value="${k}">${getPackageLabel(k)}</option>`).join('');
    if (!select.value && pkgKeys[0]) select.value = pkgKeys[0];
    loadPackageToForm(select.value);

    select.addEventListener('change', () => loadPackageToForm(select.value));

    $('#btn-package-save').addEventListener('click', () => {
      const pkgKey = select.value;
      const allRules = getCurrentRules();
      const prices = readPackagePrices();

      const capture = Number($('#pkg-capture').value);
      const copies = Number($('#pkg-print-copies').value);
      const price = Number($('#pkg-price').value);
      if (!(capture >= 10 && copies >= 1 && price >= 0)) {
        alert('Isi durasi/copy/harga dengan benar');
        return;
      }

      const frameChecked = Array.from(document.querySelectorAll('#pkg-frames input:checked')).map((i) => i.value);
      const filterChecked = Array.from(document.querySelectorAll('#pkg-filters input:checked')).map((i) => i.value);
      if (!filterChecked.length) {
        alert('Minimal pilih 1 filter');
        return;
      }

      const allowedFrames = frameChecked.includes('__all__') ? 'all' : frameChecked.filter((v) => v !== '__all__');
      if (allowedFrames !== 'all' && !allowedFrames.length) {
        alert('Minimal pilih 1 frame atau pilih Semua');
        return;
      }

      allRules[pkgKey] = {
        ...(allRules[pkgKey] || {}),
        captureTimeSeconds: capture,
        printCopies: copies,
        allowedFrames,
        allowedFilters: filterChecked,
      };

      prices[pkgKey] = price;

      if (typeof window.KothakConfig?.setPackageRulesOverride === 'function') {
        window.KothakConfig.setPackageRulesOverride(allRules);
      } else {
        window.localStorage?.setItem(PACKAGE_RULES_STORAGE_KEY, JSON.stringify(allRules));
      }
      writePackagePrices(prices);
      alert('Pengaturan paket tersimpan');
    });

    $('#btn-package-reset').addEventListener('click', () => {
      if (typeof window.KothakConfig?.clearPackageRulesOverride === 'function') {
        window.KothakConfig.clearPackageRulesOverride();
      } else {
        window.localStorage?.removeItem(PACKAGE_RULES_STORAGE_KEY);
      }
      window.localStorage?.removeItem(PRICE_STORAGE_KEY);
      initPackageEditor();
      alert('Semua paket direset ke default');
    });
  }

  function readPrintSize() {
    try {
      const raw = window.localStorage?.getItem(PRINT_SIZE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      const w = Number(parsed?.widthMm);
      const h = Number(parsed?.heightMm);
      if (w >= 20 && h >= 20) return { widthMm: w, heightMm: h };
    } catch {}
    return PRINT_SIZE_PRESETS['2x6'];
  }

  function renderPrintInputs() {
    const size = readPrintSize();
    $('#print-width').value = String(size.widthMm);
    $('#print-height').value = String(size.heightMm);
  }

  function savePrintSize(widthMm, heightMm) {
    window.localStorage?.setItem(PRINT_SIZE_STORAGE_KEY, JSON.stringify({ widthMm, heightMm }));
    renderPrintInputs();
  }

  function setupPrintActions() {
    document.querySelectorAll('[data-print-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = PRINT_SIZE_PRESETS[btn.dataset.printPreset];
        if (!preset) return;
        savePrintSize(preset.widthMm, preset.heightMm);
        alert(`Ukuran print diset ke ${btn.dataset.printPreset}`);
      });
    });

    $('#btn-print-save').addEventListener('click', () => {
      const w = Number($('#print-width').value);
      const h = Number($('#print-height').value);
      if (!(w >= 20 && h >= 20)) return alert('Ukuran minimal 20mm x 20mm');
      savePrintSize(w, h);
      alert('Ukuran print tersimpan');
    });

    $('#btn-print-reset').addEventListener('click', () => {
      const d = PRINT_SIZE_PRESETS['2x6'];
      savePrintSize(d.widthMm, d.heightMm);
      alert('Ukuran print reset ke 2x6');
    });
  }

  function init() {
    renderPinStatus();
    renderQueue();
    renderPrintInputs();
    setupPinGate();
    initPackageEditor();
    setupPrintActions();

    $('#btn-refresh').addEventListener('click', renderQueue);
    $('#btn-clear-queue').addEventListener('click', () => { writeQueue([]); renderQueue(); });

    $('#queue-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const index = Number(btn.dataset.index);
      if (!Number.isInteger(index) || index < 0) return;
      if (btn.dataset.action === 'toggle-paid') setQueueFlag(index, 'paidAt');
      if (btn.dataset.action === 'toggle-printed') setQueueFlag(index, 'printedAt');
    });

    $('#btn-pin-save').addEventListener('click', () => {
      const pinNew = String($('#pin-new').value || '').trim();
      const pinConfirm = String($('#pin-confirm').value || '').trim();
      if (!/^\d{4,}$/.test(pinNew)) return alert('PIN minimal 4 digit angka');
      if (pinNew !== pinConfirm) return alert('Konfirmasi PIN tidak sama');
      window.localStorage?.setItem(OPERATOR_PIN_STORAGE_KEY, pinNew);
      $('#pin-new').value = '';
      $('#pin-confirm').value = '';
      renderPinStatus();
      setupPinGate();
      alert('PIN operator disimpan');
    });

    $('#btn-pin-clear').addEventListener('click', () => {
      window.localStorage?.removeItem(OPERATOR_PIN_STORAGE_KEY);
      renderPinStatus();
      setupPinGate();
      alert('PIN operator dihapus');
    });
  }

  init();
})();
