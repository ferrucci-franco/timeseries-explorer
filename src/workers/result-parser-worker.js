import CsvParser from '../parsers/csv-parser.js';

const csvParser = new CsvParser();

self.addEventListener('message', async (event) => {
    const { id, filename, buffer, csvProfile } = event.data || {};
    try {
        const data = csvProfile?.profileSource === 'user'
            ? await csvParser.parseWithProfile(buffer, csvProfile)
            : await csvParser.parse(buffer);
        data.filename = filename || '';
        self.postMessage({ id, ok: true, data });
    } catch (err) {
        self.postMessage({
            id,
            ok: false,
            error: {
                name: err?.name || 'Error',
                message: err?.message || String(err),
                stack: err?.stack || '',
            },
        });
    }
});
