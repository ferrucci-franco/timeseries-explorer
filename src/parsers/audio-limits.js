// What "too big" means for an audio file, and why it is not measured in bytes
// on disk.
//
// Every other eager-only format is guarded by the size of the file, which is a
// fair proxy for what it will cost in memory. Audio is the one format where
// that proxy breaks outright: 5 MB of WAV is about 1.3 million samples, 5 MB of
// MP3 is closer to twenty times that. Warning on file size would wave the
// expensive case through in silence and stop the cheap one.
//
// So the limit is on the DECODED size — the memory the app is about to
// allocate — and it is checked once the samples exist and before they are
// copied into the app's own columns. That is also why audio is absent from
// EAGER_ONLY_FORMATS in src/app/file-size-limits.js: that check happens before
// the file is read, which is exactly too early to be meaningful here.

export const AUDIO_WEB_DECODED_LIMIT_BYTES = 400 * 1024 * 1024;
export const AUDIO_DESKTOP_DECODED_LIMIT_BYTES = 1024 * 1024 * 1024;
export const AUDIO_DEFAULT_DECODED_LIMIT_BYTES = AUDIO_WEB_DECODED_LIMIT_BYTES;

// One Float64 column per channel plus one for the time vector. Float64 and not
// Float32 — which is what the samples natively are — because every other parser
// in the app produces Float64 columns and the time vector genuinely needs the
// precision: at 48 kHz, twenty minutes in, consecutive sample times are closer
// together than Float32 can tell apart.
export const AUDIO_BYTES_PER_VALUE = 8;

/** Memory the decoded audio will occupy as app columns: channels + time. */
export function decodedAudioBytes(frames, channels) {
    const frameCount = Math.max(0, Number(frames) || 0);
    const channelCount = Math.max(0, Number(channels) || 0);
    return frameCount * (channelCount + 1) * AUDIO_BYTES_PER_VALUE;
}
