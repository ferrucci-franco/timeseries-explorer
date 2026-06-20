const LOCAL_API_BASE = '/__omv_local__';

function isDesktopRuntime() {
    return !!globalThis.omvDesktop;
}

function isLocalhost() {
    const host = globalThis.location?.hostname || '';
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function isStaticPublishedPage() {
    const host = globalThis.location?.hostname || '';
    return host.endsWith('.github.io') || host.includes('github.io');
}

async function hasLocalApi() {
    if (typeof fetch !== 'function') return false;
    try {
        const response = await fetch(`${LOCAL_API_BASE}/status`, { cache: 'no-store' });
        if (!response.ok) return false;
        const status = await response.json().catch(() => null);
        return !!status?.ok;
    } catch {
        return false;
    }
}

export function initialCapabilities() {
    const desktop = isDesktopRuntime();
    const fileProtocol = globalThis.location?.protocol === 'file:';
    const published = isStaticPublishedPage();

    return {
        runtime: desktop ? 'full-desktop' : 'light-web',
        label: desktop ? 'Full Desktop' : 'Light Web',
        isDesktop: desktop,
        isLocalServer: false,
        isPublishedLight: published,
        isLocalhost: isLocalhost(),
        fileProtocol,
        canUseStaticFiles: true,
        canUseDuckDbWasm: !fileProtocol && typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined',
        canUseLiveUpdate: desktop,
        canUseLocalPath: desktop,
        canUseHugeFiles: desktop,
        canExportParquet: desktop,
        showRuntimeNotice: true,
    };
}

export async function resolveCapabilities(previous = initialCapabilities()) {
    const localServer = await hasLocalApi();
    const desktop = previous.isDesktop || isDesktopRuntime();
    const runtime = desktop ? 'full-desktop' : 'light-web';

    return {
        ...previous,
        runtime,
        label: desktop ? 'Full Desktop' : 'Light Web',
        isDesktop: desktop,
        isLocalServer: localServer,
        isPublishedLight: isStaticPublishedPage(),
        isLocalhost: isLocalhost(),
        canUseLiveUpdate: desktop,
        canUseLocalPath: desktop,
        canUseHugeFiles: desktop,
        canExportParquet: desktop,
        showRuntimeNotice: true,
    };
}
