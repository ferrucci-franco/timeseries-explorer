# Feedback Collection

The Feedback menu item uses GitHub Issues as the primary support channel.

This is safer than sending files directly to a personal Gmail address from a
static HTML app because the frontend does not need secrets, SMTP credentials, or
a file-upload backend. GitHub also keeps the report, discussion, labels, and
fix history next to the code.

The browser form collects:

- a short summary
- optional reporter contact email
- category
- reproduction details
- expected behavior or extra context
- screenshots pasted from the clipboard
- optional attached files

When the user submits, the app creates a local zip package containing
`feedback.json`, `feedback.txt`, and any selected attachments. It then opens a
prefilled GitHub Issue in the browser. GitHub cannot receive URL-prefilled file
attachments, so the user must attach the downloaded zip manually when it is safe
to share.

Security notes:

- No attachment is uploaded automatically.
- Keep the package below normal email/browser limits; the app warns above 25 MB.
- Ask users to remove secrets, credentials, private paths, proprietary models,
  or sensitive data before attaching files to a public issue.
- For confidential reports, use a private repository issue, a private file share,
  or a small backend that performs authentication, virus scanning, file-size
  checks, and retention cleanup.
