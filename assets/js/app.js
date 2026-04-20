(function () {
  const config = window.SurfaceLabConfig;
  const charts = window.SurfaceLabCharts;
  const downloads = window.SurfaceLabDownloads;
  const pyodideClient = window.SurfaceLabPyodide;

  const state = {
    runtimeReady: false,
    plot: {
      file: null,
      payload: null,
    },
    convert: {
      file: null,
    },
    cmc: {
      rows: [],
      payload: null,
    },
  };

  const dom = {
    statusText: document.querySelector("[data-status-text]"),
    runtimeTag: document.querySelector("[data-runtime-tag]"),
    errorBox: document.querySelector("[data-error-box]"),
    errorText: document.querySelector("[data-error-text]"),
    actionButtons: Array.from(document.querySelectorAll("[data-requires-runtime='true']")),
    runtimeRetry: document.querySelector("#runtime-retry"),
    tabButtons: Array.from(document.querySelectorAll("[data-tab-button]")),
    panels: Array.from(document.querySelectorAll("[data-tab-panel]")),

    convertInput: document.querySelector("#convert-file"),
    convertMeta: document.querySelector("[data-convert-meta]"),
    convertButton: document.querySelector("#convert-run"),

    plotInput: document.querySelector("#plot-file"),
    plotMeta: document.querySelector("[data-plot-meta]"),
    plotStart: document.querySelector("#plot-start"),
    plotEnd: document.querySelector("#plot-end"),
    plotExpRange: document.querySelector("#plot-exp-range"),
    plotAvgOnly: document.querySelector("#plot-avg-only"),
    plotAnalyze: document.querySelector("#plot-run"),
    plotExport: document.querySelector("#plot-export"),
    plotSummary: document.querySelector("[data-plot-summary]"),
    plotCanvas: document.querySelector("#plot-canvas"),

    cmcInput: document.querySelector("#cmc-files"),
    cmcTableBody: document.querySelector("[data-cmc-table-body]"),
    cmcTimeMin: document.querySelector("#cmc-time-min"),
    cmcTimeMax: document.querySelector("#cmc-time-max"),
    cmcUnit: document.querySelector("#cmc-unit"),
    cmcUseLog: document.querySelector("#cmc-use-log"),
    cmcAnalyze: document.querySelector("#cmc-run"),
    cmcExport: document.querySelector("#cmc-export"),
    cmcSummary: document.querySelector("[data-cmc-summary]"),
    cmcCanvas: document.querySelector("#cmc-canvas"),
    cmcEmpty: document.querySelector("[data-cmc-empty]"),
  };

  function setStatus(message) {
    dom.statusText.textContent = message;
  }

  function setRuntimeReady(ready) {
    state.runtimeReady = ready;
    dom.runtimeTag.textContent = ready ? "Ready" : "Booting";
    dom.runtimeTag.dataset.ready = String(ready);
    dom.actionButtons.forEach((button) => {
      button.dataset.runtimeReady = String(ready);
      button.title = ready
        ? ""
        : "Python runtime is still loading or failed to initialize.";
    });
  }

  function showError(message) {
    dom.errorText.textContent = message;
    dom.errorBox.hidden = false;
  }

  function clearError() {
    dom.errorText.textContent = "";
    dom.errorBox.hidden = true;
  }

  function activateTab(tabName) {
    dom.tabButtons.forEach((button) => {
      button.dataset.active = String(button.dataset.tabButton === tabName);
    });

    dom.panels.forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== tabName;
    });
  }

  function describeFile(file) {
    if (!file) {
      return "No file selected yet.";
    }
    return (
      file.name +
      " · " +
      (file.size / 1024).toFixed(1) +
      " KB · ready for local browser processing"
    );
  }

  function inferConcentrationFromFilename(filename) {
    const lowered = filename.toLowerCase();
    if (["water", "h2o", "blank", "ultrapure"].some((keyword) => lowered.includes(keyword))) {
      return "0";
    }

    const match = filename.match(/(\d+(?:\.\d+)?)(?:\s*(mM|mm|M|uM|µM))?/i);
    return match ? match[1] : "";
  }

  function renderPlotSummary(payload) {
    dom.plotSummary.innerHTML = payload
      ? `
        <div class="metric-card"><span>Rows</span><strong>${payload.summary.rows}</strong></div>
        <div class="metric-card"><span>Series</span><strong>${payload.summary.seriesCount}</strong></div>
        <div class="metric-card"><span>Row Range</span><strong>${payload.rowRange.join(" - ")}</strong></div>
        <div class="metric-card"><span>Exp Tag</span><strong>${payload.expTag}</strong></div>
      `
      : "";
  }

  function renderCmcSummary(payload) {
    if (!payload) {
      dom.cmcSummary.innerHTML = "";
      return;
    }

    const start = payload.summary.timeWindow[0];
    const end = payload.summary.timeWindow[1];
    dom.cmcSummary.innerHTML = `
      <div class="metric-card"><span>Files</span><strong>${payload.summary.fileCount}</strong></div>
      <div class="metric-card"><span>Window</span><strong>${start} - ${end} ms</strong></div>
      <div class="metric-card"><span>X Axis</span><strong>${payload.xLabel}</strong></div>
    `;
  }

  function renderCmcTable() {
    dom.cmcEmpty.hidden = state.cmc.rows.length > 0;
    dom.cmcTableBody.innerHTML = "";

    state.cmc.rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${String(index + 1).padStart(2, "0")}</td>
        <td>
          <div class="table-file">${row.filename}</div>
          <div class="table-subtle">${(row.size / 1024).toFixed(1)} KB</div>
        </td>
        <td>
          <input
            class="table-input"
            type="text"
            value="${row.concentration}"
            data-cmc-concentration-index="${index}"
            placeholder="e.g. 1.0"
          />
        </td>
        <td>
          <button class="ghost-button" type="button" data-cmc-remove-index="${index}">
            Remove
          </button>
        </td>
      `;
      dom.cmcTableBody.appendChild(tr);
    });
  }

  function handleConvertSelection() {
    clearError();
    const file = dom.convertInput.files[0];
    state.convert.file = file || null;
    dom.convertMeta.textContent = describeFile(state.convert.file);
  }

  function handlePlotSelection() {
    clearError();
    const file = dom.plotInput.files[0];
    state.plot.file = file || null;
    state.plot.payload = null;
    dom.plotExport.disabled = true;
    renderPlotSummary(null);
    dom.plotMeta.textContent = describeFile(state.plot.file);
  }

  function handleCmcSelection() {
    clearError();
    const files = Array.from(dom.cmcInput.files || []);
    state.cmc.rows = files.map((file) => ({
      file,
      filename: file.name,
      size: file.size,
      concentration: inferConcentrationFromFilename(file.name),
    }));
    state.cmc.payload = null;
    dom.cmcExport.disabled = true;
    renderCmcTable();
    renderCmcSummary(null);
  }

  async function runConvert() {
    if (!state.convert.file) {
      throw new Error("Please choose a CSV file first.");
    }

    const staged = await pyodideClient.stageBrowserFile(state.convert.file, "convert");
    try {
      const result = await pyodideClient.callBridge("convert_csv_to_xlsx_in_fs", staged.fsPath);
      const bytes = pyodideClient.readBinaryFile(result.outputPath);
      downloads.downloadBytes(
        result.downloadName,
        bytes,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      pyodideClient.removeFsFile(result.outputPath);
      setStatus("Converted " + state.convert.file.name + " locally in your browser.");
    } finally {
      pyodideClient.removeFsFile(staged.fsPath);
    }
  }

  async function runPlot() {
    if (!state.plot.file) {
      throw new Error("Please choose a data file first.");
    }

    const staged = await pyodideClient.stageBrowserFile(state.plot.file, "plot");
    try {
      const payload = await pyodideClient.callBridge(
        "analyze_plot_file",
        staged.fsPath,
        dom.plotStart.value,
        dom.plotEnd.value,
        dom.plotExpRange.value,
        dom.plotAvgOnly.checked
      );
      state.plot.payload = payload;

      if (!dom.plotExpRange.value && payload.defaultExpRange) {
        dom.plotExpRange.value = payload.defaultExpRange;
      }

      await charts.renderTimeSeriesPlot(dom.plotCanvas, payload);
      renderPlotSummary(payload);
      dom.plotExport.disabled = false;
      setStatus(
        "Rendered " + payload.summary.seriesCount + " series from " + state.plot.file.name + "."
      );
    } finally {
      pyodideClient.removeFsFile(staged.fsPath);
    }
  }

  async function runCmc() {
    if (!state.cmc.rows.length) {
      throw new Error("Please choose at least one file for CMC analysis.");
    }

    const stagedRows = [];
    const entries = [];

    try {
      for (const row of state.cmc.rows) {
        const staged = await pyodideClient.stageBrowserFile(row.file, "cmc");
        stagedRows.push(staged);
        entries.push({
          path: staged.fsPath,
          filename: row.filename,
          concentration: row.concentration,
        });
      }

      const payload = await pyodideClient.callBridge(
        "analyze_cmc_files",
        entries,
        dom.cmcTimeMin.value,
        dom.cmcTimeMax.value,
        dom.cmcUnit.value,
        dom.cmcUseLog.checked
      );

      state.cmc.payload = payload;
      await charts.renderCmcPlot(dom.cmcCanvas, payload);
      renderCmcSummary(payload);
      dom.cmcExport.disabled = false;
      setStatus("Computed CMC stats for " + payload.summary.fileCount + " files locally.");
    } finally {
      stagedRows.forEach((staged) => {
        pyodideClient.removeFsFile(staged.fsPath);
      });
    }
  }

  function withUiLock(handler) {
    return async () => {
      if (!state.runtimeReady) {
        showError(
          location.protocol === "file:"
            ? "Python runtime is not ready yet. You are opening this app from file://. In-app browsers sometimes block CDN-loaded runtime files, so wait for Runtime to become Ready or use a local static server like http://localhost:8080/web-static-pyodide/."
            : "Python runtime is still loading or failed to initialize. Please wait for Runtime to become Ready, or click Retry Runtime."
        );
        return;
      }

      try {
        clearError();
        await handler();
      } catch (error) {
        showError(error && error.message ? error.message : String(error));
      }
    };
  }

  async function retryRuntime() {
    clearError();
    setRuntimeReady(false);
    setStatus("Retrying browser-local Python runtime...");

    try {
      const metadata = await pyodideClient.initRuntime(setStatus, true);
      setRuntimeReady(true);
      setStatus("Ready. Files stay inside your browser for analysis and download.");
      dom.runtimeTag.title = metadata.pythonBackedFeatures.join(" • ");
    } catch (error) {
      setRuntimeReady(false);
      showError(error && error.message ? error.message : String(error));
      setStatus("Runtime failed to initialize.");
    }
  }

  function bindTabs() {
    dom.tabButtons.forEach((button) => {
      button.addEventListener("click", () => activateTab(button.dataset.tabButton));
    });
  }

  function bindCmcTableEditing() {
    dom.cmcTableBody.addEventListener("input", (event) => {
      const input = event.target.closest("[data-cmc-concentration-index]");
      if (!input) {
        return;
      }
      const index = Number(input.dataset.cmcConcentrationIndex);
      if (Number.isInteger(index) && state.cmc.rows[index]) {
        state.cmc.rows[index].concentration = input.value.trim();
      }
    });

    dom.cmcTableBody.addEventListener("click", (event) => {
      const button = event.target.closest("[data-cmc-remove-index]");
      if (!button) {
        return;
      }
      const index = Number(button.dataset.cmcRemoveIndex);
      if (!Number.isInteger(index)) {
        return;
      }
      state.cmc.rows.splice(index, 1);
      state.cmc.payload = null;
      dom.cmcExport.disabled = true;
      renderCmcTable();
      renderCmcSummary(null);
    });
  }

  function bindActions() {
    dom.convertInput.accept = ".csv";
    dom.plotInput.accept = config.ACCEPTED_DATA_EXTENSIONS;
    dom.cmcInput.accept = config.ACCEPTED_DATA_EXTENSIONS;

    dom.convertInput.addEventListener("change", handleConvertSelection);
    dom.plotInput.addEventListener("change", handlePlotSelection);
    dom.cmcInput.addEventListener("change", handleCmcSelection);

    dom.convertButton.addEventListener("click", withUiLock(runConvert));
    dom.plotAnalyze.addEventListener("click", withUiLock(runPlot));
    dom.cmcAnalyze.addEventListener("click", withUiLock(runCmc));
    dom.runtimeRetry.addEventListener("click", () => {
      retryRuntime();
    });

    dom.plotExport.addEventListener("click", async () => {
      if (state.plot.payload) {
        await charts.exportPlotAsPng(dom.plotCanvas, "plot-" + state.plot.payload.expTag);
      }
    });

    dom.cmcExport.addEventListener("click", async () => {
      if (state.cmc.payload) {
        await charts.exportPlotAsPng(dom.cmcCanvas, "cmc-curve");
      }
    });
  }

  async function boot() {
    bindTabs();
    bindActions();
    bindCmcTableEditing();
    activateTab("convert");
    setRuntimeReady(false);

    if (location.protocol === "file:") {
      setStatus("Local file mode detected. This build now avoids module imports, but CDN access is still required for Pyodide and Plotly.");
    } else {
      setStatus("Preparing browser-local Python runtime...");
    }

    await retryRuntime();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
