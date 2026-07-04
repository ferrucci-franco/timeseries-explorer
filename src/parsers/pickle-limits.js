export const PICKLE_WEB_EAGER_LIMIT_BYTES = 80 * 1024 * 1024;
export const PICKLE_DESKTOP_EAGER_LIMIT_BYTES = 200 * 1024 * 1024;
export const PICKLE_DEFAULT_EAGER_LIMIT_BYTES = PICKLE_WEB_EAGER_LIMIT_BYTES;

export const PICKLE_DEFAULT_INTERNAL_LIMITS = Object.freeze({
    maxArrayBytes: 512 * 1024 * 1024,
    maxArrayElements: 50_000_000,
    maxShapeRank: 8,
    maxFrameBytes: 128 * 1024 * 1024,
    maxMemoEntries: 1_000_000,
    maxConstructedObjects: 1_000_000,
});
