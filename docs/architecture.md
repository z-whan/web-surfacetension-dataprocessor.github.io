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

Python tests live under `tests/`. They cover the web bridge behavior and the
Python source bundle generator. There is currently no JavaScript test framework;
frontend validation is done by static syntax checks and browser smoke tests.

## Known Constraints

- Processing is local to the browser runtime; selected files are not uploaded to
  a project backend.
- CDN/runtime resources such as Plotly, Pyodide, and Python packages may still
  be fetched by the browser.
- The app intentionally stays plain JavaScript loaded by `index.html`; do not
  add a bundler, framework, or TypeScript build step without changing the
  deployment model.
- Deferred issue: CMC rendering in `assets/js/app.js` still uses `innerHTML` for
  CMC-specific summary and table markup, including displayed filenames. That
  behavior is left unchanged until a dedicated CMC refactor.
