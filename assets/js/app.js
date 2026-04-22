(function () {
  const config = window.SurfaceLabConfig;
  const charts = window.SurfaceLabCharts;
  const pyodideClient = window.SurfaceLabPyodide;

  const state = {
    runtimeReady: false,
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

  let timeSeriesController = null;

  function setStatus(message) {
    dom.statusText.textContent = message;
  }

  function normalizeUiError(error) {
    return pyodideClient.normalizeError(error);
  }

  function setRuntimeReady(ready) {
    state.runtimeReady = ready;
    dom.runtimeTag.textContent = ready ? "Ready" : "Booting";
    dom.runtimeTag.dataset.ready = String(ready);
    dom.actionButtons.forEach((button) => {
      button.dataset.runtimeReady = String(ready);
      button.title = ready ? "" : "Python runtime is still loading or failed to initialize.";
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

  function inferConcentrationFromFilename(filename) {
    const lowered = filename.toLowerCase();
    if (["water", "h2o", "blank", "ultrapure"].some((keyword) => lowered.includes(keyword))) {
      return "0";
    }

    const match = filename.match(/(\d+(?:\.\d+)?)(?:\s*(mM|mm|M|uM|µM))?/i);
    return match ? match[1] : "";
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
    charts.clearPlot(dom.cmcCanvas);
  }

  async function runCmc() {
    if (!state.cmc.rows.length) {
      throw new Error("Please choose at least one file for CMC analysis.");
    }

    const needsXlsx = state.cmc.rows.some((row) => row.filename.toLowerCase().endsWith(".xlsx"));
    const needsXls = state.cmc.rows.some((row) => row.filename.toLowerCase().endsWith(".xls"));
    if (needsXlsx) {
      setStatus("Preparing XLSX reading support...");
      await pyodideClient.ensureOptionalPackages(config.OPTIONAL_PYTHON_PACKAGES.xlsx);
    }
    if (needsXls) {
      setStatus("Preparing XLS reading support...");
      await pyodideClient.ensureOptionalPackages(config.OPTIONAL_PYTHON_PACKAGES.xls);
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
        showError("Python runtime is not ready yet. Wait for Runtime to become Ready, then try again.");
        return;
      }

      try {
        clearError();
        await handler();
      } catch (error) {
        showError(normalizeUiError(error));
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
      showError(normalizeUiError(error));
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
      charts.clearPlot(dom.cmcCanvas);
    });
  }

  function bindActions() {
    dom.cmcInput.accept = config.ACCEPTED_DATA_EXTENSIONS;
    dom.cmcInput.addEventListener("change", handleCmcSelection);
    dom.cmcAnalyze.addEventListener("click", withUiLock(runCmc));
    dom.runtimeRetry.addEventListener("click", () => {
      retryRuntime();
    });

    dom.cmcExport.addEventListener("click", async () => {
      if (state.cmc.payload) {
        await charts.exportPlotAsPng(dom.cmcCanvas, "cmc-curve");
      }
    });
  }

  function initializeTimeSeriesModule() {
    timeSeriesController = window.SurfaceLabTimeSeriesModule.createController({
      config,
      charts,
      pyodideClient,
      isRuntimeReady: () => state.runtimeReady,
      setStatus,
      showError,
      clearError,
      normalizeUiError,
    });
    timeSeriesController.bind();
  }

  async function boot() {
    bindTabs();
    bindActions();
    bindCmcTableEditing();
    initializeTimeSeriesModule();
    activateTab("plot");
    setRuntimeReady(false);
    setStatus("Preparing browser-local Python runtime...");
    charts.clearPlot(dom.cmcCanvas);

    await retryRuntime();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
