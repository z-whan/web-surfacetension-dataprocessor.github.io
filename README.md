# Surface Tension Analysis Tool

A static, browser-local tool for surface-tension time series, CMC/CAC review,
segmented CMC fitting, curve comparison, and publication-ready Plotly exports.

The project intentionally stays simple: plain HTML, CSS, JavaScript, Plotly,
and Python running in the browser through Pyodide. There is no backend service,
no frontend build system, and no server-side storage of user data.

## Quick Start

Use the hosted app, or serve the repository locally:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080/
```

The browser downloads Plotly, Pyodide, and Python packages configured in
`assets/js/config.js`. After the runtime says `Ready`, analysis runs locally in
the browser. Selected data files are staged inside the Pyodide filesystem for
the current session and are not uploaded to a project backend.

## What You Can Do

- Plot FAMAS-style or generic surface-tension time series.
- Inspect data quality, extract trends, and quantify noise.
- Mark selected curves and compare them on one plot.
- Review CMC droplets before fitting: per-droplet plateau, noise, drift,
  evaporation, flags, and manual Used overrides.
- Fit concentration-level CMC/CAC transitions with pure numpy/pandas models.
- Export PNG, SVG, JSON provenance, or send a plot to the Publication Plot tab.
- Switch raw surface-tension traces between point-to-point lines and a scientific
  centered-moving-average style with sparse local ±1 SD error bars. The switch is
  available in Time Series, Compare, and Publication Plot; volume and derived traces
  are left unchanged.
- Style plots for papers, posters, and presentations without changing the
  source analysis data.

## Using The App

### Time Series

Use this tab for one source file at a time.

1. Choose a CSV/XLSX/XLS file.
2. Select rows and experiment columns if needed.
3. Click `Plot Time Series`.
4. Optional tools:
   - `Avg only` plots the average column when available.
   - `Show evaporation reference` overlays droplet volume when FAMAS volume
     data can be detected.
   - `Data Quality` reports missing values, irregular time, duplicate time,
     extreme outliers, and near-constant signals.
   - `Trend Extraction` supports moving average, median filter, and
     Savitzky-Golay smoothing.
   - `Noise Analysis` supports residual SD, adjacent differences, rolling SD,
     Allan deviation, and PSD.
5. Use `Mark for Compare` to send visible curves to the Compare tab.

The Time Series `Help` button explains each trend and noise method in the UI.

### CMC Analysis

Use this tab for concentration series made of multiple files.

1. Click `Add Files` one or more times. New selections append; `Clear Files`
   is the explicit reset.
2. Enter or verify each concentration in the Files table. Click the
   `Concentration` header to sort.
3. Choose `Sample Type`. `single` reports CMC; `mixture`, `WSOM`, and
   `unknown` use apparent CMC/CAC or transition concentration wording.
4. Choose equilibrium settings:
   - `auto plateau` searches stable windows per droplet and is the default.
   - `manual window` uses the same Time Min/Time Max for every droplet.
5. Click `Review Droplet QC`. This reads files, extracts droplets, computes
   plateau QC, and caches the expensive result.
6. Inspect Droplet QC Review:
   - `DRIFT`, `NOISE`, `EVAP`, `OUTLIER`, `NO_PLATEAU`, and `NO_DATA` are
     excluded by default.
   - `NO_VOLUME` and `LOW_N` are warning-only.
   - Use the `Used` checkbox to manually include or exclude a droplet. Flags
     remain visible and JSON export records the override.
7. Click `Plot / Fit CMC`. Plotting uses cached QC. Log scale, fit model,
   sample type, concentration edits, and Used changes rebuild the plot without
   rereading files or recomputing auto plateau.

CMC fit models:

- `surface tension CMC` is the default. It fits a pre-CMC decreasing line and a
  high-concentration plateau on log10(C); the transition is their intersection.
  Low-concentration baseline points may be excluded with diagnostics.
- `trend breakpoint` is a continuous segmented regression diagnostic. It is not
  recommended as the main surface-tension CMC model because it may find onset.
- `flat plateau` fits a left linear segment and a right constant plateau.
- `none` skips fitting and keeps concentration-level points only.

Performance presets:

- `Fast`: plateau stride 10000 ms, bootstrap 0, fit curve up to 150 points.
- `Standard`: plateau stride 5000 ms, bootstrap 100, fit curve up to 250 points.
- `Full`: plateau stride 1000 ms, bootstrap 300, fit curve up to 400 points.

The CMC `Help` button gives the same information in the app, including QC flag
definitions and export provenance.

### Compare

Use Compare for curves sent from Time Series. It stores marked curves in browser
memory for the current session.

- Select curves, edit their display labels, and plot them together.
- Adjust Y span or manual Y limits.
- Export PNG/SVG or send the plot to Publication Plot.
- Duplicate marked curves are skipped by a stable data key.

### Publication Plot

Use this tab after sending a plot from Time Series, Compare, or CMC.

- Choose figure size presets such as single column, double column,
  presentation, square, or wide.
- Apply style templates such as clean, dense, large font, or minimal.
- Edit titles, axis labels, legend placement, font sizes, trace styles, and
  export size.
- Export PNG/SVG.

Publication styling works on a copied Plotly figure. It does not alter the
upstream analysis payload.

### Session Export

Session JSON restores supported Time Series, Compare, and Publication Plot
state. Local source files themselves are not embedded; select them again when
needed. CMC has its own `Export CMC JSON` for review, fit, droplet QC,
overrides, metadata, and options.

## Supported Data

- CSV with common delimiters and encodings.
- FAMAS multi-experiment CSV with `[WORKSHEET]` metadata and two-row headers.
- XLSX via optional `openpyxl`.
- XLS via optional `xlrd`.

FAMAS CMC handling detects actual valid `I.T.(mN/m).n` droplet columns instead
of treating empty reserved experiment slots or `Avg` as droplets. Metadata such
as analysis method, measurement interval, count, target volume, repeat counts,
and d(g/cm^3) are surfaced when available.

## Repository Structure

```text
.
├─ index.html                  # Static app shell and tab markup
├─ assets/
│  ├─ css/main.css             # Shared app styling
│  ├─ icons/                   # PWA/app icons
│  └─ js/
│     ├─ app.js                # Tab wiring, runtime status, CMC workflow
│     ├─ charts.js             # Plotly rendering and export helpers
│     ├─ cmc-workflow.js       # Pure JS CMC state helpers
│     ├─ compare-module.js     # Compare tab controller
│     ├─ config.js             # Pyodide/package/runtime config
│     ├─ dom-utils.js          # Small DOM creation helpers
│     ├─ downloads.js          # Browser download helpers
│     ├─ publication-plot.js   # Publication Plot controller
│     ├─ pyodide-client.js     # Pyodide bootstrap and bridge calls
│     ├─ session-manager.js    # Session JSON sanitization
│     ├─ time-series-module.js # Time Series tab controller
│     └─ python-sources.js     # Generated from py/, do not edit manually
├─ py/
│  ├─ web_bridge.py            # Browser-callable Python API
│  └─ DataProcessor/
│     ├─ services/
│     │  ├─ cmc_analysis.py        # Droplets, QC, aggregation, CMC fitting
│     │  ├─ dataframe_loader.py    # CSV/XLS loading and FAMAS parsing
│     │  ├─ plot_analysis.py       # Time-series column/range preparation
│     │  ├─ time_series_analysis.py# Quality, trend, and noise analysis
│     │  ├─ csv_to_xlsx.py         # Conversion helper
│     │  └─ errors.py              # DataProcessingError
│     └─ utils/encoding.py         # Encoding detection helper
├─ tools/build_python_sources.py   # Regenerates browser Python source mirror
├─ tests/                          # Python and Node unit tests
├─ docs/architecture.md            # Deeper architecture notes
└─ site.webmanifest
```

## Architecture Notes

`index.html` loads scripts with `defer` in dependency order. Browser modules
attach namespaced objects to `window` rather than using a bundler.

Main JavaScript namespaces:

- `SurfaceLabConfig`: runtime URLs and package lists.
- `SurfaceLabDomUtils`: safe DOM helper functions.
- `SurfaceLabCharts`: Plotly trace/layout/export helpers.
- `SurfaceLabPyodide`: runtime initialization, file staging, Python calls.
- `SurfaceLabTimeSeriesModule`: Time Series controller factory.
- `SurfaceLabCompareModule`: Compare controller factory.
- `SurfaceLabPublicationPlot`: Publication Plot controller factory.
- `SurfaceLabCmcWorkflow`: pure CMC helpers for file identity, cache keys,
  Used overrides, sorting, and flag labels.

Python business logic lives under `py/DataProcessor/services/`. `py/web_bridge.py`
is the boundary layer: JavaScript calls bridge functions, and the bridge delegates
to service modules. Keep heavy analysis in services, not in frontend code.

CMC uses a two-stage pipeline:

1. `review_cmc_files` reads files, parses metadata, extracts droplets, computes
   plateau QC, flags droplets, and returns a review payload.
2. `build_cmc_plot_payload_from_review_json` takes cached review JSON plus plot
   options, applies Used overrides, aggregates by concentration, and fits/plots
   without rereading files or recomputing plateau QC.

## Python Source Mirror

`py/` is the source of truth. The browser loads generated source text from
`assets/js/python-sources.js`, so regenerate it after any Python edit:

```bash
python3 tools/build_python_sources.py
```

Check that the generated file is current:

```bash
python3 tools/build_python_sources.py --check
```

Do not hand-edit `assets/js/python-sources.js`.

## Tests

Use a Python environment with `numpy` and `pandas` installed:

```bash
python3 -m unittest discover -s tests
```

Run JavaScript unit tests:

```bash
node tests/test_session_manager.js
node tests/test_dom_utils.js
node tests/test_charts.js
node tests/test_cmc_workflow.js
```

Check JavaScript syntax:

```bash
for f in assets/js/*.js; do node --check "$f" || exit 1; done
```

Check the Python source mirror:

```bash
python3 tools/build_python_sources.py --check
```

Manual smoke check:

1. Serve the repo with `python3 -m http.server 8080`.
2. Open `http://localhost:8080/`.
3. Confirm runtime boot reaches `Ready`.
4. Open each tab and verify basic controls render.
5. For CMC, confirm `Help`, `Review Droplet QC`, `Plot / Fit CMC`, and the
   Droplet QC Review area are visible.

## Deployment

Deploy the repository as static files. GitHub Pages, Netlify, Cloudflare Pages,
or any static host can serve it directly. Required files include `index.html`,
`assets/`, `site.webmanifest`, and generated `assets/js/python-sources.js`.

## Development Guidelines

- Keep the project plain JavaScript. Do not add a frontend framework or bundler
  without changing the deployment model.
- Keep Python analysis code in `py/`; regenerate `assets/js/python-sources.js`
  after Python changes.
- Prefer small DOM helper functions over `innerHTML` for user-controlled text.
- Preserve local-only processing: do not introduce a backend upload path.
- Treat CMC review as the expensive cached step; plot-only changes should not
  reread files or rerun auto plateau.
- Keep generated, user, or experimental data files out of commits unless they
  are small fixtures intentionally added under `tests/`.

## Known Constraints

- Pyodide cold start can take time because Python packages load in the browser.
- CDN or runtime package availability affects first load.
- Very large files can make Pyodide memory and Plotly rendering slower.
- Session export does not embed original local files.
- CMC fitting is currently segmented/numpy-based; heavy scipy/Bayesian models
  are intentionally out of scope for browser startup performance.
