import OpenModelicaViewer from './src/app/viewer-app.js';
import { initializeAnalyticsConsent } from './src/analytics/analytics-consent.js';

function startApplication() {
    initializeAnalyticsConsent();
    window.app = new OpenModelicaViewer();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApplication, { once: true });
} else {
    startApplication();
}
