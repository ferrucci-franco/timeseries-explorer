import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/overlays.css', import.meta.url), 'utf8');
const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
const start = ui.indexOf('proto.showFeedbackForm = function() {');
const end = ui.indexOf('proto._createFeedbackField', start);
assert(start >= 0 && end > start, 'Feedback form implementation should be present');

const feedbackForm = ui.slice(start, end);
const finishBody = feedbackForm.match(/const finish = \(\) => \{([\s\S]*?)\n    \};/)?.[1] || '';
assert.match(feedbackForm, /feedbackDraftNote/, 'Feedback form should explain that closing preserves the in-session draft');
assert.match(feedbackForm, /const body = document\.createElement\('div'\)/, 'Feedback form should create a dedicated scroll body');
assert.match(feedbackForm, /body\.className = 'feedback-body'/, 'Feedback form body should use its layout class');
assert.match(feedbackForm, /body\.append\(fields, attachmentSection, sendNote\)/, 'Feedback body should contain fields, attachments, and what Send does');
assert.match(feedbackForm, /form\.append\(header, body, actions\)/, 'Feedback actions should stay outside the scroll body');
assert.match(feedbackForm, /const clearButton = document\.createElement\('button'\)/, 'Feedback form should create a Clear form button');
assert.match(feedbackForm, /clearButton\.textContent = i18n\.t\('feedbackClearForm'\)/, 'Feedback clear button should use a dedicated translation');
assert.match(feedbackForm, /const minimizeButton = document\.createElement\('button'\)/, 'Feedback form should create an explicit minimize button');
assert.match(feedbackForm, /minimizeButton\.textContent = i18n\.t\('feedbackMinimize'\)/, 'Feedback minimize button should not look like it discards the form');
assert.match(feedbackForm, /actions\.append\(status, clearButton, minimizeButton, sendButton\)/, 'Feedback actions should expose the status, Clear, Minimize and Send');
assert.match(feedbackForm, /minimizeButton\.addEventListener\('click', finish\)/, 'Feedback minimize button should close the form explicitly');
assert.match(feedbackForm, /this\._feedbackDraft = \{[\s\S]*?attachments: attachedFiles\.map/, 'Feedback close should preserve a draft in memory for this browser session');
assert.match(feedbackForm, /const finish = \(\) => \{\s*if \(!sent\) saveDraft\(\);[\s\S]*?Modal\.close/, 'Feedback close should save the draft before closing');
assert.match(feedbackForm, /const clearForm = \(\) => \{[\s\S]*?this\._feedbackDraft = null;[\s\S]*?renderFiles\(\);/, 'Feedback clear should discard the in-memory draft and rerender files');

// ── One button, and no homework ─────────────────────────────────────────────
// The form used to end with "now open GitHub, sign in, and drag your
// screenshots in", or with a mailto: that most machines cannot honour. Both
// asked the reporter to do the filing. Send does it for them.
assert.match(feedbackForm, /sendButton\.textContent = i18n\.t\('feedbackSend'\)/, 'the one action is Send');
assert.match(feedbackForm, /sendFeedbackReport\(\{ endpoint: FEEDBACK_ENDPOINT, report \}\)/, 'Send posts the report to the endpoint');
assert.match(feedbackForm, /form\.addEventListener\('submit', \(event\) => \{\s*\n\s*event\.preventDefault\(\);\s*\n\s*send\(\);/, 'submitting the form sends it');
assert.doesNotMatch(feedbackForm, /mailto:/, 'no path through the form opens a mail client');
assert.doesNotMatch(feedbackForm, /emailButton|issueButton/, 'GitHub and email are no longer buttons of their own');
// They survive only as the way out of a failed send, never as a first step.
assert.match(feedbackForm, /const buildFallback = \(\) => \{[\s\S]*?i18n\.t\('feedbackOpenIssue'\)/, 'a failed send still offers to file it by hand');
assert.match(feedbackForm, /setStatus\('error', \{ text: `\$\{text\}\$\{detail\}`, fallback: true \}\)/, 'the fallback appears only after a failure');
// A refusal the endpoint named is read back in the reporter's language; one it
// did not keeps the endpoint's English rather than becoming a shrug.
assert.match(feedbackForm, /FEEDBACK_REFUSAL_KEYS\[error\?\.code\]/, 'a coded refusal is translated');
assert.match(feedbackForm, /!translatedRefusal && error\?\.detail/, 'an uncoded one still says what happened');

// ── Full Desktop keeps its promise not to transmit ──────────────────────────
// It cancels every external request the renderer makes (electron/navigation-
// policy.cjs). Rather than cut a hole in that for one feature, Feedback there
// opens the web build in the user's own browser, which made no such promise.
assert.match(feedbackForm, /if \(this\.capabilities\?\.isDesktop\) \{\s*\n\s*this\._openFeedbackInBrowser\(\);\s*\n\s*return;/,
    'the desktop edition never builds the sending form at all');
const handoff = ui.slice(ui.indexOf('proto._openFeedbackInBrowser'), ui.indexOf('proto.showFeedbackForm'));
assert.match(handoff, /buildFeedbackHandoffUrl\(ONLINE_VERSION_URL/, 'it hands over to the published web app');
assert.match(handoff, /version: APP_VERSION,[\s\S]{0,120}?platform: globalThis\.omvDesktop\?\.platform/,
    'carrying the build the report is actually about');
assert.match(handoff, /Modal\.confirm\(/, 'and says so before a browser window appears unannounced');
assert.doesNotMatch(handoff, /fetch\(/, 'the desktop edition itself requests nothing');
const fromUrl = ui.slice(ui.indexOf('proto.openFeedbackFromUrl'), ui.indexOf('proto.showFeedbackForm'));
assert.match(fromUrl, /readFeedbackHandoff\(globalThis\.location\?\.search/, 'the web end reads the handover');
assert.match(fromUrl, /searchParams\.delete\(key\)[\s\S]{0,120}?replaceState/,
    'and clears the query, so a reload does not reopen the form');
assert.match(feedbackForm, /sent = true;[\s\S]*?this\._feedbackDraft = null;/, 'a filed report is not left in the draft to be sent twice');
assert.match(feedbackForm, /sendButton\.hidden = true;/, 'and the Send button goes away once it is filed');

// ── Ctrl+V works wherever the caret is ──────────────────────────────────────
// It used to listen on the drop zone alone, which only receives the event
// while it holds focus -- and the form opens with the focus in the summary
// field, so the first thing anyone tries did nothing at all.
assert.match(feedbackForm, /document\.addEventListener\('paste', onDocumentPaste, true\)/, 'the paste listener covers the whole dialog');
assert.match(feedbackForm, /document\.removeEventListener\('paste', onDocumentPaste, true\)/, 'and is taken down when the form closes');
assert.doesNotMatch(feedbackForm, /pasteZone\.addEventListener\('paste'/, 'not on the drop zone, which has to be focused first');
assert.match(feedbackForm, /const files = filesFromTransfer\(event\.clipboardData\);\s*\n\s*if \(!files\.length\) return;/, 'a paste carrying no file is left to the text field');
// Some browsers only fill `items` for a pasted image, never `files`.
assert.match(feedbackForm, /Array\.from\(transfer\.items \|\| \[\]\)[\s\S]*?item\.kind === 'file'/, 'both clipboard shapes are read');
assert.match(feedbackForm, /navigator\.clipboard\.read\(\)/, 'and a button exists for clipboards that need an explicit gesture');
assert.doesNotMatch(finishBody, /attachedFiles\.forEach\(releasePreview\)/, 'Feedback close should not discard attachment previews');
assert.doesNotMatch(feedbackForm, /overlay\.addEventListener\('click'[\s\S]*?finish\(\)/, 'Feedback form should not close on backdrop clicks');
assert.doesNotMatch(feedbackForm, /key === 'Escape'[\s\S]*?finish\(\)/, 'Feedback form should not discard input through Escape');
assert.equal([...translations.matchAll(/feedbackDraftNote:/g)].length, 4, 'Feedback draft note should be translated in every supported language');
assert.equal([...translations.matchAll(/feedbackClearForm:/g)].length, 4, 'Feedback clear button should be translated in every supported language');
assert.equal([...translations.matchAll(/feedbackMinimize:/g)].length, 4, 'Feedback minimize button should be translated in every supported language');
for (const key of ['feedbackSend', 'feedbackSending', 'feedbackSentBody', 'feedbackSentLink', 'feedbackClose',
    'feedbackSendNote', 'feedbackPasteButton', 'feedbackErrorOffline', 'feedbackErrorRejected',
    'feedbackErrorServer', 'feedbackErrorTimeout', 'feedbackErrorNotConfigured', 'feedbackFallbackIntro',
    'feedbackErrorRateLimited', 'feedbackErrorTooLarge', 'feedbackErrorInvalid', 'feedbackErrorTypeRejected',
    'feedbackDesktopTitle', 'feedbackDesktopBody', 'feedbackDesktopOpen', 'feedbackDesktopOpened']) {
    assert.equal([...translations.matchAll(new RegExp(`${key}:`, 'g'))].length, 4, `${key} should exist in all four languages`);
}
// The keys of the paths that are gone must be gone too, or the next reader
// has to work out which of two explanations the form actually follows.
for (const key of ['feedbackNextTitle', 'feedbackNextGithub', 'feedbackNextEmail', 'feedbackEmailInstead']) {
    assert.equal([...translations.matchAll(new RegExp(`${key}:`, 'g'))].length, 0, `${key} should no longer be defined`);
}
assert.match(css, /\.feedback-dialog\s*\{[\s\S]*?width:\s*min\(92vw,\s*1120px\);[\s\S]*?height:\s*min\(92vh,\s*920px\);/, 'Feedback dialog should use more of the available width and height');
assert.match(css, /\.feedback-draft-note\s*\{[\s\S]*?color:\s*#2e7d32;[\s\S]*?font-weight:\s*700;/, 'Feedback draft note should be green in light theme');
assert.match(css, /\.theme-dark \.feedback-draft-note\s*\{[\s\S]*?color:\s*#81c784;/, 'Feedback draft note should use a distinct green in dark theme');
assert.match(css, /\.feedback-content\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto;[\s\S]*?overflow:\s*hidden;/, 'Feedback form should keep header and actions outside the scrolling area');
assert.match(css, /\.feedback-body\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*auto;/, 'Feedback body should own scrolling');
assert.match(css, /\.feedback-actions\s*\{[\s\S]*?border-top:\s*1px solid var\(--border-color\);[\s\S]*?background:\s*var\(--bg-primary\);/, 'Feedback actions should have their own non-overlapping footer surface');
// The answer to pressing Send belongs next to Send, on its own full-width row
// rather than squeezed between the buttons.
assert.match(css, /\.feedback-status\s*\{[\s\S]*?flex:\s*1 1 100%;/, 'the status spans the footer');
// Setting `display` on the class defeats the browser's own [hidden] rule,
// which is an attribute selector and so one step less specific: without this,
// the empty status box draws as a grey bar above the buttons before anything
// has been reported.
assert.match(css, /\.feedback-status\[hidden\]\s*\{\s*display:\s*none;/, 'an empty status is really hidden');
assert.match(css, /\.feedback-status\.is-sent\s*\{[\s\S]*?#2e7d32/, 'a filed report reads as success');
assert.match(css, /\.feedback-status\.is-error\s*\{[\s\S]*?#c62828/, 'and a failure reads as one');
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}?\.feedback-status\.is-sending/, 'the spinner respects a request for less motion');

console.log('Feedback form dismissal checks passed.');
