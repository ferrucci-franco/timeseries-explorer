// The navigation log says something when a page leaves on its own, and
// nothing when the script asked it to go.
//
//   npm run e2e:navigation-log
//
// It is the helper every e2e imports (scripts/support/e2e-navigation-log.mjs),
// checked on a page of its own so that the next time a browser check loses its
// page the log beside the failure can be trusted — that is the whole point of
// it (#394). Nothing of the app is loaded here: a blank page, a navigation
// asked for (including one asked for from inside the page, which several
// checks do to see what survives a reload), one that nobody asked for, and a
// reload the Vite client would cause, said through the console the way the
// client says it.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import './support/e2e-navigation-log.mjs';

const lines = [];
const log = console.log;
console.log = (...args) => {
    const text = args.join(' ');
    if (text.startsWith('[e2e ')) lines.push(text);
    else log(...args);
};
const since = () => lines.length;
const printed = (from) => lines.slice(from);

const browser = await chromium.launch();
try {
    const page = await browser.newPage();

    // Asked for: silent.
    let mark = since();
    await page.goto('about:blank');
    await page.setContent('<!doctype html><title>one</title><p>one');
    assert.deepEqual(printed(mark), [], `a navigation the script asked for prints nothing: ${printed(mark).join(' | ')}`);

    // Asked for from inside the page — `page.evaluate(() => location.reload())`
    // is how several checks see what survives a reload — is still asked for.
    mark = since();
    await page.goto('about:blank');
    await page.evaluate(() => { window.location.reload(); });
    await page.waitForTimeout(800);
    assert.deepEqual(printed(mark), [], `a reload asked for from inside the page prints nothing: ${printed(mark).join(' | ')}`);

    // That grace lasts two seconds — a navigation asked for from inside the
    // page commits after the call has returned — so the next case waits it out,
    // or it would be covered by it.
    await page.waitForTimeout(2300);

    // An evaluate that does not navigate is not given that grace: whatever the
    // page does right after one still counts.
    mark = since();
    await page.evaluate(() => document.title);
    await page.setContent('<!doctype html><title>two</title><script>setTimeout(() => { window.location.href = "about:blank#went"; }, 200);</scr' + 'ipt>');
    await page.waitForTimeout(1200);
    const navigated = printed(mark).filter(line => line.includes('navigated on its own'));
    assert.equal(navigated.length, 1, `a page that leaves on its own is said once: ${printed(mark).join(' | ')}`);
    assert.match(navigated[0], /about:blank#went/, 'with the address it went to');

    // The reason, when the page gives one: the Vite client writes these to the
    // console before it replaces the page.
    mark = since();
    await page.evaluate(() => console.log('[vite] page reload src/app/main.js'));
    await page.waitForTimeout(300);
    const says = printed(mark).filter(line => line.includes('page says'));
    assert.equal(says.length, 1, `the page's own reason is said: ${printed(mark).join(' | ')}`);
    assert.match(says[0], /\[vite\] page reload/, 'with the client\'s words');

    // An ordinary console line is not noise in this log.
    mark = since();
    await page.evaluate(() => console.log('drawing 1.2 M rows'));
    await page.waitForTimeout(300);
    assert.deepEqual(printed(mark), [], `an ordinary console line prints nothing: ${printed(mark).join(' | ')}`);

    console.log = log;
    console.log('e2e navigation log: a page that leaves on its own is named, one that was sent is not');
} finally {
    console.log = log;
    await browser.close();
}
