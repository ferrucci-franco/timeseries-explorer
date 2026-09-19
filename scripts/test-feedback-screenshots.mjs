// A report whose attachments are all screenshots is delivered as screenshots.
//
// Every report used to leave one zip in Downloads. For the common case — the
// user pastes two screenshots and presses Open GitHub issue — that meant
// unpacking their own screenshots before they could drag them in, and if they
// dragged the zip instead the issue carried a link nobody opens rather than a
// picture of the bug. One non-image in the set and the zip earns its place
// again: it keeps the whole set together, with feedback.json and feedback.txt
// beside it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installUiMethods } from '../src/app/methods/ui-methods.js';

class Harness {}
installUiMethods(Harness);
const app = new Harness();

const attachment = (name, type) => ({ file: { name, type, size: 1024 } });
const PNG = attachment('screenshot-1.png', 'image/png');
const JPG = attachment('screenshot-2.jpg', 'image/jpeg');
const MAT = attachment('run.mat', 'application/octet-stream');
const NO_TYPE = attachment('mystery', '');

// ─── Which way the attachments go out ──────────────────────────────
assert.equal(app._feedbackDeliveryMode([]), 'none', 'nothing attached, nothing downloaded');
assert.equal(app._feedbackDeliveryMode(null), 'none', 'no list at all is still nothing');
assert.equal(app._feedbackDeliveryMode([PNG]), 'images', 'one screenshot goes as a screenshot');
assert.equal(app._feedbackDeliveryMode([PNG, JPG]), 'images', 'several screenshots, several files');
assert.equal(app._feedbackDeliveryMode([PNG, MAT]), 'package', 'one data file brings the zip back');
assert.equal(app._feedbackDeliveryMode([MAT]), 'package', 'a data file alone is a zip');
// A file the browser could not type is not assumed to be an image: the zip is
// the safe answer, since it carries anything.
assert.equal(app._feedbackDeliveryMode([PNG, NO_TYPE]), 'package', 'an untyped file is not called an image');
assert.equal(app._feedbackDeliveryMode([{ file: null }]), 'none', 'an empty slot is not an attachment');

// ─── What the report tells the reader to do ────────────────────────
const feedback = {
    category: 'bug',
    contact: '',
    summary: 'Axis is wrong',
    details: 'See screenshots',
    expected: '-',
    appVersion: '0.3.0',
    buildSha: 'abc1234',
    buildDate: '2026-09-19',
    pageUrl: 'https://example.invalid/',
    userAgent: 'test',
    createdAt: '2026-09-19T20:00:00.000Z',
    attachmentNames: ['screenshot-1.png', 'screenshot-2.jpg'],
};
const names = ['screenshot-1.png', 'screenshot-2.jpg'];

const issueWithShots = app._formatFeedbackIssueBody(feedback, false, '', names);
assert.match(issueWithShots, /Drag these downloaded screenshots into the GitHub issue/,
    'the issue body names the screenshots to drag in');
for (const name of names) assert.ok(issueWithShots.includes(name), `${name} is named`);
assert.doesNotMatch(issueWithShots, /downloaded package/, 'and says nothing about a package');

const issueWithZip = app._formatFeedbackIssueBody(feedback, false, 'report.zip');
assert.match(issueWithZip, /Attach the downloaded package/, 'a mixed report still points at the zip');
assert.doesNotMatch(issueWithZip, /Drag these downloaded screenshots/, 'and only at the zip');

const issueBare = app._formatFeedbackIssueBody(feedback, false, '');
assert.doesNotMatch(issueBare, /downloaded package|downloaded screenshots/,
    'a report with no attachments asks for nothing');
// The summary, details and build block are what the issue is for; they survive.
for (const fragment of ['Axis is wrong', 'See screenshots', 'Commit: abc1234']) {
    assert.ok(issueBare.includes(fragment), `the report still carries "${fragment}"`);
}

const emailWithShots = app._formatFeedbackEmailBody(feedback, '', names);
assert.match(emailWithShots, /Please attach these downloaded screenshots to this email:/);
for (const name of names) assert.ok(emailWithShots.includes(name), `${name} is named in the email`);
assert.doesNotMatch(emailWithShots, /downloaded zip file/, 'no zip is mentioned when none was made');
assert.match(app._formatFeedbackEmailBody(feedback, 'report.zip'), /Please attach the downloaded zip file/);

// ─── How the form delivers them ────────────────────────────────────
const ui = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
const start = ui.indexOf('const saveBlob = (blob, filename) =>');
const end = ui.indexOf('const openIssue =', start);
assert.ok(start >= 0 && end > start, 'the download path should still be here');
const download = ui.slice(start, end);

assert.match(download, /_feedbackDeliveryMode\(attachedFiles\) === 'images'/,
    'the form asks which way the attachments go');
const screenshotPath = download.slice(download.indexOf('const downloadScreenshots'), download.indexOf('const downloadPackage'));
assert.match(screenshotPath, /saveBlob\(file, file\.name\)/,
    'each screenshot is saved under its own name');
assert.doesNotMatch(screenshotPath, /zipSync/, 'the screenshot path builds no archive');
assert.match(screenshotPath, /setTimeout\(resolve, FEEDBACK_DOWNLOAD_GAP_MS\)/,
    'the saves are spaced, or the browser keeps only the first');
assert.match(download, /const downloadPackage = async \(feedback\) => \{[\s\S]*?zipSync\(zipEntries/,
    'the mixed case still writes one zip');

// The prose beside the buttons has to describe what now happens, in every
// language: an English-only correction is the same bug in a different place.
const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of ['feedbackNextGithub', 'feedbackSafetyNote']) {
    const values = [...translations.matchAll(new RegExp(`${key}: '(.*?)',\\n`, 'g'))].map(m => m[1]);
    assert.equal(values.length, 4, `${key} is defined in all four languages`);
    for (const value of values) {
        assert.ok(/screenshot|capture|captura/i.test(value), `${key} mentions the screenshots: ${value.slice(0, 60)}…`);
    }
}

console.log('Feedback screenshot-delivery checks passed.');
