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

// What the object is, and is not.
//
// The isX/fileProtocol keys describe the runtime. Only three keys gate anything:
// isDesktop, canUseLiveUpdate and canUseLocalPath. There used to be four more —
// canUseStaticFiles, canUseDuckDbWasm, canUseHugeFiles, canExportParquet — that
// no code read: the real decisions are re-derived where they are made
// (_canUseDuckDb() re-checks Worker/WASM, and the per-format byte limits gate
// large files off isDesktop). canUseDuckDbWasm was not even equivalent to
// _canUseDuckDb(), so a maintainer trusting the object would have gated on a
// different condition than the engine actually uses. They are gone rather than
// wired up, because nothing wanted them.
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
        canUseLiveUpdate: desktop,
        canUseLocalPath: desktop,
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
        showRuntimeNotice: true,
    };
}
