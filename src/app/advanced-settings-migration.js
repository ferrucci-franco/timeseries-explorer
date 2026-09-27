// Settings are stored whole, defaults included, so a changed default never
// reached anyone who had once saved any setting. A version on the stored
// object says which defaults it was written under, and this turns an old
// object into one the current defaults can be merged under.
//
// Kept free of DOM and storage so it can be tested directly.

/** Which defaults a settings object written today was written under. */
export const ADVANCED_SETTINGS_VERSION = 2;

/**
 * @param {unknown} saved what was read from storage (anything, or nothing)
 * @returns {object} the stored values that still count as the user's choices
 */
export function migrateAdvancedSettings(saved) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    const next = { ...saved };
    const version = Number(next.settingsVersion) || 1;
    // Version 2 raised the CSV full-load limit from 150 MB to 300 MB. A stored
    // 150 from before it is the old default, not a choice, and is dropped so
    // the new one applies. Someone who had deliberately picked 150 gets 300 and
    // can set it back; that is the one case this cannot tell apart.
    if (version < 2 && Number(next.csvFullLoadMb) === 150) delete next.csvFullLoadMb;
    delete next.settingsVersion;
    return next;
}
