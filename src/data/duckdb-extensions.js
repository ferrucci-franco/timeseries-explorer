// Where the query engine gets its Parquet reader.
//
// DuckDB-WASM does not carry Parquet support inside its main binary. The first
// Parquet query makes it download a separate, signed module from
// extensions.duckdb.org. Offline, behind a firewall that blocks that host, or
// on the desktop app with no network, the download fails and the engine
// reports it as "null function or function signature mismatch" or "table
// index is out of bounds": nothing a reader can act on.
//
// So the build fetches that module once (scripts/fetch-duckdb-extensions.mjs)
// and ships it next to the app, under duckdb-extensions/, with a manifest that
// lists what is there. At run time the engine loads Parquet from the app's own
// copy; the public download is only the fallback for a copy of the app built
// without it, such as a development checkout that never ran the fetch.
//
// The shipped file is byte-for-byte the one DuckDB publishes. It keeps its
// signature, and the engine still refuses unsigned modules, so a damaged or
// replaced copy fails to load instead of running.
//
// Pure on purpose: the build script and the tests import it without a browser.

/** Folder of the app, relative to its page, that holds the modules. */
export const DUCKDB_EXTENSIONS_DIR = 'duckdb-extensions';

/** File in that folder listing the modules the build fetched. */
export const DUCKDB_EXTENSIONS_MANIFEST = 'manifest.json';

/** The public repository the engine downloads from by default. */
export const DUCKDB_EXTENSIONS_REMOTE = 'https://extensions.duckdb.org';

/** The engine builds the app loads (see BUNDLES in duckdb-source.js). */
export const DUCKDB_WASM_PLATFORMS = Object.freeze(['wasm_eh', 'wasm_mvp']);

/** The modules the app needs. */
export const DUCKDB_BUNDLED_EXTENSIONS = Object.freeze(['parquet']);

/** `code` of the error thrown when no copy of the Parquet reader loads. */
export const PARQUET_EXTENSION_UNAVAILABLE = 'PARQUET_EXTENSION_UNAVAILABLE';

/**
 * Path of one module inside a repository, as DuckDB lays it out:
 * `<version>/<platform>/<name>.duckdb_extension.wasm`.
 */
export function extensionFilePath(version, platform, name) {
    return `${version}/${platform}/${name}.duckdb_extension.wasm`;
}

/**
 * The repository URL to hand the engine when the app ships this module, or
 * null when it does not.
 *
 * Absolute on purpose: the engine fetches from inside its worker, whose base
 * URL is the worker script's, not the page's, so a relative path would point
 * somewhere else. No trailing slash: DuckDB appends `/<version>/...` itself.
 *
 * @param {unknown} manifest the parsed manifest, or anything else when it
 *   could not be read (missing, or a page served in its place)
 * @param {{version: string, platform: string, name: string, baseUrl: string}} where
 * @returns {string|null}
 */
export function localExtensionRepository(manifest, { version, platform, name, baseUrl }) {
    if (!manifest || typeof manifest !== 'object') return null;
    const files = manifest.files;
    if (!files || typeof files !== 'object') return null;
    if (!version || !platform || !name || !baseUrl) return null;
    if (!files[extensionFilePath(version, platform, name)]) return null;
    try {
        return new URL(DUCKDB_EXTENSIONS_DIR, baseUrl).href.replace(/\/+$/, '');
    } catch {
        return null;
    }
}

/**
 * The error for "no copy of the Parquet reader could be loaded". Carries the
 * engine's own messages so the details pane and bug reports keep them.
 *
 * @param {unknown[]} causes one per attempt, in the order they were made
 */
export function parquetUnavailableError(causes = []) {
    const texts = causes
        .map(cause => (cause instanceof Error ? cause.message : String(cause ?? '')).split('\n')[0].trim())
        .filter(Boolean);
    const err = new Error(`The Parquet reader could not be loaded${texts.length ? `: ${texts.join(' | ')}` : ''}`);
    err.code = PARQUET_EXTENSION_UNAVAILABLE;
    return err;
}
