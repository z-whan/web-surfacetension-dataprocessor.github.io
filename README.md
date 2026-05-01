# Surface Tension Analysis Tool

A static browser app for surface-tension plotting and local analysis. The
frontend is plain HTML/CSS/JavaScript, and the Python analysis layer runs in the
browser through Pyodide.

## Key Points

- Static app: `index.html` plus files under `assets/`.
- Python source: `py/`, mirrored into the browser runtime at load time.
- Processing model: user data is processed locally in the browser; there is no
  project backend or server-side storage.
- Runtime resources: the browser may still fetch configured assets such as
  Plotly, Pyodide, and Python packages from URLs/CDNs.

## Features

- Time-series plotting, data quality diagnostics, trend extraction, and noise analysis.
- Compare workflows for marked curves.
- Session export/import for reproducible settings and figure styling.
- CMC batch analysis.
- Publication Plot polishing with presets, style templates, and PNG/SVG export.

## Structure

```text
.
├─ index.html
├─ assets/
│  ├─ css/main.css
│  └─ js/
├─ py/
│  ├─ web_bridge.py
│  └─ DataProcessor/
├─ tools/
└─ tests/
```

## Local Development

Use any static file server from the repository root:

```bash
python3 -m http.server 8080
```

Open:

```text
http://localhost:8080/
```

Normal use does not require a frontend build step. After changing Python files,
regenerate the Python source mirror as described below.

## Tests

Run the Python tests with a Python environment that has the project test
dependencies installed, including `numpy` and `pandas`:

```bash
python3 -m unittest discover -s tests
```

Run the lightweight JavaScript tests:

```bash
node tests/test_session_manager.js
node tests/test_dom_utils.js
```

Optional JavaScript syntax check:

```bash
for f in assets/js/*.js; do node --check "$f" || exit 1; done
```

Manual browser smoke check:

1. Start `python3 -m http.server 8080`.
2. Open `http://localhost:8080/`.
3. Verify the Time Series, Compare, and Publication Plot tabs are visible.
4. Verify the runtime boot/status UI appears.

## Python Source Mirror

The `py/` directory is the source of truth for Python code loaded by Pyodide.
The browser bundle at `assets/js/python-sources.js` is generated from that
source tree and should not be edited manually.

Regenerate the bundle after changing Python files:

```bash
python3 tools/build_python_sources.py
```

Check whether the committed bundle is current:

```bash
python3 tools/build_python_sources.py --check
```

## Static Deployment

Deploy the repository contents as static files. GitHub Pages, Netlify,
Cloudflare Pages, and similar static hosts can serve the app directly as long
as `index.html`, `assets/`, and the generated Python source mirror are present.

## Notes

- CSV, XLSX, and XLS are supported where the browser runtime has the required
  Python packages available.
- Optional Excel packages are loaded only when needed.
- See `docs/architecture.md` for module boundaries, test strategy, and known
  deferred items.
