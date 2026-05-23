# CSV performance rescue notes

Context: this project is starting a CSV loading/performance cleanup after the
backup below.

Current backup:

- `backup/pre-csv-optimization-20260522-224550.zip`

If the CSV optimization work starts to break the app:

1. Check the working tree first:
   `git status --short`
2. Run the normal build to see whether the problem is syntax/bundling:
   `npm run build:web`
3. The first files to inspect or revert are:
   - `src/parsers/csv-parser.js`
   - `src/app/methods/file-methods.js`
   - `src/app/methods/ui-methods.js`
4. If the app is badly tangled, extract the backup zip to a temporary folder
   and compare those files against the current working tree.
5. Avoid reverting unrelated local edits. At the time this note was created,
   `src/plots/plot-manager.js` already had local modifications, so treat it as
   user work unless the task explicitly touches it.

Initial low-risk optimization targets:

- Avoid parsing the entire CSV repeatedly during delimiter detection.
- Avoid large spread calls such as `array.splice(...largeArray)`.
- Reduce repeated UI redraws when loading several files at once.
- Later: move heavy CSV parsing to a Web Worker if main-thread pauses remain.
