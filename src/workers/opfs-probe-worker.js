// How much the origin's storage really takes: the largest file of OPFS that
// can be grown and written to, up to a size asked.
//
// The quota the browser reports is not always what it gives. In a private
// (incognito) window the origin's storage is held in memory with a limit of
// its own — measured in Chromium: ~1 GB on a machine with 16 GB, while
// navigator.storage.estimate() said 3.2 GB — and past it a write to OPFS does
// not throw: it is simply not there when read back. DuckDB's database there
// then stops growing and its reads stall. So before a job DuckDbSource asks
// this worker (synchronous access handles exist only in workers): a probe
// file is stretched to the size (truncate), a byte written at its end and read
// back; on a disk that is a sparse file, done in a millisecond; where the
// storage is memory it is refused past what there is. Halving narrows it to
// `precision`. The probe file is removed.
//
// In: { max, precision } (bytes). Out: { room } — the largest size that
// held, `max` when it did — or { error }.

const PROBE_NAME = 'omv-room-probe';

async function holds(root, size) {
    const handle = await root.getFileHandle(PROBE_NAME, { create: true });
    const access = await handle.createSyncAccessHandle();
    try {
        access.truncate(size);
        const at = size - 1;
        access.write(new Uint8Array([0x5a]), { at });
        access.flush();
        const back = new Uint8Array(1);
        access.read(back, { at });
        return back[0] === 0x5a && access.getSize() === size;
    } catch (_) {
        return false;
    } finally {
        try { access.truncate(0); } catch (_) { /* gone */ }
        access.close();
        try { await root.removeEntry(PROBE_NAME); } catch (_) { /* gone */ }
    }
}

self.onmessage = async (event) => {
    const max = Math.max(1, Math.floor(Number(event.data?.max) || 0));
    const precision = Math.max(1 << 20, Math.floor(Number(event.data?.precision) || 16 << 20));
    try {
        const root = await navigator.storage.getDirectory();
        if (await holds(root, max)) {
            self.postMessage({ room: max });
            return;
        }
        let lo = 0;
        let hi = max;
        while (hi - lo > precision) {
            const mid = Math.floor((lo + hi) / 2);
            if (await holds(root, mid)) lo = mid;
            else hi = mid;
        }
        self.postMessage({ room: lo });
    } catch (err) {
        self.postMessage({ error: String(err?.message || err) });
    }
};
