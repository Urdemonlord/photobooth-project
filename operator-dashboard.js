(function () {
  'use strict';

  const OPERATOR_PIN_STORAGE_KEY = 'kothak-operator-pin';
  const OPERATOR_QUEUE_STORAGE_KEY = 'kothak-operator-queue';
  const OPERATOR_AUTH_SESSION_KEY = 'kothak-operator-auth-ok';

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

    list.innerHTML = queue.slice(0, 100).map((item) => {
      const label = item.packageLabel || item.packageKey || '-';
      const status = item.status === 'done' ? 'DONE' : 'IN-SESSION';
      return `
        <div class="queue-item">
          <div class="queue-row"><strong>${label}</strong><strong>${formatRp(item.amount)}</strong></div>
          <div class="meta">${item.atLabel || '-'} • ${status} • ${item.id || '-'}</div>
        </div>
      `;
    }).join('');
  }

  function renderPinStatus() {
    const pin = readPin();
    $('#pin-status').textContent = pin ? 'Aktif' : 'Tidak aktif';
  }

  function setupPinGate() {
    const pin = readPin();
    const gate = $('#pin-gate');
    const input = $('#pin-gate-input');
    const error = $('#pin-gate-error');
    const btnUnlock = $('#btn-pin-unlock');

    if (!pin) {
      gate.classList.add('hidden');
      gate.setAttribute('aria-hidden', 'true');
      return;
    }

    const alreadyAuthed = window.sessionStorage?.getItem(OPERATOR_AUTH_SESSION_KEY) === '1';
    if (alreadyAuthed) {
      gate.classList.add('hidden');
      gate.setAttribute('aria-hidden', 'true');
      return;
    }

    gate.classList.remove('hidden');
    gate.setAttribute('aria-hidden', 'false');

    const unlock = () => {
      const val = String(input.value || '').trim();
      if (val !== pin) {
        error.textContent = 'PIN salah';
        return;
      }
      window.sessionStorage?.setItem(OPERATOR_AUTH_SESSION_KEY, '1');
      gate.classList.add('hidden');
      gate.setAttribute('aria-hidden', 'true');
      error.textContent = '';
      input.value = '';
    };

    btnUnlock.onclick = unlock;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') unlock();
    });
  }

  function init() {
    renderPinStatus();
    renderQueue();
    setupPinGate();

    $('#btn-refresh').addEventListener('click', renderQueue);

    $('#btn-clear-queue').addEventListener('click', () => {
      writeQueue([]);
      renderQueue();
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
      window.sessionStorage?.setItem(OPERATOR_AUTH_SESSION_KEY, '1');
      $('#pin-new').value = '';
      $('#pin-confirm').value = '';
      renderPinStatus();
      setupPinGate();
      alert('PIN operator disimpan');
    });

    $('#btn-pin-clear').addEventListener('click', () => {
      window.localStorage?.removeItem(OPERATOR_PIN_STORAGE_KEY);
      window.sessionStorage?.setItem(OPERATOR_AUTH_SESSION_KEY, '1');
      renderPinStatus();
      setupPinGate();
      alert('PIN operator dihapus');
    });
  }

  init();
})();
