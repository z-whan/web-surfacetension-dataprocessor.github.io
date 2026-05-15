(function () {
  const config = window.SurfaceLabConfig;
  const charts = window.SurfaceLabCharts;
  const pyodideClient = window.SurfaceLabPyodide;
  const downloads = window.SurfaceLabDownloads;
  const sessionManager = window.SurfaceLabSessionManager;
  const domUtils = window.SurfaceLabDomUtils;

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
    sessionExport: document.querySelector("#session-export"),
    sessionImportButton: document.querySelector("#session-import-button"),
    sessionImportFile: document.querySelector("#session-import-file"),
    tabButtons: Array.from(document.querySelectorAll("[data-tab-button]")),
    panels: Array.from(document.querySelectorAll("[data-tab-panel]")),

    cmcInput: document.querySelector("#cmc-files"),
    cmcTableBody: document.querySelector("[data-cmc-table-body]"),
    cmcTimeMin: document.querySelector("#cmc-time-min"),
    cmcTimeMax: document.querySelector("#cmc-time-max"),
    cmcUnit: document.querySelector("#cmc-unit"),
    cmcUseLog: document.querySelector("#cmc-use-log"),
    cmcSampleType: document.querySelector("#cmc-sample-type"),
    cmcEquilibriumMode: document.querySelector("#cmc-equilibrium-mode"),
    cmcManualFields: document.querySelector("[data-cmc-manual-fields]"),
    cmcAutoFields: document.querySelector("[data-cmc-auto-fields]"),
    cmcMinPlateauWindow: document.querySelector("#cmc-min-plateau-window"),
    cmcMaxSlope: document.querySelector("#cmc-max-slope"),
    cmcMaxSd: document.querySelector("#cmc-max-sd"),
    cmcMaxVolumeLoss: document.querySelector("#cmc-max-volume-loss"),
    cmcAggregationMethod: document.querySelector("#cmc-aggregation-method"),
    cmcFitModel: document.querySelector("#cmc-fit-model"),
    cmcTemperature: document.querySelector("#cmc-temperature"),
    cmcDensityOverride: document.querySelector("#cmc-density-override"),
    cmcAnalyze: document.querySelector("#cmc-run"),
    cmcExport: document.querySelector("#cmc-export"),
    cmcExportSvg: document.querySelector("#cmc-export-svg"),
    cmcExportJson: document.querySelector("#cmc-export-json"),
    cmcSendPublication: document.querySelector("#cmc-send-publication"),
    cmcSummary: document.querySelector("[data-cmc-summary]"),
    cmcCanvas: document.querySelector("#cmc-canvas"),
    cmcEmpty: document.querySelector("[data-cmc-empty]"),
    cmcDropletEmpty: document.querySelector("[data-cmc-droplet-empty]"),
    cmcDropletReview: document.querySelector("[data-cmc-droplet-review]"),
  };

  let timeSeriesController = null;
  let compareController = null;
  let publicationController = null;

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

  function numericText(value, digits) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return "—";
    }
    return numeric.toLocaleString(undefined, {
      maximumFractionDigits: typeof digits === "number" ? digits : 4,
    });
  }

  function countWarnings(payload) {
    const fitWarnings = payload && payload.fit && Array.isArray(payload.fit.warnings)
      ? payload.fit.warnings.length
      : 0;
    const dropletWarnings = (payload && payload.files ? payload.files : []).reduce((total, file) => {
      return total + (file.droplets || []).filter((droplet) => {
        const flags = droplet.qc && Array.isArray(droplet.qc.flags) ? droplet.qc.flags : [];
        return flags.length > 0;
      }).length;
    }, 0);
    return fitWarnings + dropletWarnings;
  }

  function metadataChip(label, value) {
    if (value === null || typeof value === "undefined" || value === "") {
      return null;
    }
    return domUtils.el("span", { className: "metadata-chip" }, [
      domUtils.el("span", { text: label }),
      domUtils.el("strong", { text: value }),
    ]);
  }

  function appendMetadataChips(container, metadata) {
    const meta = metadata || {};
    const chips = [
      metadataChip("density", numericText(meta.densityDeltaGPerCm3, 5)),
      metadataChip("method", meta.analysisMethod),
      metadataChip("interval", meta.measurementIntervalMs == null ? null : numericText(meta.measurementIntervalMs, 2) + " ms"),
      metadataChip("repeat", meta.repeatCount),
    ].filter(Boolean);
    domUtils.replaceChildren(container, chips.length ? chips : [domUtils.el("span", { className: "table-subtle", text: "—" })]);
  }

  function getCmcOptions() {
    const options = {
      sampleType: dom.cmcSampleType.value,
      plateauMode: dom.cmcEquilibriumMode.value,
      fitModel: dom.cmcFitModel.value,
      minPlateauWindowMs: dom.cmcMinPlateauWindow.value,
      maxAbsSlopeMnMPerMin: dom.cmcMaxSlope.value,
      maxPlateauSdMnM: dom.cmcMaxSd.value,
      maxVolumeLossPct: dom.cmcMaxVolumeLoss.value,
      aggregationMethod: dom.cmcAggregationMethod.value,
    };

    const temperatureText = dom.cmcTemperature.value.trim();
    if (temperatureText) {
      options.temperatureC = temperatureText;
    }
    const densityText = dom.cmcDensityOverride.value.trim();
    if (densityText) {
      options.densityOverrideGPerCm3 = densityText;
    }
    return options;
  }

  function syncCmcModeFields() {
    const isAuto = dom.cmcEquilibriumMode.value === "auto";
    dom.cmcManualFields.hidden = isAuto;
    dom.cmcAutoFields.hidden = !isAuto;
  }

  function renderCmcSummary(payload) {
    if (!payload) {
      domUtils.clear(dom.cmcSummary);
      return;
    }

    const start = payload.summary.timeWindow[0];
    const end = payload.summary.timeWindow[1];
    const fit = payload.fit || {};
    const marker = fit.cmcMarker || {};
    const label = marker.label || "Transition";
    const accepted = payload.rows.reduce((total, row) => total + (Number(row.usedDropletCount) || 0), 0);
    const totalDroplets = payload.rows.reduce((total, row) => total + (Number(row.dropletCount) || 0), 0);
    const ciText = fit.ciLow && fit.ciHigh
      ? numericText(fit.ciLow, 4) + " - " + numericText(fit.ciHigh, 4)
      : "—";
    domUtils.replaceChildren(dom.cmcSummary, [
      domUtils.metricCard(label, fit.cmc ? numericText(fit.cmc, 5) : "—"),
      domUtils.metricCard("γCMC", fit.gammaAtCmc ? numericText(fit.gammaAtCmc, 4) : "—"),
      domUtils.metricCard("CI", ciText),
      domUtils.metricCard("Model", fit.modelLabel || "No fit"),
      domUtils.metricCard("Files", payload.summary.fileCount),
      domUtils.metricCard("Accepted droplets", accepted + " / " + totalDroplets),
      domUtils.metricCard("Warnings", countWarnings(payload)),
      domUtils.metricCard("Window", numericText(start, 2) + " - " + numericText(end, 2) + " ms"),
    ]);
  }

  function renderCmcTable() {
    dom.cmcEmpty.hidden = state.cmc.rows.length > 0;
    domUtils.clear(dom.cmcTableBody);

    state.cmc.rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      const fileResult = state.cmc.payload && state.cmc.payload.files
        ? state.cmc.payload.files.find((file) => file.filename === row.filename)
        : null;
      const metadataCell = domUtils.el("td");
      appendMetadataChips(metadataCell, fileResult && fileResult.metadata);
      const concentrationInput = domUtils.el("input", {
        className: "table-input",
        attrs: {
          type: "text",
          value: row.concentration,
          "data-cmc-concentration-index": index,
          placeholder: "e.g. 1.0",
        },
      });
      const removeButton = domUtils.el("button", {
        className: "ghost-button",
        text: "Remove",
        attrs: {
          type: "button",
          "data-cmc-remove-index": index,
        },
      });
      domUtils.appendChildren(tr, [
        domUtils.el("td", { text: String(index + 1).padStart(2, "0") }),
        domUtils.el("td", {}, [
          domUtils.el("div", { className: "table-file", text: row.filename }),
          domUtils.el("div", { className: "table-subtle", text: (row.size / 1024).toFixed(1) + " KB" }),
        ]),
        domUtils.el("td", {}, [concentrationInput]),
        metadataCell,
        domUtils.el("td", {}, [removeButton]),
      ]);
      dom.cmcTableBody.appendChild(tr);
    });
  }

  function renderCmcDropletReview(payload) {
    domUtils.clear(dom.cmcDropletReview);
    const files = payload && Array.isArray(payload.files) ? payload.files : [];
    dom.cmcDropletEmpty.hidden = files.length > 0;
    if (!files.length) {
      return;
    }

    files.forEach((file, fileIndex) => {
      const details = domUtils.el("details", {
        className: "cmc-review-file",
        props: { open: fileIndex === 0 },
      });
      const accepted = (file.droplets || []).filter((droplet) => droplet.usedForAggregate).length;
      details.appendChild(domUtils.el("summary", {
        text: file.filename + " · " + accepted + " / " + (file.droplets || []).length + " droplets accepted",
      }));
      const table = domUtils.el("table", { className: "compact-table" });
      const thead = domUtils.el("thead", {}, [
        domUtils.el("tr", {}, [
          "Droplet",
          "γeq",
          "Plateau Window",
          "Slope",
          "Noise",
          "Volume Loss",
          "Flags",
          "Used",
        ].map((label) => domUtils.el("th", { text: label }))),
      ]);
      const tbody = domUtils.el("tbody");
      (file.droplets || []).forEach((droplet) => {
        const qc = droplet.qc || {};
        const flags = Array.isArray(qc.flags) ? qc.flags : [];
        const flagWrap = domUtils.el("div", { className: "chip-list" });
        domUtils.appendChildren(
          flagWrap,
          flags.length
            ? flags.map((flag) => domUtils.el("span", { className: "status-badge warning", text: flag }))
            : [domUtils.el("span", { className: "status-badge ok", text: "OK" })]
        );
        tbody.appendChild(domUtils.el("tr", {}, [
          domUtils.el("td", { text: droplet.dropletIndex }),
          domUtils.el("td", { text: numericText(qc.gammaEq, 4) }),
          domUtils.el("td", { text: numericText(qc.plateauStartMs, 1) + " - " + numericText(qc.plateauEndMs, 1) + " ms" }),
          domUtils.el("td", { text: numericText(qc.slopeMnMPerMin, 4) }),
          domUtils.el("td", { text: numericText(qc.gammaSd, 4) }),
          domUtils.el("td", { text: qc.volumeLossPct == null ? "—" : numericText(qc.volumeLossPct, 2) + "%" }),
          domUtils.el("td", {}, [flagWrap]),
          domUtils.el("td", {}, [
            domUtils.el("span", {
              className: "status-badge " + (qc.usedForAggregate ? "ok" : "muted"),
              text: qc.usedForAggregate ? "yes" : "no",
            }),
          ]),
        ]));
      });
      table.appendChild(thead);
      table.appendChild(tbody);
      details.appendChild(domUtils.el("div", { className: "table-scroll" }, [table]));
      dom.cmcDropletReview.appendChild(details);
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
    dom.cmcExportSvg.disabled = true;
    dom.cmcExportJson.disabled = true;
    dom.cmcSendPublication.disabled = true;
    renderCmcTable();
    renderCmcSummary(null);
    renderCmcDropletReview(null);
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

      const cmcOptions = getCmcOptions();
      const timeMinText = cmcOptions.plateauMode === "auto" && !dom.cmcTimeMin.value.trim()
        ? "0"
        : dom.cmcTimeMin.value;
      const timeMaxText = cmcOptions.plateauMode === "auto" && !dom.cmcTimeMax.value.trim()
        ? "999999999"
        : dom.cmcTimeMax.value;

      const payload = await pyodideClient.callBridge(
        "analyze_cmc_files",
        entries,
        timeMinText,
        timeMaxText,
        dom.cmcUnit.value,
        dom.cmcUseLog.checked,
        cmcOptions
      );

      state.cmc.payload = payload;
      await charts.renderCmcPlot(dom.cmcCanvas, payload);
      renderCmcSummary(payload);
      renderCmcTable();
      renderCmcDropletReview(payload);
      dom.cmcExport.disabled = false;
      dom.cmcExportSvg.disabled = false;
      dom.cmcExportJson.disabled = false;
      dom.cmcSendPublication.disabled = false;
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

  function sessionFilename() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `surface-lab-session-${stamp}.json`;
  }

  function exportSession() {
    clearError();
    const session = sessionManager.createSession({
      timeSeries: timeSeriesController ? timeSeriesController.getSessionState() : {},
      compare: compareController ? compareController.getSessionState() : {},
      publication: publicationController ? publicationController.getSessionState() : {},
    });
    downloads.downloadText(
      sessionFilename(),
      JSON.stringify(session, null, 2),
      "application/json;charset=utf-8"
    );
    const warningText = session.warnings.length
      ? ` Warnings: ${session.warnings.join(" ")}`
      : "";
    setStatus("Session exported as JSON." + warningText);
  }

  async function restoreSession(session) {
    const warnings = [];
    if (timeSeriesController && session.timeSeries) {
      warnings.push(...timeSeriesController.restoreSessionState(session.timeSeries));
    }
    if (compareController && session.compare) {
      warnings.push(...(await compareController.restoreSessionState(session.compare)));
    }
    if (publicationController && session.publication) {
      warnings.push(...(await publicationController.restoreSessionState(session.publication)));
    }
    if (warnings.length || (session.warnings && session.warnings.length)) {
      showError(
        "Session imported with warnings: " +
          (session.warnings || []).concat(warnings).join(" ")
      );
    } else {
      clearError();
    }
    setStatus("Session imported. Supported Time Series, Compare, and Publication Plot state was restored.");
  }

  async function importSessionFile(file) {
    if (!file) {
      return;
    }

    try {
      clearError();
      const text = await file.text();
      const result = sessionManager.parseAndValidateSession(text);
      if (!result.ok) {
        showError(result.warnings.join(" "));
        setStatus("Session import failed.");
        return;
      }
      await restoreSession(result.session);
    } catch (error) {
      showError(normalizeUiError(error));
      setStatus("Session import failed.");
    } finally {
      dom.sessionImportFile.value = "";
    }
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
      dom.cmcExportSvg.disabled = true;
      dom.cmcExportJson.disabled = true;
      dom.cmcSendPublication.disabled = true;
      renderCmcTable();
      renderCmcSummary(null);
      renderCmcDropletReview(null);
      charts.clearPlot(dom.cmcCanvas);
    });
  }

  function exportCmcJson() {
    if (!state.cmc.payload) {
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const payload = {
      exportedAt: new Date().toISOString(),
      analysisType: "cmc",
      options: state.cmc.payload.options || getCmcOptions(),
      summary: state.cmc.payload.summary,
      rows: state.cmc.payload.rows,
      points: state.cmc.payload.points,
      files: state.cmc.payload.files,
      droplets: (state.cmc.payload.files || []).flatMap((file) =>
        (file.droplets || []).map((droplet) => ({
          filename: file.filename,
          metadata: file.metadata,
          ...droplet,
        }))
      ),
      fit: state.cmc.payload.fit,
      metadata: {
        concentrationUnit: dom.cmcUnit.value,
        useLog: dom.cmcUseLog.checked,
      },
    };
    downloads.downloadText(
      "cmc-analysis-" + stamp + ".json",
      JSON.stringify(payload, null, 2),
      "application/json;charset=utf-8"
    );
    setStatus("CMC JSON exported with rows, droplets, fit, options, and metadata.");
  }

  function bindActions() {
    dom.cmcInput.accept = config.ACCEPTED_DATA_EXTENSIONS;
    dom.cmcInput.addEventListener("change", handleCmcSelection);
    dom.cmcEquilibriumMode.addEventListener("change", syncCmcModeFields);
    dom.cmcAnalyze.addEventListener("click", withUiLock(runCmc));
    dom.runtimeRetry.addEventListener("click", () => {
      retryRuntime();
    });
    dom.sessionExport.addEventListener("click", exportSession);
    dom.sessionImportButton.addEventListener("click", () => {
      dom.sessionImportFile.click();
    });
    dom.sessionImportFile.addEventListener("change", () => {
      importSessionFile(dom.sessionImportFile.files[0]);
    });

    dom.cmcExport.addEventListener("click", async () => {
      if (state.cmc.payload) {
        await charts.exportPlotAsPng(dom.cmcCanvas, "cmc-curve");
      }
    });
    dom.cmcExportSvg.addEventListener("click", async () => {
      if (state.cmc.payload) {
        await charts.exportPlotImage(dom.cmcCanvas, "cmc-curve", { format: "svg" });
      }
    });
    dom.cmcExportJson.addEventListener("click", exportCmcJson);
    dom.cmcSendPublication.addEventListener("click", () => {
      if (!state.cmc.payload || !publicationController) {
        return;
      }
      publicationController.copyFromPlot(dom.cmcCanvas, {
        sourceType: "cmc",
        sourceTitle: "CMC plot",
        filenameBase: "cmc-publication",
      });
    });
  }

  function initializePublicationModule() {
    publicationController = window.SurfaceLabPublicationPlot.createController({
      charts,
      activateTab,
      setStatus,
    });
    publicationController.bind();
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
      onMarkForCompare: (curves) => compareController.addCurves(curves),
      onSendToPublication: (plotElement, metadata) =>
        publicationController.copyFromPlot(plotElement, metadata),
    });
    timeSeriesController.bind();
  }

  function initializeCompareModule() {
    compareController = window.SurfaceLabCompareModule.createController({
      charts,
      setStatus,
      showError,
      clearError,
      onSendToPublication: (plotElement, metadata) =>
        publicationController.copyFromPlot(plotElement, metadata),
    });
    compareController.bind();
  }

  async function boot() {
    bindTabs();
    initializePublicationModule();
    bindActions();
    bindCmcTableEditing();
    syncCmcModeFields();
    initializeCompareModule();
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
