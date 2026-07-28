import OpenModelicaViewer from './src/app/viewer-app.js';
import { initializeAnalytics } from './src/analytics/analytics.js';

function startApplication() {
    initializeAnalytics();
    window.app = new OpenModelicaViewer();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApplication, { once: true });
} else {
    startApplication();
}
