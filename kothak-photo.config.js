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

  const ALL_FILTERS = ['original', 'bw', 'vintage', 'warm', 'cool', 'softglow', 'film', 'natural', 'dramatic', 'pastel', 'retro'];
  const BASE_FRAME_KEYS = ['birthday', 'friends', 'newspaper', 'filmstrip', 'fish', 'moments-friends', 'live-moment', 'picture-perfect'];
  const BONUS_FRAME_KEYS = ['boothlab-2', 'boothlab-3', 'boothlab-4', 'boothlab-5', 'loveinframe'];
  const DEFAULT_PACKAGE_RULES = {
    single: {
      captureTimeSeconds: 60,
      allowedFrames: [...BASE_FRAME_KEYS],
      allowedFilters: [...ALL_FILTERS],
      printCopies: 1,
    },
    couple: {
      captureTimeSeconds: 90,
      allowedFrames: [...BASE_FRAME_KEYS, ...BONUS_FRAME_KEYS],
      allowedFilters: [...ALL_FILTERS],
      printCopies: 2,
    },
    group: {
      captureTimeSeconds: 120,
      allowedFrames: [...BASE_FRAME_KEYS, ...BONUS_FRAME_KEYS],
      allowedFilters: [...ALL_FILTERS],
      printCopies: 3,
    },
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  const PACKAGE_RULES_STORAGE_KEY = 'kothak-package-rules';

  function normalizePackageKey(pkgKey) {
    const key = String(pkgKey || '').trim().toLowerCase();
    if (key === 'bestie') return 'couple';
    if (key === 'signature') return 'group';
    if (key === 'single' || key === 'couple' || key === 'group') return key;
    return '';
  }

  function normalizeRule(rule, fallbackRule) {
    const base = clone(fallbackRule || {});
    if (!rule || typeof rule !== 'object') return base;
    return {
      ...base,
      ...rule,
      allowedFrames: rule.allowedFrames === 'all'
        ? 'all'
        : Array.isArray(rule.allowedFrames)
          ? [...new Set(rule.allowedFrames.map((item) => String(item || '').trim()).filter(Boolean))]
          : base.allowedFrames,
      allowedFilters: Array.isArray(rule.allowedFilters) && rule.allowedFilters.length > 0
        ? [...new Set(rule.allowedFilters.map((item) => String(item || '').trim()).filter(Boolean))]
        : [...(base.allowedFilters || ['original'])],
      captureTimeSeconds: Math.max(15, Number(rule.captureTimeSeconds) || Number(base.captureTimeSeconds) || 90),
      printCopies: Math.max(1, Number(rule.printCopies) || Number(base.printCopies) || 1),
    };
  }

  function migratePackageRules(source) {
    const normalized = {};
    if (!source || typeof source !== 'object') return normalized;

    for (const [rawKey, rawRule] of Object.entries(source)) {
      const key = normalizePackageKey(rawKey);
      if (!key) continue;
      if (normalized[key]) continue;
      normalized[key] = normalizeRule(rawRule, DEFAULT_PACKAGE_RULES[key]);
    }

    return normalized;
  }

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
    const parsedStorage = parseJsonObject(storageRaw);
    const fromStorage = migratePackageRules(parsedStorage);
    if (Object.keys(fromStorage).length > 0) {
      if (JSON.stringify(parsedStorage) !== JSON.stringify(fromStorage)) {
        window.localStorage?.setItem(PACKAGE_RULES_STORAGE_KEY, JSON.stringify(fromStorage));
      }
      return fromStorage;
    }

    const raw = document.querySelector('meta[name="kothak-package-rules"]')?.content
      || window.__KOTHAK_PACKAGE_RULES__
      || window.KOTHAK_PACKAGE_RULES
      || null;

    return migratePackageRules(parseJsonObject(raw));
  }

  function setPackageRulesOverride(override) {
    if (!override || typeof override !== 'object') {
      window.localStorage?.removeItem(PACKAGE_RULES_STORAGE_KEY);
      return;
    }
    window.localStorage?.setItem(PACKAGE_RULES_STORAGE_KEY, JSON.stringify(migratePackageRules(override)));
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
      if (!defaults[pkgKey]) continue;
      defaults[pkgKey] = normalizeRule(pkgRule, defaults[pkgKey]);
    }

    return defaults;
  }

  window.KothakConfig = {
    normalizeApiBaseUrl,
    buildApiBaseCandidates,
    getInternalApiKey,
    getOperatorPin,
    getPackageRules,
    normalizePackageKey,
    migratePackageRules,
    setPackageRulesOverride,
    clearPackageRulesOverride,
    ALL_FILTERS: [...ALL_FILTERS],
    DEFAULT_PACKAGE_RULES: clone(DEFAULT_PACKAGE_RULES),
  };
})();
