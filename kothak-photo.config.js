(function () {
  'use strict';

  function normalizeApiBaseUrl(value) {
    return String(value || '').trim().replace(/\/$/, '');
  }

  function buildApiBaseCandidates() {
    const candidates = [];
    const explicitBase = document.querySelector('meta[name="kothak-api-base"]')?.content
      || window.__KOTHAK_API_BASE_URL__
      || window.KOTHAK_API_BASE_URL;

    if (explicitBase) candidates.push(explicitBase);
    if (window.location.origin && window.location.origin !== 'null') candidates.push(window.location.origin);

    candidates.push('http://localhost:3000');
    candidates.push('http://127.0.0.1:3000');

    return [...new Set(candidates.map(normalizeApiBaseUrl).filter(Boolean))];
  }

  function getInternalApiKey() {
    return String(
      document.querySelector('meta[name="kothak-internal-api-key"]')?.content
      || window.__KOTHAK_INTERNAL_API_KEY__
      || window.KOTHAK_INTERNAL_API_KEY
      || ''
    ).trim();
  }

  const DEFAULT_PACKAGE_RULES = {
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

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  const PACKAGE_RULES_STORAGE_KEY = 'kothak-package-rules';

  function parseJsonObject(raw) {
    if (!raw) return null;
    try {
      if (typeof raw === 'string') return JSON.parse(raw);
      if (typeof raw === 'object') return raw;
      return null;
    } catch {
      return null;
    }
  }

  function readPackageRulesOverride() {
    const storageRaw = window.localStorage?.getItem(PACKAGE_RULES_STORAGE_KEY);
    const fromStorage = parseJsonObject(storageRaw);
    if (fromStorage && typeof fromStorage === 'object') return fromStorage;

    const raw = document.querySelector('meta[name="kothak-package-rules"]')?.content
      || window.__KOTHAK_PACKAGE_RULES__
      || window.KOTHAK_PACKAGE_RULES
      || null;

    return parseJsonObject(raw);
  }

  function setPackageRulesOverride(override) {
    if (!override || typeof override !== 'object') {
      window.localStorage?.removeItem(PACKAGE_RULES_STORAGE_KEY);
      return;
    }
    window.localStorage?.setItem(PACKAGE_RULES_STORAGE_KEY, JSON.stringify(override));
  }

  function clearPackageRulesOverride() {
    window.localStorage?.removeItem(PACKAGE_RULES_STORAGE_KEY);
  }

  function getOperatorPin() {
    return String(
      document.querySelector('meta[name="kothak-operator-pin"]')?.content
      || window.__KOTHAK_OPERATOR_PIN__
      || window.KOTHAK_OPERATOR_PIN
      || ''
    ).trim();
  }

  function getPackageRules() {
    const defaults = clone(DEFAULT_PACKAGE_RULES);
    const override = readPackageRulesOverride();
    if (!override || typeof override !== 'object') {
      return defaults;
    }

    for (const [pkgKey, pkgRule] of Object.entries(override)) {
      if (!pkgRule || typeof pkgRule !== 'object') continue;
      defaults[pkgKey] = {
        ...(defaults[pkgKey] || {}),
        ...pkgRule,
      };
    }

    return defaults;
  }

  window.KothakConfig = {
    normalizeApiBaseUrl,
    buildApiBaseCandidates,
    getInternalApiKey,
    getOperatorPin,
    getPackageRules,
    setPackageRulesOverride,
    clearPackageRulesOverride,
    DEFAULT_PACKAGE_RULES: clone(DEFAULT_PACKAGE_RULES),
  };
})();
