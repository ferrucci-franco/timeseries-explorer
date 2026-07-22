const CONSENT_STORAGE_KEY = 'omv_analytics_consent';
const GA_SCRIPT_ID = 'omv-analytics-script';

const COPY = {
    en: {
        title: 'Privacy choices',
        body: 'The app works normally without sharing usage information. If you allow it, the app sends limited information so we can estimate how many people use the web app.',
        detail: 'This information may include visits, pages opened, approximate visit duration, browser/device type and traffic source. It does not include your name, email address, uploaded files or file contents. You can say no without losing any functionality.',
        required: 'Necessary', requiredBody: 'Stores your privacy choice and keeps the site working.',
        analytics: 'Usage information', analyticsBody: 'Optional measurement of general web app usage.',
        accept: 'Allow usage information', reject: 'Reject', configure: 'Configure', save: 'Save preferences',
        on: 'On', off: 'Off', provider: 'Details about this optional service are available in the privacy policy.'
    },
    fr: {
        title: 'Choix de confidentialité',
        body: 'L’application fonctionne normalement sans partager d’informations sur son utilisation. Si vous l’acceptez, elle envoie des informations limitées sur son utilisation afin de nous aider à estimer combien de personnes utilisent l’application web.',
        detail: 'Ces informations peuvent inclure les visites, les pages ouvertes, la durée approximative des visites, le type de navigateur et d’appareil, ainsi que la source du trafic. Elles ne contiennent ni votre nom, ni votre adresse e-mail, ni les fichiers téléchargés, ni leur contenu. Vous pouvez refuser sans perdre de fonctionnalité.',
        required: 'Nécessaires', requiredBody: 'Enregistrent votre choix de confidentialité et assurent le fonctionnement du site.',
        analytics: 'Informations d’utilisation', analyticsBody: 'Mesure facultative de l’utilisation générale de l’application web.',
        accept: 'Autoriser les informations d’utilisation', reject: 'Refuser', configure: 'Configurer', save: 'Enregistrer les choix',
        on: 'Activée', off: 'Désactivée', provider: 'Les détails de ce service facultatif sont disponibles dans la politique de confidentialité.'
    },
    es: {
        title: 'Opciones de privacidad',
        body: 'La aplicación funciona normalmente sin compartir información sobre su uso. Si lo aceptas, envía información limitada sobre su uso para ayudarnos a estimar cuántas personas utilizan la aplicación web.',
        detail: 'Esta información puede incluir visitas, páginas abiertas, duración aproximada de las visitas, tipo de navegador y dispositivo, y origen del tráfico. No incluye tu nombre, correo electrónico, archivos subidos ni el contenido de los archivos. Puedes rechazarla sin perder ninguna función.',
        required: 'Necesarias', requiredBody: 'Guardan tu preferencia de privacidad y permiten que el sitio funcione.',
        analytics: 'Información de uso', analyticsBody: 'Medición opcional del uso general de la aplicación web.',
        accept: 'Permitir información de uso', reject: 'Rechazar', configure: 'Configurar', save: 'Guardar preferencias',
        on: 'Activada', off: 'Desactivada', provider: 'Los detalles de este servicio opcional están disponibles en la política de privacidad.'
    },
    it: {
        title: 'Scelte sulla privacy',
        body: 'L’app funziona normalmente senza condividere informazioni sul suo utilizzo. Se lo consenti, invia informazioni limitate sull’uso per aiutarci a stimare quante persone utilizzano l’app web.',
        detail: 'Queste informazioni possono includere visite, pagine aperte, durata approssimativa delle visite, tipo di browser e dispositivo e fonte del traffico. Non includono il tuo nome, indirizzo e-mail, file caricati o contenuti dei file. Puoi rifiutare senza perdere alcuna funzionalità.',
        required: 'Necessari', requiredBody: 'Memorizzano la scelta sulla privacy e mantengono il sito funzionante.',
        analytics: 'Informazioni sull’uso', analyticsBody: 'Misurazione facoltativa dell’uso generale dell’app web.',
        accept: 'Consenti informazioni sull’uso', reject: 'Rifiuta', configure: 'Configura', save: 'Salva preferenze',
        on: 'Attivata', off: 'Disattivata', provider: 'I dettagli di questo servizio facoltativo sono disponibili nella privacy policy.'
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
