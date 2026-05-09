# Professionalization Roadmap

## Done in this step

- Full snapshot saved in `backup/before_new_structure`
- App migrated to ES modules
- New `src/` structure created
- Architecture notes added for faster onboarding and agent navigation
- `app.js` split into:
  - `src/app/viewer-app.js`
  - `src/app/methods/file-methods.js`
  - `src/app/methods/ui-methods.js`
  - `src/app/methods/derived-methods.js`
  - `src/app/methods/tree-methods.js`
- `plot-manager.js` split into:
  - `src/plots/plot-manager.js`
  - `src/plots/methods/data-methods.js`
  - `src/plots/methods/state-methods.js`
  - `src/plots/methods/interaction-methods.js`
- `i18n` moved under `src/i18n`
- CSS split under `src/styles`
- Legacy root files turned into thin entrypoints/facades

## Next recommended phases

1. Add a real build/dev toolchain
   - `package.json`
   - `vite`
   - `eslint`
   - `prettier`

2. Centralize state
   - file registry
   - UI preferences
   - active layout/panel state
   - derived variable definitions

3. Extract pure domain logic
   - formula parser/evaluator
   - transforms
   - downsampling
   - stats
   - trace-building helpers

4. Add automated tests
   - parsers
   - derived variables
   - transforms
   - downsampling
   - state animation math

5. Improve UX polish
   - notifications instead of `alert()`
   - keyboard shortcuts
   - persistent settings
   - better loading/error states

6. Improve maintainability further
   - per-feature folders
   - shared DOM helpers
   - constants/theme tokens
   - typed JSDoc or TypeScript migration
