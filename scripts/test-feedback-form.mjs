import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
const start = ui.indexOf('proto.showFeedbackForm = function() {');
const end = ui.indexOf('proto._createFeedbackField', start);
assert(start >= 0 && end > start, 'Feedback form implementation should be present');

const feedbackForm = ui.slice(start, end);
assert.match(feedbackForm, /const cancelButton = document\.createElement\('button'\)/, 'Feedback form should create an explicit cancel button');
assert.match(feedbackForm, /cancelButton\.textContent = i18n\.t\('cancel'\)/, 'Feedback cancel button should use the shared Cancel translation');
assert.match(feedbackForm, /actions\.append\(cancelButton, emailButton, issueButton\)/, 'Feedback actions should expose Cancel before send actions');
assert.match(feedbackForm, /cancelButton\.addEventListener\('click', finish\)/, 'Feedback cancel button should close the form explicitly');
assert.doesNotMatch(feedbackForm, /overlay\.addEventListener\('click'[\s\S]*?finish\(\)/, 'Feedback form should not close on backdrop clicks');
assert.doesNotMatch(feedbackForm, /key === 'Escape'[\s\S]*?finish\(\)/, 'Feedback form should not discard input through Escape');

console.log('Feedback form dismissal checks passed.');
