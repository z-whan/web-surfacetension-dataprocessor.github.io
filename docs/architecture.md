# Architecture

This app is a static browser application. The deployment artifact is the
repository contents served as static files; there is no backend service and no
JavaScript build step.

## Entry Point

`index.html` is the app entry point. It loads Plotly from a CDN, then loads the
plain JavaScript files in dependency order with `defer`.

Shared browser namespaces are attached to `window`, including:

- `window.SurfaceLabConfig` for runtime and package configuration.
- `window.SurfaceLabDomUtils` for small DOM creation, clearing, text, and select helpers.
- `window.SurfaceLabCharts` for Plotly rendering and export helpers.
- `window.SurfaceLabPyodide` for Python runtime initialization and bridge calls.
- `window.SurfaceLabTimeSeriesModule`, `window.SurfaceLabCompareModule`, and
  `window.SurfaceLabPublicationPlot` for controller factories.

`assets/js/app.js` wires the tabs, global status/error UI, CMC workflow, and the
controller instances together.

## Frontend Controllers

The Time Series, Compare, and Publication Plot tabs each have a controller
module under `assets/js/`. Controllers own their tab state, DOM bindings, and
workflow-specific event handlers.

Shared low-level UI helpers live in `assets/js/dom-utils.js`. Keep this layer
small: it should reduce repetitive DOM code without becoming a framework.

## Chart Rendering

`assets/js/charts.js` is the Plotly rendering layer. It creates the Plotly
traces and layouts for time-series plots, noise/analysis plots, compare plots,
CMC plots, and image export. Controllers pass already-shaped payloads into this
layer.

## CMC Analysis

The CMC tab is wired in `assets/js/app.js` and calls `py/web_bridge.py`
through Pyodide. The Python source under `py/DataProcessor/services/` owns the
analysis pipeline: FAMAS multi-experiment files are adapted into per-droplet
traces, each droplet receives plateau/equilibrium QC, concentration-level
aggregates are computed from accepted droplets, and optional CMC/CAC fits are
returned as Plotly-ready payload data. The default fit model is the
surface-tension CMC model: it fits a pre-CMC decline against a high-concentration
plateau and reports their intersection, while allowing low-concentration
baseline points to be excluded with provenance warnings.

The CMC payload intentionally keeps provenance alongside the plot data:
`rows`, `points`, `files`, droplet QC, source metadata, options, and fit
diagnostics are all preserved so JSON exports can be audited later. When Python
CMC code changes, regenerate `assets/js/python-sources.js` from `py/` before
testing or committing.

The CMC backend also exposes a review-only path through `review_cmc_files`.
It performs FAMAS metadata extraction, valid droplet detection, plateau QC, and
default accept/exclude decisions without concentration transforms or curve
fitting. For FAMAS exports, configured experiment slots are reported separately
from actual valid repeats, and evaporation QC is based on full-droplet volume
loss/rate while plateau-window volume loss remains available for review.
`build_cmc_plot_payload_from_review` then turns the review payload plus
concentrations and plot options into rows, points, σ aliases, and fit overlays
without rereading files or recomputing droplet QC.

The browser workflow mirrors that split. `assets/js/app.js` keeps a cached
`reviewPayload` for expensive file reading and plateau detection, then rebuilds
the lighter `plotPayload` when concentration, log scale, fit model, sample type,
or manual droplet Used overrides change. File identity plus QC options form the
review cache key; plot-only settings must not invalidate droplet review.

## Publication Plot Styling

`assets/js/publication-plot.js` receives copied Plotly figures from analysis
tabs and keeps the imported figure payload separate from the editable
publication copy. Figure presets change presentation layout values such as
width, height, font size, axis line width, tick labels, and legend placement.
Style templates adjust layout polish and trace styling defaults on the copied
figure only; they do not alter source analysis data or the upstream analysis
pipeline.

## Pyodide Bridge

`assets/js/pyodide-client.js` initializes Pyodide, installs configured Python
packages, mirrors bundled Python source files into the Pyodide filesystem, and
imports `py/web_bridge.py`. The public browser API remains
`window.SurfaceLabPyodide`.

## Python Source Mirror

`py/` is the source of truth for Python analysis code. The generated file
`assets/js/python-sources.js` stores those source files for the browser runtime.
Regenerate it with:

```bash
python3 tools/build_python_sources.py
```

Check that it is current with:

```bash
python3 tools/build_python_sources.py --check
```

## Python Services

`py/web_bridge.py` exposes browser-callable functions and delegates business
logic to service modules under `py/DataProcessor/services/`. Service modules
handle dataframe loading, plot analysis, time-series trend/noise analysis, CMC
analysis, and conversion helpers.

## Tests

Tests live under `tests/`.

- Python unit tests cover bridge behavior, time-series quality diagnostics,
  trend/noise service edge cases, and the Python source bundle generator.
- Lightweight Node-based JavaScript tests cover pure browser utilities such as
  session serialization and DOM-safe helper behavior. These tests do not load
  Pyodide or require CDN access.
- Browser validation is intentionally treated as a smoke check: serve the app
  with `python3 -m http.server`, open `index.html`, confirm the main tabs are
  visible, and confirm the runtime boot/status UI appears. Deeper browser tests
  that rely on CDN availability should be marked as integration checks.

Current commands:

```bash
python3 -m unittest discover -s tests
node tests/test_session_manager.js
node tests/test_dom_utils.js
python3 tools/build_python_sources.py --check
```

## Performance Notes

- Pyodide has a cold-start cost because the browser initializes the runtime and
  loads configured Python packages before bridge calls are available.
- `assets/js/python-sources.js` is generated from `py/`; keeping it current
  avoids runtime import drift.
- Plotly rendering cost scales with trace count and point count. Compare and
  Publication Plot state should avoid unnecessary copies of very large arrays.
- Session export/import is JSON-only and local. Large in-memory curves can make
  exported sessions large, so callers should preserve only the data needed to
  restore supported workflows.

## Known Constraints

- Processing is local to the browser runtime; selected files are not uploaded to
  a project backend.
- CDN/runtime resources such as Plotly, Pyodide, and Python packages may still
  be fetched by the browser.
- The app intentionally stays plain JavaScript loaded by `index.html`; do not
  add a bundler, framework, or TypeScript build step without changing the
  deployment model.
- CMC session import/export behavior is not covered by the non-CMC session
  manager.
