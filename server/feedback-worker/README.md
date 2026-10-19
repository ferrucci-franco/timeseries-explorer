# Feedback endpoint

The app's Feedback form has one button: **Send**. This worker is what that
button talks to. It holds a GitHub token the page must never see, commits the
attachments to a branch of this repository, and opens the issue — so the person
reporting the bug needs no GitHub account and no mail client.

Without it the form still opens and still collects everything; the send fails
with "sending is not available in this build" and offers the manual paths
(download the report, open an issue by hand). Nothing else in the app depends
on it.

## What it costs

Nothing. Cloudflare's Workers free plan covers 100,000 requests a day; a
feedback form uses a handful. No credit card is involved, and no paid Cloudflare
plan: the domain being on the Free plan is enough.

The one free-plan limit that shapes the code is **10 ms of CPU per request**.
Waiting for GitHub does not count against it, but parsing megabytes does, which
is why the report arrives as one JSON line followed by one base64 line per
attachment: the worker parses only the short head and hands each attachment to
GitHub untouched (`src/report.js`).

## Deploying it

You need Node and this repository checked out. All of it runs from this
directory.

```sh
cd server/feedback-worker
npx wrangler login          # opens the browser, authorises this machine
```

**1. Make the GitHub token.** On github.com: Settings → Developer settings →
Personal access tokens → **Fine-grained tokens** → Generate new token.

- Repository access: **Only select repositories** → `ferrucci-franco/timeseries-explorer`
- Repository permissions: **Contents: Read and write** (to store attachments)
  and **Issues: Read and write** (to open the issue). Nothing else.
- Set an expiry you will notice — a year is reasonable. When it expires, sends
  start failing with a 502 and you repeat this step.

**2. Give it to the worker as a secret**, never as a var:

```sh
npx wrangler secret put GITHUB_TOKEN
# paste the token at the prompt
```

**3. Deploy:**

```sh
npx wrangler deploy
```

Wrangler prints the URL, `https://timeseries-explorer-feedback.<your-subdomain>.workers.dev`.
Check it answers:

```sh
curl https://timeseries-explorer-feedback.<your-subdomain>.workers.dev
# {"ok":true,"service":"timeseries-explorer-feedback"}
```

**4. Point the app at it.** On github.com, in this repository: Settings →
Secrets and variables → Actions → **Variables** → New repository variable,
named `OMV_FEEDBACK_ENDPOINT`, with the URL from step 3 as its value. The next
Pages deploy builds the form with the Send button wired to it. For a local
build:

```sh
OMV_FEEDBACK_ENDPOINT=https://… npm run build
```

### Optional: your own domain

`unditas.com` is already on this Cloudflare account, so the worker can live at
`feedback.unditas.com` instead of `workers.dev`: Cloudflare dashboard → Compute
→ Workers → this worker → Settings → Domains & Routes → Add → Custom domain.
Then set `OMV_FEEDBACK_ENDPOINT` to the new URL. A `workers.dev` URL works just
as well; a custom domain only survives moving away from Cloudflare.

### Optional: rate limiting

The worker skips rate limiting unless a KV namespace is bound to it:

```sh
npx wrangler kv namespace create FEEDBACK_KV
```

Paste the id it prints into `wrangler.toml`, uncomment the `[[kv_namespaces]]`
block, and deploy again. `MAX_REPORTS_PER_HOUR` (default 10) is then enforced
per IP address. KV on the free plan covers this with room to spare.

## What arrives

A report becomes one issue, labelled `feedback`:

- The title is `[Bug] <summary>`, `[Idea] …` or `[Question] …`.
- Everything the reporter typed is inside a fenced block. They are a stranger
  to this repository, so their text is shown as text, never as markup that
  could rewrite the report around it.
- Screenshots appear inline. They are committed to the `feedback-attachments`
  branch under `reports/<date>-<id>/`, which keeps them out of the code history
  and lets you delete a report's files with one commit.
- The build table carries version, commit, browser, page URL and a reference id.
- A contact address, if the reporter gave one, is written `name [at] example
  [dot] com`. The issue is public and a plain address in one is harvested
  within the day.

## What it refuses

Checked in the worker, not only in the page — anyone can POST here:

| | |
| --- | --- |
| Attachments | at most 10 |
| Each attachment | 4 MB |
| All attachments | 8 MB |
| Summary / details / context | 140 / 8000 / 4000 characters |
| File types | images, text, csv/json/yaml, zip, and this app's data formats |

Anything else is a 4xx carrying both an English `error` sentence and a short
`code` (`too-large`, `rate-limited`, `invalid`, `type-rejected`). The app shows
the refusal in the reporter's own language from the code, and falls back to the
sentence for a code it does not know — so this endpoint can grow new refusals
without the deployed app going mute about them.

## Things worth knowing

- **The issues are public, so the attachments are too.** The form says so
  before anyone attaches a file. If reports need to be private, point
  `GITHUB_REPO` at a private repository — but then screenshots no longer render
  inline in the issue, because GitHub's image proxy cannot read them.
- **CORS is not the lock.** Anyone can reach this worker with curl, whatever
  `ALLOWED_ORIGINS` says. What bounds the damage is the limits above, the rate
  limit, and a token that can only write issues and files in one repository.
  If spam ever does arrive, add a Cloudflare WAF rate-limiting rule on the
  route (free plan includes one) or put Turnstile in front of the form.
- **Watching it:** `npx wrangler tail` streams the logs of the deployed worker,
  including the stack of anything that failed.
- **Changing the code:** the logic that is not a network call lives in
  `src/report.js` and is covered by `npm run test:feedback-worker` from the
  repository root, which runs the whole handler against a stubbed GitHub.
