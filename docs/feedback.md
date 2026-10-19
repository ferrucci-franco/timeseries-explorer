# Feedback Collection

The Feedback command opens a form with one button: **Send**. The report, with
its screenshots, becomes a GitHub issue in this repository. The person
reporting the problem needs no GitHub account, no email program, and has
nothing to drag anywhere.

## Why it works this way

A static page cannot open an issue for someone who is not signed in to GitHub,
and it cannot attach a file to an issue at all — there is no public API for
issue attachments, and a token in the page would be a token anyone could take.

The form used to answer that with two paths, and both ended with the reporter
doing the maintainer's filing:

- *Open GitHub issue* prefilled a new issue, downloaded the screenshots, and
  asked the reporter to sign in and drag them in.
- *Email instead* opened `mailto:`, which does nothing on a machine with no mail
  client configured — which is most machines people review a web app on.

So the app now posts the report to a small endpoint that holds the token
(`server/feedback-worker`, deployed on Cloudflare's free plan). The endpoint
commits the attachments to the `feedback-attachments` branch, opens the issue
with the screenshots inline, and answers with the issue's URL, which the form
shows as a link.

## What the form collects

- a category: bug, idea or question
- a short summary (the issue title) and the details
- optionally, the expected result or context
- optionally, a contact address
- screenshots and files
- automatically: app version, commit, build date, page URL, browser, language

## Attachments

Screenshots are pasted with **Ctrl+V anywhere in the form**, dropped anywhere
on the dialog, chosen with *Choose files*, or taken from the clipboard with
*Paste screenshot* where the browser allows reading it.

A screenshot over 600 KB is re-encoded to JPEG, at most 2000 px on its longest
edge, before it is sent. The picture stays readable, the upload is quick on a
bad connection, and the endpoint — which gets 10 ms of CPU per request on the
free plan — has far less to move. It is kept only if the result is actually
smaller.

The limits, enforced both in the form and again in the worker, because a limit
checked only in the page is not a limit:

| | |
| --- | --- |
| Attachments | at most 10 |
| Each attachment | 4 MB |
| All attachments | 8 MB |
| File types | images, text, csv/json/yaml, zip, and this app's data formats |

## The wire format

One line of JSON, then one line of base64 per attachment, in the order the
first line lists them:

```
{"schema":1,"summary":"…","attachments":[{"name":"screenshot-1.jpg",…}]}
/9j/4AAQSkZJRgABAQAAAQ…
```

Not one JSON document with the files inside it, because `JSON.parse` of a
multi-megabyte document spends more than the free plan's whole CPU budget on
its own. With line framing the worker parses only the short head and hands each
attachment to GitHub as an untouched substring. Base64 contains no newline, so
the framing is unambiguous.

## When the send fails

Nothing is lost. The form keeps everything it holds, says what went wrong —
offline, too slow, refused with the endpoint's own words, or "this build has no
endpoint" — and offers the old manual paths as a way out: save the report (and
its screenshots) to Downloads, or open a prefilled GitHub issue. Closing the
form keeps the draft for the rest of the browser session either way.

A refusal from the endpoint carries a short code (`too-large`, `rate-limited`,
`invalid`, `type-rejected`) beside its English sentence, so the form can say it
in the reporter's own language; a code this build does not know falls back to
the sentence rather than to silence.

A build with no `OMV_FEEDBACK_ENDPOINT` behaves exactly like that failure: the
form works, the send does not pretend to.

The Full Desktop edition denies every external request by design
(`electron/navigation-policy.cjs`), so Send cannot reach the endpoint there and
says so in those words — not "check your connection" — and offers the same
fallback. Making it work there means allowing that one host through, which is a
deliberate change to the offline-first guarantee.

## Configuring it

The endpoint URL is a build-time value: `OMV_FEEDBACK_ENDPOINT`, injected by
Vite as `__FEEDBACK_ENDPOINT__`. The Pages workflow passes it from the
repository variable of the same name. Deployment is in
[`server/feedback-worker/README.md`](../server/feedback-worker/README.md).

## Security notes

- The page holds no token. It can only post a report to one endpoint.
- The endpoint's token is fine-grained: Contents and Issues on this repository
  and nothing else. Attachments only ever land under `reports/<date>-<id>/` on
  a branch of their own, never in the code history.
- **The issues are public, so the attachments are too.** The form says so above
  the attachment list. Ask reporters to remove secrets, credentials, private
  paths and proprietary models before attaching anything.
- A contact address is written into the issue as `name [at] example [dot] com`:
  a plain address in a public issue is harvested within the day.
- Everything the reporter typed goes into the issue inside a fenced block, with
  any fence of its own defused. Their text is shown as text, never as markup
  that could rewrite the report around it.
- A filename from a stranger becomes a path in a git repository, so the worker
  rebuilds it from `[A-Za-z0-9._-]` with an extension from the allow list.
- CORS is not the lock: anyone can reach the endpoint with curl. What bounds
  the damage is the size and type limits, the optional per-IP rate limit, and
  how little the token can do.
- For confidential reports, use a private channel: a private repository issue
  or a direct message. Screenshots in an issue of a private repository do not
  render inline, because GitHub's image proxy cannot read them.

## Tests

| | |
| --- | --- |
| `npm run test:feedback-transport` | the request the page builds, every limit, every failure kind, the shrinking |
| `npm run test:feedback-worker` | the whole endpoint against a stubbed GitHub: limits, sanitising, issue text, rate limit |
| `npm run test:feedback-form` | the form's one button, the paste wiring, the translations |
| `npm run test:feedback-attachments` | a dropped file is visibly received and does not reach the data loader |
| `npm run test:feedback-screenshots` | the download fallback, for when a send fails |
| `npm run e2e:feedback-send` | in a real browser: Ctrl+V with the caret in a text field, then Send |
