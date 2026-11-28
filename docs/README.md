# Documentation

## For users

- **User manual**: <https://www.unditas.com/manual/>, in English, French,
  Spanish, Italian and Chinese. It is the in-app Help (Menu → Help) as a web
  page, built from the same texts by `scripts/manual/render-manual.mjs`;
  `npm run manual:pdf` prints it, and `npm run manual:figures` captures its
  figures again.
- **Animated guide**: Menu → Animated guide plays short scripted demos inside
  the app; see [animated-guide.md](animated-guide.md).
- **Release notes**: one file per version in [releases/](releases/).
- [file-formats.md](file-formats.md): what the audio, Micro-Cap, netCDF and
  GRIB readers accept, and the map view of gridded data.
- [large-files.md](large-files.md): opening files of 500 MB and more.
- [csv-loading.md](csv-loading.md) and
  [csv-robust-parsing.md](csv-robust-parsing.md): how a CSV is read, and what
  the parsing preview can change.
- [era5-argentina-example.md](era5-argentina-example.md): the bundled ERA5
  example and how it was produced.
- [feedback.md](feedback.md): what the Feedback command sends, and where.

## For developers and maintainers

- [architecture.md](architecture.md): how the app is put together. Start here.
- [validation.md](validation.md): how the numerical results are verified,
  with the comparison against NumPy and SciPy.
- [../CONTRIBUTING.md](../CONTRIBUTING.md): where to change things, and the
  checks to run.
- [desktop-release.md](desktop-release.md): the release procedure for the
  Full Desktop edition.
- [desktop-security.md](desktop-security.md) and
  [security-audit-followups.md](security-audit-followups.md): the security
  boundary of the Desktop edition, and the audit items that were deliberately
  left as they are, each with its reason.
- [pro-roadmap.md](pro-roadmap.md): the restructuring record and the roadmap
  items still open.

## Design notes

Working notes written while a feature was designed, measured or reviewed. They
are kept as the record of why the code is the way it is, and the source refers
to them. They are not maintained as manuals: a note may describe a plan that
was later changed, and several are written in Spanish, the author's working
language. Where a note and the code disagree, the code is right.

Files of any size (memory-saving mode):

- [any-size-files.md](any-size-files.md) (es): what works on a file that does
  not fit in memory, and the limits that remain.
- [file-size-limits.md](file-size-limits.md) (es): study of the size limits.
- [lazy-phase-design.md](lazy-phase-design.md): phase plots on such files.
- [netcdf-gridded-subsampling.md](netcdf-gridded-subsampling.md): partial load
  of gridded netCDF.

Performance:

- [analysis-responsiveness.md](analysis-responsiveness.md): how long each
  analysis holds the page, and the check that bounds it.
- [optimization-blueprint.md](optimization-blueprint.md) and
  [perf-optimization-results.md](perf-optimization-results.md): the
  optimization plan and its measured results.

Reading files:

- [csv-parsing-backend-parity.md](csv-parsing-backend-parity.md) (es): the two
  CSV readers and how they are kept in agreement.
- [spec-text-labels-and-column-types.md](spec-text-labels-and-column-types.md)
  (es): text columns and per-column types.
- [time-axis-unification-design.md](time-axis-unification-design.md): one model
  for every kind of time axis.
- [netcdf-gridded-viewer-spec.md](netcdf-gridded-viewer-spec.md) (es): the map
  view for gridded netCDF and GRIB.

Plots, analyses and data tools:

- [integral-analysis-requirements.md](integral-analysis-requirements.md) (es)
- [calendar-period-aggregation.md](calendar-period-aggregation.md) (es)
- [state-band-design.md](state-band-design.md) (es)
- [data-tool-sampling.md](data-tool-sampling.md)
- [data-tool-ui-redesign.md](data-tool-ui-redesign.md)
- [marks-menu-nan-gaps-design.md](marks-menu-nan-gaps-design.md)
- [repeated-timestamps-indicator-design.md](repeated-timestamps-indicator-design.md)
- [sample-markers-design.md](sample-markers-design.md)
- [hover-readout.md](hover-readout.md) (es) and
  [number-format.md](number-format.md) (es)
- [audio-playback-design.md](audio-playback-design.md)

Phone layout:

- [phone-web-specification.md](phone-web-specification.md)
- [mobile-mini-viewer-design.md](mobile-mini-viewer-design.md) (superseded by
  the specification above)
