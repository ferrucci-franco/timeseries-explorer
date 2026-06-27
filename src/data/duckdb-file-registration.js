export function isDuckDbHttpFile(file) {
    return !!(file?.__omvLocalHttpFile && file.localUrl);
}

export async function registerDuckDbFile(db, duckdbModule, name, file) {
    if (isDuckDbHttpFile(file)) {
        await db.registerFileURL(
            name,
            file.localUrl,
            duckdbModule.DuckDBDataProtocol.HTTP,
            false,
        );
        return 'http';
    }

    await db.registerFileHandle(
        name,
        file,
        duckdbModule.DuckDBDataProtocol.BROWSER_FILEREADER,
        true,
    );
    return 'browser-filereader';
}
