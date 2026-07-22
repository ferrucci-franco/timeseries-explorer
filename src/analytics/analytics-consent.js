const CONSENT_STORAGE_KEY = 'omv_analytics_consent';
const GA_SCRIPT_ID = 'omv-analytics-script';

const COPY = {
    en: {
        title: 'Privacy and cookies',
        body: 'We use optional analytics cookies to understand how the website is used. They are not needed for the site to work.',
        detail: 'Analytics helps us measure visits, pages viewed, approximate visit duration, browser and device information, and traffic sources. No names, email addresses, files, or file contents are sent.',
        required: 'Necessary', requiredBody: 'Stores your privacy choice and keeps the site working.',
        analytics: 'Analytics', analyticsBody: 'Optional measurement of website visits and usage.',
        accept: 'Accept analytics', reject: 'Reject', configure: 'Configure', save: 'Save preferences',
        on: 'On', off: 'Off', provider: 'The analytics provider is identified in the privacy policy.'
    },
    fr: {
        title: 'Confidentialité et cookies',
        body: 'Nous utilisons des cookies d’analyse facultatifs pour comprendre l’utilisation du site. Ils ne sont pas nécessaires à son fonctionnement.',
        detail: 'L’analyse nous aide à mesurer les visites, les pages consultées, la durée approximative des visites, le navigateur, l’appareil et les sources de trafic. Aucun nom, e-mail, fichier ou contenu de fichier n’est envoyé.',
        required: 'Nécessaires', requiredBody: 'Enregistrent votre choix de confidentialité et assurent le fonctionnement du site.',
        analytics: 'Analyse', analyticsBody: 'Mesure facultative des visites et de l’utilisation du site.',
        accept: 'Accepter l’analyse', reject: 'Refuser', configure: 'Configurer', save: 'Enregistrer les choix',
        on: 'Activée', off: 'Désactivée', provider: 'Le fournisseur d’analyse est indiqué dans la politique de confidentialité.'
    },
    es: {
        title: 'Privacidad y cookies',
        body: 'Usamos cookies opcionales de analítica para entender cómo se utiliza el sitio. No son necesarias para que funcione.',
        detail: 'La analítica nos ayuda a medir visitas, páginas consultadas, duración aproximada, navegador, dispositivo y fuentes de tráfico. No enviamos nombres, correos, archivos ni contenido de archivos.',
        required: 'Necesarias', requiredBody: 'Guardan tu preferencia de privacidad y permiten que el sitio funcione.',
        analytics: 'Analítica', analyticsBody: 'Medición opcional de las visitas y del uso del sitio.',
        accept: 'Aceptar analítica', reject: 'Rechazar', configure: 'Configurar', save: 'Guardar preferencias',
        on: 'Activada', off: 'Desactivada', provider: 'El proveedor de analítica se identifica en la política de privacidad.'
    },
    it: {
        title: 'Privacy e cookie',
        body: 'Usiamo cookie analitici opzionali per capire come viene usato il sito. Non sono necessari per il suo funzionamento.',
        detail: 'L’analisi ci aiuta a misurare visite, pagine consultate, durata approssimativa, browser, dispositivo e fonti di traffico. Non inviamo nomi, e-mail, file o contenuti dei file.',
        required: 'Necessari', requiredBody: 'Memorizzano la scelta sulla privacy e mantengono il sito funzionante.',
        analytics: 'Analisi', analyticsBody: 'Misurazione opzionale delle visite e dell’uso del sito.',
        accept: 'Accetta analisi', reject: 'Rifiuta', configure: 'Configura', save: 'Salva preferenze',
        on: 'Attivata', off: 'Disattivata', provider: 'Il fornitore dell’analisi è indicato nella privacy policy.'
    }
};

function getLanguage() {
    const lang = document.documentElement.lang?.toLowerCase() || 'en';
    return COPY[lang] ? lang : 'en';
}

function getStoredConsent() {
    try {
        const value = window.localStorage?.getItem(CONSENT_STORAGE_KEY);
        return value === 'granted' || value === 'denied' ? value : null;
    } catch {
        return null;
    }
}

function saveConsent(value) {
    try {
        window.localStorage?.setItem(CONSENT_STORAGE_KEY, value);
    } catch {
        // If storage is unavailable, the choice applies to this page load only.
    }
}

function isDesktop() {
    return Boolean(globalThis.omvDesktop) || window.location.protocol === 'file:';
}

function loadAnalytics() {
    const measurementId = String(globalThis.__OMV_ANALYTICS_CONFIG__?.measurementId || '').trim();
    if (!measurementId || isDesktop() || document.getElementById(GA_SCRIPT_ID)) return;

    const script = document.createElement('script');
    script.id = GA_SCRIPT_ID;
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.appendChild(script);

    globalThis.dataLayer = globalThis.dataLayer || [];
    globalThis.gtag = globalThis.gtag || function gtag() {
        globalThis.dataLayer.push(arguments);
    };
    globalThis.gtag('js', new Date());
    globalThis.gtag('config', measurementId, {
        anonymize_ip: true,
        allow_google_signals: false,
        allow_ad_personalization_signals: false
    });
}

function buildBanner() {
    const copy = COPY[getLanguage()];
    const wrapper = document.createElement('section');
    wrapper.className = 'analytics-consent';
    wrapper.setAttribute('aria-labelledby', 'analytics-consent-title');
    wrapper.innerHTML = `
        <div class="analytics-consent-card">
            <div class="analytics-consent-main">
                <h2 id="analytics-consent-title">${copy.title}</h2>
                <p>${copy.body}</p>
                <div class="analytics-consent-detail" hidden>${copy.detail}</div>
            </div>
            <div class="analytics-consent-actions">
                <button type="button" class="analytics-consent-btn analytics-consent-btn-secondary" data-action="reject">${copy.reject}</button>
                <button type="button" class="analytics-consent-btn analytics-consent-btn-secondary" data-action="configure">${copy.configure}</button>
                <button type="button" class="analytics-consent-btn analytics-consent-btn-primary" data-action="accept">${copy.accept}</button>
            </div>
            <div class="analytics-consent-settings" hidden>
                <div class="analytics-consent-setting">
                    <div><strong>${copy.required}</strong><p>${copy.requiredBody}</p></div>
                    <span class="analytics-consent-status">${copy.on}</span>
                </div>
                <label class="analytics-consent-setting analytics-consent-setting-toggle">
                    <span><strong>${copy.analytics}</strong><p>${copy.analyticsBody}</p></span>
                    <span class="analytics-consent-toggle-wrap">
                        <input type="checkbox" data-analytics-toggle>
                        <span class="analytics-consent-status" data-analytics-status>${copy.off}</span>
                    </span>
                </label>
                <p class="analytics-consent-provider-note">${copy.provider}</p>
                <button type="button" class="analytics-consent-btn analytics-consent-btn-primary" data-action="save">${copy.save}</button>
            </div>
        </div>`;
    document.body.appendChild(wrapper);
    return wrapper;
}

function setVisibility(wrapper, visible) {
    wrapper.hidden = !visible;
    wrapper.classList.toggle('is-visible', visible);
}

function applyConsent(wrapper, value) {
    saveConsent(value);
    setVisibility(wrapper, false);
    if (value === 'granted') loadAnalytics();
}

export function initializeAnalyticsConsent() {
    if (isDesktop()) return;

    const wrapper = buildBanner();
    const storedConsent = getStoredConsent();
    if (storedConsent) {
        setVisibility(wrapper, false);
        if (storedConsent === 'granted') loadAnalytics();
        return;
    }

    setVisibility(wrapper, true);
    const settings = wrapper.querySelector('.analytics-consent-settings');
    const detail = wrapper.querySelector('.analytics-consent-detail');
    const toggle = wrapper.querySelector('[data-analytics-toggle]');
    const status = wrapper.querySelector('[data-analytics-status]');
    const copy = COPY[getLanguage()];

    toggle.addEventListener('change', () => {
        status.textContent = toggle.checked ? copy.on : copy.off;
    });

    wrapper.addEventListener('click', event => {
        const button = event.target.closest('[data-action]');
        const action = button?.dataset.action;
        if (!action) return;
        if (action === 'accept') applyConsent(wrapper, 'granted');
        if (action === 'reject') applyConsent(wrapper, 'denied');
        if (action === 'configure') {
            settings.hidden = false;
            detail.hidden = false;
            button.hidden = true;
        }
        if (action === 'save') applyConsent(wrapper, toggle.checked ? 'granted' : 'denied');
    });
}
