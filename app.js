import OpenModelicaViewer from './src/app/viewer-app.js';

function startApplication() {
    window.app = new OpenModelicaViewer();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApplication, { once: true });
} else {
    startApplication();
}
