// Opens a netCDF4/HDF5 file with h5wasm, by parts when it can.
//
// Inside a Worker a File is mounted with WORKERFS: h5wasm then reads only the
// bytes it needs, through File.slice, and the file is never copied into
// memory, which is what lets a multi-GB file open. Elsewhere (Node tests, the
// in-page fallback with no Worker) the bytes are written to the in-memory
// filesystem first. Shared by the gridded datasets and the series reader.

import h5wasm from 'h5wasm';

let sequence = 0;

/**
 * @param {{file?: File|Blob, buffer?: ArrayBuffer|Uint8Array, filename?: string}} input
 * @returns {Promise<{file: object, close: () => void, byParts: boolean}>}
 */
export async function openHdf5(input) {
    const module = await h5wasm.ready;
    const FS = module.FS;
    const slot = sequence++;
    let path;
    let cleanup;
    let byParts = false;
    if (input.file && typeof FileReaderSync === 'function' && FS.filesystems?.WORKERFS) {
        const directory = `/hdf5-${slot}`;
        FS.mkdir(directory);
        const name = String(input.file.name || input.filename || 'dataset.nc').replace(/[\\/]/g, '_') || 'dataset.nc';
        const file = name === input.file.name ? input.file : new File([input.file], name);
        FS.mount(FS.filesystems.WORKERFS, { files: [file] }, directory);
        path = `${directory}/${name}`;
        byParts = true;
        cleanup = () => {
            try { FS.unmount(directory); } catch { /* already gone */ }
            try { FS.rmdir(directory); } catch { /* already gone */ }
        };
    } else {
        const bytes = input.buffer
            ? (input.buffer instanceof Uint8Array ? input.buffer : new Uint8Array(input.buffer))
            : new Uint8Array(await input.file.arrayBuffer());
        path = `/hdf5-${slot}.nc`;
        FS.writeFile(path, bytes);
        cleanup = () => {
            try { FS.unlink(path); } catch { /* already gone */ }
        };
    }
    let file;
    try {
        file = new h5wasm.File(path, 'r');
    } catch (error) {
        cleanup();
        throw error;
    }
    return {
        file,
        byParts,
        close() {
            try { file.close(); } catch { /* already closed */ }
            cleanup();
        },
    };
}
