import OpenModelicaViewer from './src/app/viewer-app.js';
import { initializeAnalytics } from './src/analytics/analytics.js';
import { initMobileViewport } from './src/ui/mobile-viewport.js';

function startApplication() {
    initializeAnalytics();
    window.app = new OpenModelicaViewer();
    // After the app exists: the stage fixes the layout to a virtual desktop
    // size, and the panels have to re-measure against it.
    initMobileViewport({ onStageResize: () => window.app?.plotManager?.resizeAll?.() });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApplication, { once: true });
} else {
    startApplication();
}
