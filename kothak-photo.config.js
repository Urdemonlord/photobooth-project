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

  function readPackageRulesOverride() {
    const raw = document.querySelector('meta[name="kothak-package-rules"]')?.content
      || window.__KOTHAK_PACKAGE_RULES__
      || window.KOTHAK_PACKAGE_RULES
      || null;

    if (!raw) return null;
    try {
      if (typeof raw === 'string') return JSON.parse(raw);
      if (typeof raw === 'object') return raw;
      return null;
    } catch {
      return null;
    }
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
    getPackageRules,
  };
})();
