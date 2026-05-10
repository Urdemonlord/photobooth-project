(function () {
  'use strict';

  const OPERATOR_PIN_STORAGE_KEY = 'kothak-operator-pin';
  const OPERATOR_QUEUE_STORAGE_KEY = 'kothak-operator-queue';
  const OPERATOR_DASH_AUTH_TS_KEY = 'kothak-operator-dashboard-auth-ts';
  const PACKAGE_RULES_STORAGE_KEY = 'kothak-package-rules';
  const PRINT_SIZE_STORAGE_KEY = 'kothak-print-size';
  const DASH_AUTH_TTL_MS = 12 * 60 * 60 * 1000;

  const PRINT_SIZE_PRESETS = {
    '2x6': { widthMm: 50.8, heightMm: 152.4 },
    '4x6': { widthMm: 101.6, heightMm: 152.4 },
    '2x3': { widthMm: 50.8, heightMm: 76.2 },
  };

  const $ = (s, c = document) => c.querySelector(s);

  function readPin() {
    const fromStorage = window.localStorage?.getItem(OPERATOR_PIN_STORAGE_KEY);
    if (fromStorage && String(fromStorage).trim()) return String(fromStorage).trim();
    const fromConfig = typeof window.KothakConfig?.getOperatorPin === 'function'
      ? window.KothakConfig.getOperatorPin()
      : '';
    return String(fromConfig || '').trim();
  }

  function readQueue() {
    try {
      const raw = window.localStorage?.getItem(OPERATOR_QUEUE_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeQueue(items) {
    window.localStorage?.setItem(OPERATOR_QUEUE_STORAGE_KEY, JSON.stringify(items || []));
  }

  function formatRp(amount) {
    return `Rp ${Number(amount || 0).toLocaleString('id-ID')}`;
  }

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

    list.innerHTML = queue.slice(0, 200).map((item, idx) => {
      const label = item.packageLabel || item.packageKey || '-';
      const statusText = item.status === 'done' ? 'DONE' : 'IN-SESSION';
      const paidClass = item.paidAt ? 'ok' : '';
      const printedClass = item.printedAt ? 'ok' : '';
      return `
        <div class="queue-item">
          <div class="queue-row"><strong>${label}</strong><strong>${formatRp(item.amount)}</strong></div>
          <div class="meta">${item.atLabel || '-'} • ${statusText} • ${item.id || '-'}</div>
          <div class="badges">
            <span class="mini-pill ${paidClass}">Paid: ${item.paidAt ? 'Yes' : 'No'}</span>
            <span class="mini-pill ${printedClass}">Printed: ${item.printedAt ? 'Yes' : 'No'}</span>
          </div>
          <div class="actions queue-actions">
            <button class="btn" data-action="toggle-paid" data-index="${idx}" type="button">${item.paidAt ? 'Unmark Paid' : 'Mark Paid'}</button>
            <button class="btn" data-action="toggle-printed" data-index="${idx}" type="button">${item.printedAt ? 'Unmark Printed' : 'Mark Printed'}</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function setQueueFlag(index, field) {
    const queue = readQueue();
    const item = queue[index];
    if (!item) return;
    item[field] = item[field] ? '' : new Date().toISOString();
    writeQueue(queue);
    renderQueue();
  }

  function renderPinStatus() {
    const pin = readPin();
    $('#pin-status').textContent = pin ? 'Aktif' : 'Tidak aktif';
  }

  function isGateAuthed() {
    const ts = Number(window.sessionStorage?.getItem(OPERATOR_DASH_AUTH_TS_KEY) || 0);
    return ts > 0 && (Date.now() - ts) < DASH_AUTH_TTL_MS;
  }

  function setGateAuthed() {
    window.sessionStorage?.setItem(OPERATOR_DASH_AUTH_TS_KEY, String(Date.now()));
  }

  function showGate(show) {
    const gate = $('#pin-gate');
    if (!gate) return;
    gate.classList.toggle('hidden', !show);
    gate.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  function setupPinGate() {
    const pin = readPin();
    const input = $('#pin-gate-input');
    const error = $('#pin-gate-error');
    const btnUnlock = $('#btn-pin-unlock');

    if (!pin) {
      showGate(false);
      return;
    }

    if (isGateAuthed()) {
      showGate(false);
      return;
    }

    showGate(true);

    const unlock = () => {
      const val = String(input.value || '').trim();
      if (val !== pin) {
        error.textContent = 'PIN salah';
        return;
      }
      setGateAuthed();
      showGate(false);
      error.textContent = '';
      input.value = '';
    };

    btnUnlock.onclick = unlock;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') unlock();
    };
  }

  function renderPackageRulesEditor() {
    const el = $('#package-rules-json');
    const currentRules = typeof window.KothakConfig?.getPackageRules === 'function'
      ? window.KothakConfig.getPackageRules()
      : (window.KothakConfig?.DEFAULT_PACKAGE_RULES || {});
    el.value = JSON.stringify(currentRules, null, 2);
  }

  function setupPackageRulesActions() {
    $('#btn-package-save').addEventListener('click', () => {
      const txt = String($('#package-rules-json').value || '').trim();
      try {
        const parsed = JSON.parse(txt);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          alert('Format JSON harus object');
          return;
        }
        if (typeof window.KothakConfig?.setPackageRulesOverride === 'function') {
          window.KothakConfig.setPackageRulesOverride(parsed);
        } else {
          window.localStorage?.setItem(PACKAGE_RULES_STORAGE_KEY, JSON.stringify(parsed));
        }
        renderPackageRulesEditor();
        alert('Pengaturan paket tersimpan. Reload kiosk untuk apply.');
      } catch {
        alert('JSON tidak valid');
      }
    });

    $('#btn-package-reset').addEventListener('click', () => {
      if (typeof window.KothakConfig?.clearPackageRulesOverride === 'function') {
        window.KothakConfig.clearPackageRulesOverride();
      } else {
        window.localStorage?.removeItem(PACKAGE_RULES_STORAGE_KEY);
      }
      renderPackageRulesEditor();
      alert('Pengaturan paket kembali ke default');
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
      if (!(w >= 20 && h >= 20)) {
        alert('Ukuran minimal 20mm x 20mm');
        return;
      }
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
    renderPackageRulesEditor();
    renderPrintInputs();
    setupPinGate();
    setupPackageRulesActions();
    setupPrintActions();

    $('#btn-refresh').addEventListener('click', renderQueue);

    $('#btn-clear-queue').addEventListener('click', () => {
      writeQueue([]);
      renderQueue();
    });

    $('#queue-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const index = Number(btn.dataset.index);
      if (!Number.isInteger(index) || index < 0) return;

      if (btn.dataset.action === 'toggle-paid') {
        setQueueFlag(index, 'paidAt');
      }
      if (btn.dataset.action === 'toggle-printed') {
        setQueueFlag(index, 'printedAt');
      }
    });

    $('#btn-pin-save').addEventListener('click', () => {
      const pinNew = String($('#pin-new').value || '').trim();
      const pinConfirm = String($('#pin-confirm').value || '').trim();
      if (!/^\d{4,}$/.test(pinNew)) {
        alert('PIN minimal 4 digit angka');
        return;
      }
      if (pinNew !== pinConfirm) {
        alert('Konfirmasi PIN tidak sama');
        return;
      }
      window.localStorage?.setItem(OPERATOR_PIN_STORAGE_KEY, pinNew);
      setGateAuthed();
      $('#pin-new').value = '';
      $('#pin-confirm').value = '';
      renderPinStatus();
      setupPinGate();
      alert('PIN operator disimpan');
    });

    $('#btn-pin-clear').addEventListener('click', () => {
      window.localStorage?.removeItem(OPERATOR_PIN_STORAGE_KEY);
      setGateAuthed();
      renderPinStatus();
      setupPinGate();
      alert('PIN operator dihapus');
    });
  }

  init();
})();