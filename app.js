import OpenModelicaViewer from './src/app/viewer-app.js';
import { initializeAnalytics } from './src/analytics/analytics.js';
import { DEMO_MODE } from './src/app/demo-mode.js';

function startApplication() {
    // The guide's frame is not a visit (src/app/demo-mode.js).
    if (DEMO_MODE) document.documentElement.classList.add('demo');
    else initializeAnalytics();
    window.app = new OpenModelicaViewer();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApplication, { once: true });
} else {
    startApplication();
}
