# Surface Tension Analysis Tool

A static web app for local surface-tension plotting, trend extraction, noise analysis, and CMC analysis.

## Key Points

- Frontend: HTML, CSS, JavaScript
- Python runtime: Pyodide in the browser
- Processing: local only, no backend upload
- Deployment: GitHub Pages, Netlify, Cloudflare Pages

## Features

- Time-series plotting
- Trend extraction:
  - Moving Average / Rolling Mean
  - Median Filter
  - Savitzky-Golay Filter
- Noise analysis:
  - Residual Standard Deviation
  - Adjacent Difference Statistics
  - Rolling Standard Deviation
  - Allan Deviation
  - Power Spectral Density (PSD)
- CMC batch analysis
- Local plot export as PNG

## Structure

```text
web-static-pyodide/
├─ index.html
├─ assets/
│  ├─ css/main.css
│  └─ js/
├─ py/
│  ├─ web_bridge.py
│  └─ DataProcessor/
└─ tests/
```

## Run Locally

Use any static file server:

```bash
python3 -m http.server 8080
```

Open:

```text
http://localhost:8080/web-static-pyodide/
```

## Python Source Bundle

The `py/` directory is the source of truth for the Python code loaded by
Pyodide. The browser bundle at `assets/js/python-sources.js` is generated from
that source tree and should not be edited manually.

Regenerate the bundle after changing Python files:

```bash
python3 tools/build_python_sources.py
```

Check whether the committed bundle is current:

```bash
python3 tools/build_python_sources.py --check
```

## Deploy

- GitHub Pages: publish this folder as the site root
- Netlify: set the publish directory to `web-static-pyodide`
- Cloudflare Pages: set the output directory to `web-static-pyodide`

## Notes

- Files stay in the browser runtime
- CSV, XLSX, and XLS are supported
- Optional Excel packages are loaded only when needed
- The Time Series tab includes built-in help for trend and noise tools
