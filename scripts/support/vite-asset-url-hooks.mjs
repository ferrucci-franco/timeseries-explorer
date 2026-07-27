// Node module hooks that let a browser module be imported by a test.
//
// duckdb-source.js imports the WASM bundles through Vite's `?url` suffix, which
// Node cannot resolve — that is the only reason the conversion SQL had no real
// test and shipped producing all-String Parquet files. These hooks turn each
// `?url` import into a plain string, which is exactly what Vite hands the
// module at build time, so the real class can be imported and exercised.
//
//   import { register } from 'node:module';
//   register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));

const STUB_SCHEME = 'vite-asset:';

export async function resolve(specifier, context, next) {
    if (specifier.includes('?url') || specifier.includes('?worker')) {
        return { url: `${STUB_SCHEME}${encodeURIComponent(specifier)}`, shortCircuit: true };
    }
    return next(specifier, context);
}

export async function load(url, context, next) {
    if (url.startsWith(STUB_SCHEME)) {
        const specifier = decodeURIComponent(url.slice(STUB_SCHEME.length));
        return {
            format: 'module',
            shortCircuit: true,
            source: `export default ${JSON.stringify(`/${specifier.replace(/\?.*$/, '')}`)};`,
        };
    }
    return next(url, context);
}
