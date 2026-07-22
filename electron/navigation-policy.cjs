'use strict';

const EXTERNAL_WEB_PROTOCOLS = new Set(['http:', 'https:']);
const EXTERNAL_OPEN_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const LOCAL_RENDERER_PROTOCOLS = new Set(['data:', 'about:']);

function parseUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch (_) {
    return null;
  }
}

function appOriginFromUrl(appUrl) {
  const parsed = parseUrl(appUrl);
  return parsed && EXTERNAL_WEB_PROTOCOLS.has(parsed.protocol) ? parsed.origin : '';
}

function isExternalWebUrl(targetUrl, appOrigin) {
    const parsed = parseUrl(targetUrl);
    if (!parsed || !EXTERNAL_WEB_PROTOCOLS.has(parsed.protocol)) return false;
    return parsed.origin !== appOrigin;
}

function isExternalOpenUrl(targetUrl, appOrigin) {
  const parsed = parseUrl(targetUrl);
  if (!parsed || !EXTERNAL_OPEN_PROTOCOLS.has(parsed.protocol)) return false;
  if (EXTERNAL_WEB_PROTOCOLS.has(parsed.protocol)) return parsed.origin !== appOrigin;
  return true;
}

function isAllowedRendererUrl(targetUrl, appOrigin) {
  const parsed = parseUrl(targetUrl);
  if (!parsed) return false;

  if (EXTERNAL_WEB_PROTOCOLS.has(parsed.protocol)) {
    return !!appOrigin && parsed.origin === appOrigin;
  }

  if (parsed.protocol === 'blob:') {
    return !!appOrigin && parsed.origin === appOrigin;
  }

  return LOCAL_RENDERER_PROTOCOLS.has(parsed.protocol);
}

module.exports = {
  appOriginFromUrl,
  isAllowedRendererUrl,
  isExternalOpenUrl,
  isExternalWebUrl,
};
