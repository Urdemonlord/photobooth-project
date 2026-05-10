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

  window.KothakConfig = {
    normalizeApiBaseUrl,
    buildApiBaseCandidates,
    getInternalApiKey,
  };
})();
