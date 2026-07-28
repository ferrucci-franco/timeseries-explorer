// Optional page-view measurement through GoatCounter. It replaces the Google
// Analytics setup that needed a consent banner: GoatCounter writes nothing to
// the browser -- no cookies, no localStorage, no cache -- so there is no stored
// choice to ask for and nothing to clean up on the visitor's device.
const SCRIPT_ID = 'omv-analytics-script';
const SCRIPT_SRC = 'https://gc.zgo.at/count.js';

// Written by the consent banner this module replaced. Returning visitors still
// carry the key, and it no longer means anything, so drop it on first load.
const LEGACY_CONSENT_KEY = 'omv_analytics_consent';

function isDesktop() {
    return Boolean(globalThis.omvDesktop) || window.location.protocol === 'file:';
}

function clearLegacyConsent() {
    try {
        window.localStorage?.removeItem(LEGACY_CONSENT_KEY);
    } catch {
        // Storage can be unavailable; then there is nothing left behind either.
    }
}

export function initializeAnalytics() {
    clearLegacyConsent();

    const endpoint = String(globalThis.__OMV_ANALYTICS_CONFIG__?.endpoint || '').trim();
    if (!endpoint || isDesktop() || document.getElementById(SCRIPT_ID)) return;

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.async = true;
    // count.js finds its endpoint by querying for this attribute, so it has to
    // be set before the element is appended and the script can start running.
    script.dataset.goatcounter = endpoint;
    script.src = SCRIPT_SRC;
    document.head.appendChild(script);
}
