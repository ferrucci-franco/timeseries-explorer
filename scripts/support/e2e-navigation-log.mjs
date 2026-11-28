// Say what navigated, and why, when an e2e loses its page.
//
// Imported for its effect by every e2e script. It prints nothing while a run
// goes well; when a page navigates on its own, or the dev server reloads it,
// the line is in the CI log beside the failure.
//
// Why: a browser check failed once in `e2e:gridded-netcdf` with "Execution
// context was destroyed, most likely because of a navigation", while a saved
// project was loading, and left nothing to go on (#394). Two of the three
// candidates have since been ruled out — the version check cannot fire, since
// `vite.config.js` reads GIT_SHA once for both the bundle and the version.json
// the dev server answers; and Vite's dependency optimizer is not it either,
// since with a cold cache the first request already bundles all ten of the
// app's packages whether or not they are declared in `optimizeDeps.include`
// (measured). What is left needs the next occurrence to say something about
// itself, which is what this is for.
//
// What it prints, each with the seconds since the script started:
//
//   · every main-frame navigation, with its URL — a `?build=` address is the
//     version check reloading to another build, the same address is a reload;
//   · the page's own account of it: the Vite client writes "[vite] page
//     reload", an outdated optimize dep or a lost connection to the console
//     before it replaces the page, so the server's reason arrives here;
//   · a crashed page, and a worker that died — a renderer that goes down
//     reads as a destroyed context too.
//
// It patches the `chromium.launch` the scripts already call, which is why
// importing it is enough: the module hands back the same object this wraps.

import { chromium } from 'playwright';

const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const say = (what, detail) => console.log(`[e2e ${at()}] ${what}${detail ? `: ${detail}` : ''}`);

// What the Vite client says when the page is about to be replaced. Not its
// "connecting…" and "connected.", which every page load writes and which
// explain nothing: this log is for lines that come before a page goes.
const REASON = /outdated optimize dep|page reload|server connection lost|hmr update|invalidat/i;

const WATCHED = Symbol.for('omv.e2e.navigationLog');

function watchPage(page) {
    // Once per page: `browser.newPage()` goes through the public
    // `newContext()` and `context.newPage()`, both wrapped below, so a page
    // created that way arrives here twice — and a listener added twice says
    // everything twice.
    if (!page || page[WATCHED]) return page;
    page[WATCHED] = true;
    // A navigation the script asked for is not news. `goto` and `reload` raise
    // this while they run, so what prints is a page that left on its own.
    let asked = 0;
    for (const name of ['goto', 'reload', 'goBack', 'goForward', 'setContent']) {
        const original = page[name]?.bind(page);
        if (!original) continue;
        page[name] = async (...args) => {
            asked += 1;
            try {
                return await original(...args);
            } finally {
                asked -= 1;
            }
        };
    }
    // Chromium raises this twice for one navigation of its own (the
    // same-document hop and the commit), and a line repeated is a line that
    // reads as two incidents.
    let lastUrl = '';
    let lastAt = 0;
    page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        if (asked > 0) return;
        const url = frame.url();
        const now = Date.now();
        if (url === lastUrl && now - lastAt < 1000) return;
        lastUrl = url;
        lastAt = now;
        say('main frame navigated on its own', url);
    });
    page.on('console', (message) => {
        const text = message.text() || '';
        if (REASON.test(text)) say('page says', text.slice(0, 300));
    });
    // A renderer that goes down reads as a destroyed context too. Its workers
    // closing is not a signal: the app ends them whenever a file is released.
    page.on('crash', () => say('page crashed'));
    return page;
}

function watchBrowser(browser) {
    const newPage = browser.newPage.bind(browser);
    browser.newPage = async (...args) => watchPage(await newPage(...args));
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
        const context = await newContext(...args);
        const contextPage = context.newPage.bind(context);
        context.newPage = async (...inner) => watchPage(await contextPage(...inner));
        return context;
    };
    return browser;
}

const launch = chromium.launch.bind(chromium);
chromium.launch = async (...args) => watchBrowser(await launch(...args));
