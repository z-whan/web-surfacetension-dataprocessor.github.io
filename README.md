# Surface Tension Data Tool

A static web app for local surface-tension plotting and CMC analysis.

## Key Points

- Frontend: HTML, CSS, JavaScript
- Python runtime: Pyodide in the browser
- Processing: local only, no backend upload
- Deployment: GitHub Pages, Netlify, Cloudflare Pages

## Features

- Time-series plotting
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

## Deploy

- GitHub Pages: publish this folder as the site root
- Netlify: set the publish directory to `web-static-pyodide`
- Cloudflare Pages: set the output directory to `web-static-pyodide`

## Notes

- Files stay in the browser runtime
- CSV, XLSX, and XLS are supported
- Optional Excel packages are loaded only when needed
