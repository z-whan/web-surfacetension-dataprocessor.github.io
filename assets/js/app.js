(function () {
  const config = window.SurfaceLabConfig;
  const charts = window.SurfaceLabCharts;
  const pyodideClient = window.SurfaceLabPyodide;
  const downloads = window.SurfaceLabDownloads;
  const sessionManager = window.SurfaceLabSessionManager;
  const domUtils = window.SurfaceLabDomUtils;
  const cmcWorkflow = window.SurfaceLabCmcWorkflow;

  const state = {
    runtimeReady: false,
    cmc: {
      rows: [],
      reviewPayload: null,
      plotPayload: null,
      usedOverrides: {},
      reviewCacheKey: null,
      reviewDirty: true,
      plotDirty: true,
      fileSort: { key: null, direction: "asc" },
      autoPlotTimer: null,
      plotInProgress: false,
      pendingAutoPlot: false,
    },
  };

  const dom = {
    statusText: document.querySelector("[data-status-text]"),
    runtimeTag: document.querySelector("[data-runtime-tag]"),
    errorBox: document.querySelector("[data-error-box]"),
    errorTitle: document.querySelector("[data-error-box] strong"),
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
    cmcMaxEvaporationRate: document.querySelector("#cmc-max-evaporation-rate"),
    cmcPerformancePreset: document.querySelector("#cmc-performance-preset"),
    cmcAggregationMethod: document.querySelector("#cmc-aggregation-method"),
    cmcFitModel: document.querySelector("#cmc-fit-model"),
    cmcTemperature: document.querySelector("#cmc-temperature"),
    cmcDensityOverride: document.querySelector("#cmc-density-override"),
    cmcReview: document.querySelector("#cmc-review"),
    cmcPlotFit: document.querySelector("#cmc-plot-fit"),
    cmcClearFiles: document.querySelector("#cmc-clear-files"),
    cmcExport: document.querySelector("#cmc-export"),
    cmcExportSvg: document.querySelector("#cmc-export-svg"),
    cmcExportJson: document.querySelector("#cmc-export-json"),
    cmcSendPublication: document.querySelector("#cmc-send-publication"),
    cmcSummary: document.querySelector("[data-cmc-summary]"),
    cmcCanvas: document.querySelector("#cmc-canvas"),
    cmcEmpty: document.querySelector("[data-cmc-empty]"),
    cmcDropletEmpty: document.querySelector("[data-cmc-droplet-empty]"),
    cmcDropletReview: document.querySelector("[data-cmc-droplet-review]"),
    cmcHelpButton: document.querySelector("#cmc-help-button"),
    cmcHelpDialog: document.querySelector("#cmc-help-dialog"),
    cmcHelpClose: document.querySelector("#cmc-help-close"),
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
    dom.errorBox.dataset.severity = "error";
    dom.errorTitle.textContent = "Runtime / Analysis Error";
    dom.errorText.textContent = message;
    dom.errorBox.hidden = false;
  }

  function showWarning(message) {
    dom.errorBox.dataset.severity = "warning";
    dom.errorTitle.textContent = "CMC Notice";
    dom.errorText.textContent = message;
    dom.errorBox.hidden = false;
  }

  function clearError() {
    dom.errorBox.dataset.severity = "";
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
    const repeats = meta.configuredExperimentSlotCount && meta.actualRepeatCount != null
      ? meta.actualRepeatCount + "/" + meta.configuredExperimentSlotCount
      : meta.repeatCount;
    const chips = [
      metadataChip("method", meta.analysisMethod),
      metadataChip("d", numericText(meta.densityDeltaGPerCm3, 5)),
      metadataChip("interval", meta.measurementIntervalMs == null ? null : numericText(meta.measurementIntervalMs, 2) + " ms"),
      metadataChip("count", meta.measurementCount),
      metadataChip("repeats", repeats),
    ].filter(Boolean);
    domUtils.replaceChildren(container, chips.length ? chips : [domUtils.el("span", { className: "table-subtle", text: "—" })]);
  }

  function clearCmcAutoPlotTimer() {
    if (state.cmc.autoPlotTimer) {
      clearTimeout(state.cmc.autoPlotTimer);
      state.cmc.autoPlotTimer = null;
    }
  }

  function clearCmcResults(options) {
    const opts = options || {};
    clearCmcAutoPlotTimer();
    state.cmc.reviewPayload = null;
    state.cmc.plotPayload = null;
    state.cmc.reviewCacheKey = null;
    state.cmc.reviewDirty = true;
    state.cmc.plotDirty = true;
    state.cmc.plotInProgress = false;
    state.cmc.pendingAutoPlot = false;
    if (opts.clearOverrides) {
      state.cmc.usedOverrides = {};
    }
    setCmcOutputsEnabled(false);
    renderCmcSummary(null);
    renderCmcDropletReview(state.cmc.reviewPayload);
    charts.clearPlot(dom.cmcCanvas);
  }

  function markCmcReviewDirty() {
    clearCmcResults({ clearOverrides: true });
    renderCmcTable();
  }

  function markCmcPlotDirty() {
    state.cmc.plotDirty = true;
    setCmcOutputsEnabled(false);
  }

  function getCmcPresetOptions() {
    return cmcWorkflow.presetOptions(dom.cmcPerformancePreset.value);
  }

  function getCmcReviewOptions() {
    const preset = getCmcPresetOptions();
    const options = {
      plateauMode: dom.cmcEquilibriumMode.value,
      minPlateauWindowMs: dom.cmcMinPlateauWindow.value,
      plateauSearchStrideMs: preset.plateauSearchStrideMs,
      maxAbsSlopeMnMPerMin: dom.cmcMaxSlope.value,
      maxPlateauSdMnM: dom.cmcMaxSd.value,
      maxVolumeLossPct: "100",
      maxEvaporationRatePctPerMin: dom.cmcMaxEvaporationRate.value,
    };
    const densityText = dom.cmcDensityOverride.value.trim();
    if (densityText) {
      options.densityOverrideGPerCm3 = densityText;
    }
    if (options.plateauMode === "manual") {
      options.tMinText = dom.cmcTimeMin.value.trim();
      options.tMaxText = dom.cmcTimeMax.value.trim();
    }
    return options;
  }

  function getCmcPlotOptions() {
    const preset = getCmcPresetOptions();
    const options = {
      sampleType: dom.cmcSampleType.value,
      fitModel: dom.cmcFitModel.value,
      aggregationMethod: dom.cmcAggregationMethod.value,
      useLog: dom.cmcUseLog.checked,
      cUnit: dom.cmcUnit.value,
      nBootstrap: preset.nBootstrap,
      fitSeriesMaxPoints: preset.fitSeriesMaxPoints,
      concentrations: state.cmc.rows.map((row) => ({
        filename: row.filename,
        concentration: row.concentration,
      })),
    };
    const temperatureText = dom.cmcTemperature.value.trim();
    if (temperatureText) {
      options.temperatureC = temperatureText;
    }
    return options;
  }

  function getCmcOptions() {
    return {
      ...getCmcReviewOptions(),
      ...getCmcPlotOptions(),
    };
  }

  function getCmcReviewTimeRange(reviewOptions) {
    if (reviewOptions.plateauMode === "manual") {
      return {
        tMinText: reviewOptions.tMinText || dom.cmcTimeMin.value,
        tMaxText: reviewOptions.tMaxText || dom.cmcTimeMax.value,
      };
    }
    return { tMinText: "0", tMaxText: "999999999" };
  }

  function currentReviewCacheKey(reviewOptions) {
    return cmcWorkflow.reviewCacheKey(state.cmc.rows, reviewOptions || getCmcReviewOptions());
  }

  function applyCurrentUsedOverrides() {
    if (!state.cmc.reviewPayload) {
      return null;
    }
    return cmcWorkflow.applyUsedOverrides(
      state.cmc.reviewPayload,
      state.cmc.rows,
      state.cmc.usedOverrides
    );
  }

  function compactReviewPayloadForPlot(reviewPayload) {
    if (!reviewPayload) {
      return null;
    }
    return {
      files: (reviewPayload.files || []).map((file) => ({
        filename: file.filename,
        path: file.path,
        concentration: file.concentration,
        metadata: file.metadata || {},
        detectedDropletCount: file.detectedDropletCount,
        acceptedDropletCount: file.acceptedDropletCount,
        warningCount: file.warningCount,
        droplets: (file.droplets || []).map((droplet) => ({
          dropletIndex: droplet.dropletIndex,
          sourceColumn: droplet.sourceColumn,
          pointCount: droplet.pointCount,
          timeMin: droplet.timeMin,
          timeMax: droplet.timeMax,
          hasVolume: droplet.hasVolume,
          densityDeltaGPerCm3: droplet.densityDeltaGPerCm3,
          qc: droplet.qc || {},
          usedForAggregate: droplet.usedForAggregate,
          excludeReason: droplet.excludeReason,
          stableDropletId: droplet.stableDropletId,
        })),
      })),
      options: reviewPayload.options || {},
      summary: reviewPayload.summary || {},
    };
  }

  function findReviewFileForRow(row) {
    const payload = applyCurrentUsedOverrides() || state.cmc.plotPayload;
    const files = payload && Array.isArray(payload.files) ? payload.files : [];
    return files.find((file) => file.filename === row.filename) || null;
  }

  function setCmcOutputsEnabled(enabled) {
    dom.cmcExport.disabled = !enabled;
    dom.cmcExportSvg.disabled = !enabled;
    dom.cmcExportJson.disabled = !enabled;
    dom.cmcSendPublication.disabled = !enabled;
  }

  function setCmcBusy(busy) {
    [dom.cmcReview, dom.cmcPlotFit, dom.cmcClearFiles].forEach((button) => {
      if (button) {
        button.disabled = busy;
      }
    });
  }

  function allowStatusPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 0);
      });
    });
  }

  function formatPercent(value, digits) {
    return value == null ? "—" : numericText(value, digits) + "%";
  }

  function flagBadge(flag, qc) {
    return domUtils.el("span", {
      className: "status-badge warning",
      text: cmcWorkflow.flagLabel(flag),
      attrs: {
        title: cmcWorkflow.flagTitle(flag, qc, getCmcReviewOptions()),
      },
    });
  }

  function effectiveUsedForDroplet(fileIndex, droplet) {
    const key = cmcWorkflow.dropletKey(state.cmc.rows[fileIndex] || {}, droplet);
    if (Object.prototype.hasOwnProperty.call(state.cmc.usedOverrides, key)) {
      return Boolean(state.cmc.usedOverrides[key]);
    }
    return Boolean(droplet.qc && droplet.qc.usedForAggregate);
  }

  function recordCmcPlotPayload(payload) {
    state.cmc.plotPayload = payload;
    state.cmc.plotDirty = false;
    setCmcOutputsEnabled(true);
  }

  function activeCmcPayloadForDisplay() {
    return state.cmc.plotPayload || applyCurrentUsedOverrides();
  }

  function cmcReviewSummaryText(file, rowIndex) {
    const accepted = (file.droplets || []).filter((droplet) => effectiveUsedForDroplet(rowIndex, droplet)).length;
    return file.filename + " · " + accepted + " / " + (file.droplets || []).length + " droplets accepted";
  }

  function updateCmcReviewFileSummary(details) {
    if (!details) {
      return;
    }
    const rowIndex = Number(details.dataset.cmcReviewRowIndex);
    const payload = applyCurrentUsedOverrides();
    const file = payload && payload.files ? payload.files[rowIndex] : null;
    const summary = details.querySelector("summary");
    if (file && summary) {
      summary.textContent = cmcReviewSummaryText(file, rowIndex);
    }
  }

  function plotWarningText(payload) {
    const skipped = payload && Array.isArray(payload.skippedFiles) ? payload.skippedFiles : [];
    if (!skipped.length) {
      return "";
    }
    const names = skipped.map((item) => item.filename || item.path || "unknown file").join(", ");
    return "Some files were skipped because no droplets are marked Used: " + names;
  }

  function sortCmcRowsByConcentration() {
    const current = state.cmc.fileSort;
    const direction = current.key === "concentration" && current.direction === "asc" ? "desc" : "asc";
    state.cmc.rows = cmcWorkflow.sortRowsByConcentration(state.cmc.rows, direction);
    state.cmc.fileSort = { key: "concentration", direction };
    if (state.cmc.reviewPayload && Array.isArray(state.cmc.reviewPayload.files)) {
      const byFilename = new Map(state.cmc.reviewPayload.files.map((file) => [file.filename, file]));
      state.cmc.reviewPayload.files = state.cmc.rows
        .map((row) => byFilename.get(row.filename))
        .filter(Boolean);
    }
    markCmcPlotDirty();
    renderCmcTable();
    renderCmcDropletReview(applyCurrentUsedOverrides());
    scheduleCmcPlotRebuild();
  }

  function scheduleCmcPlotRebuild() {
    if (!state.cmc.plotPayload) {
      return;
    }
    clearCmcAutoPlotTimer();
    state.cmc.autoPlotTimer = setTimeout(() => {
      state.cmc.autoPlotTimer = null;
      rebuildCmcPlotIfReady();
    }, 120);
  }

  function syncCmcModeFields() {
    const isAuto = dom.cmcEquilibriumMode.value === "auto";
    dom.cmcManualFields.hidden = isAuto;
    dom.cmcAutoFields.hidden = !isAuto;
  }

  function openCmcHelp() {
    if (typeof dom.cmcHelpDialog.showModal === "function") {
      dom.cmcHelpDialog.showModal();
    } else {
      dom.cmcHelpDialog.setAttribute("open", "open");
    }
  }

  function closeCmcHelp() {
    if (typeof dom.cmcHelpDialog.close === "function") {
      dom.cmcHelpDialog.close();
    } else {
      dom.cmcHelpDialog.removeAttribute("open");
    }
  }

  function renderCmcSummary(payload) {
    if (!payload) {
      domUtils.clear(dom.cmcSummary);
      return;
    }

    const windowValues = payload.summary.timeWindow || [];
    const start = windowValues[0];
    const end = windowValues[1];
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
      domUtils.metricCard("σCMC", fit.sigmaAtCmc ? numericText(fit.sigmaAtCmc, 4) : "—"),
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
      const fileResult = findReviewFileForRow(row);
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
    const openByKey = new Map(
      Array.from(dom.cmcDropletReview.querySelectorAll("[data-cmc-review-file-key]")).map((details) => [
        details.dataset.cmcReviewFileKey,
        details.open,
      ])
    );
    domUtils.clear(dom.cmcDropletReview);
    const files = payload && Array.isArray(payload.files) ? payload.files : [];
    dom.cmcDropletEmpty.hidden = files.length > 0;
    if (!files.length) {
      return;
    }

    files.forEach((file, displayFileIndex) => {
      const fileIndex = state.cmc.rows.findIndex((row) => row.filename === file.filename);
      const rowIndex = fileIndex >= 0 ? fileIndex : displayFileIndex;
      const row = state.cmc.rows[rowIndex] || {};
      const reviewFileKey = row.fileKey || file.filename || String(displayFileIndex);
      const hasOpenState = openByKey.has(reviewFileKey);
      const details = domUtils.el("details", {
        className: "cmc-review-file",
        attrs: {
          "data-cmc-review-file-key": reviewFileKey,
          "data-cmc-review-row-index": rowIndex,
        },
        props: { open: hasOpenState ? openByKey.get(reviewFileKey) : displayFileIndex === 0 },
      });
      details.appendChild(domUtils.el("summary", {
        text: cmcReviewSummaryText(file, rowIndex),
      }));
      const table = domUtils.el("table", { className: "compact-table" });
      const thead = domUtils.el("thead", {}, [
        domUtils.el("tr", {}, [
          "Droplet",
          "σeq",
          "Plateau Window",
          "Slope",
          "Noise",
          "Full Evaporation",
          "Plateau Evaporation",
          "Flags",
          "Used",
        ].map((label) => domUtils.el("th", { text: label }))),
      ]);
      const tbody = domUtils.el("tbody");
      (file.droplets || []).forEach((droplet) => {
        const qc = droplet.qc || {};
        const flags = Array.isArray(qc.flags) ? qc.flags : [];
        const stableKey = cmcWorkflow.dropletKey(state.cmc.rows[rowIndex] || {}, droplet);
        const used = effectiveUsedForDroplet(rowIndex, droplet);
        const flagWrap = domUtils.el("div", { className: "chip-list" });
        domUtils.appendChildren(
          flagWrap,
          flags.length
            ? flags.map((flag) => flagBadge(flag, qc))
            : [domUtils.el("span", { className: "status-badge ok", text: "OK" })]
        );
        tbody.appendChild(domUtils.el("tr", {}, [
          domUtils.el("td", { text: droplet.dropletIndex }),
          domUtils.el("td", { text: numericText(qc.gammaEq, 4) }),
          domUtils.el("td", { text: numericText(qc.plateauStartMs, 1) + " - " + numericText(qc.plateauEndMs, 1) + " ms" }),
          domUtils.el("td", { text: numericText(qc.slopeMnMPerMin, 4) }),
          domUtils.el("td", { text: numericText(qc.gammaSd, 4) }),
          domUtils.el("td", { text: formatPercent(qc.fullVolumeLossPct, 2) }),
          domUtils.el("td", { text: formatPercent(qc.plateauVolumeLossPct, 2) }),
          domUtils.el("td", {}, [flagWrap]),
          domUtils.el("td", {}, [
            domUtils.el("input", {
              attrs: {
                type: "checkbox",
                "data-cmc-used-key": stableKey,
                title: "Include this droplet in concentration-level aggregation",
              },
              props: {
                checked: used,
              },
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
    if (!files.length) {
      dom.cmcInput.value = "";
      return;
    }
    state.cmc.rows = cmcWorkflow.appendFileRows(
      state.cmc.rows,
      files,
      inferConcentrationFromFilename
    );
    dom.cmcInput.value = "";
    clearCmcResults({ clearOverrides: true });
    renderCmcTable();
  }

  function clearCmcFiles() {
    state.cmc.rows = [];
    state.cmc.usedOverrides = {};
    dom.cmcInput.value = "";
    clearCmcResults({ clearOverrides: true });
    renderCmcTable();
    setStatus("CMC file list cleared.");
  }

  async function ensureCmcOptionalPackages() {
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
  }

  async function reviewCmcDroplets(options) {
    if (!state.cmc.rows.length) {
      throw new Error("Please add at least one file for CMC analysis.");
    }

    const reviewOptions = getCmcReviewOptions();
    const cacheKey = currentReviewCacheKey(reviewOptions);
    if (!options || options.force !== true) {
      if (
        state.cmc.reviewPayload &&
        !state.cmc.reviewDirty &&
        state.cmc.reviewCacheKey === cacheKey
      ) {
        renderCmcTable();
        renderCmcDropletReview(applyCurrentUsedOverrides());
        return state.cmc.reviewPayload;
      }
    }

    setStatus("Reviewing droplet QC...");
    await allowStatusPaint();
    await ensureCmcOptionalPackages();

    const stagedRows = [];
    const entries = [];

    try {
      for (const row of state.cmc.rows) {
        const staged = await pyodideClient.stageBrowserFile(row.file, "cmc");
        stagedRows.push(staged);
        entries.push({
          path: staged.fsPath,
          filename: row.filename,
        });
      }

      const timeRange = getCmcReviewTimeRange(reviewOptions);
      const reviewPayload = await pyodideClient.callBridge(
        "review_cmc_files",
        entries,
        timeRange.tMinText,
        timeRange.tMaxText,
        reviewOptions
      );

      state.cmc.reviewPayload = reviewPayload;
      state.cmc.reviewCacheKey = cacheKey;
      state.cmc.reviewDirty = false;
      state.cmc.plotDirty = true;
      state.cmc.plotPayload = null;
      state.cmc.usedOverrides = {};
      setCmcOutputsEnabled(false);
      renderCmcTable();
      renderCmcDropletReview(reviewPayload);
      setStatus("Reviewed droplet QC for " + reviewPayload.summary.fileCount + " files.");
      return reviewPayload;
    } finally {
      stagedRows.forEach((staged) => {
        pyodideClient.removeFsFile(staged.fsPath);
      });
    }
  }

  async function plotCmcFromReview(options) {
    const plotOptions = options || {};
    if (state.cmc.plotInProgress) {
      state.cmc.pendingAutoPlot = true;
      return state.cmc.plotPayload;
    }

    if (!state.cmc.rows.length) {
      throw new Error("Please add at least one file for CMC analysis.");
    }

    if (!state.cmc.reviewPayload || state.cmc.reviewDirty) {
      if (plotOptions.silentReview !== true) {
        setStatus("Review is stale; reviewing droplet QC first...");
      }
      await reviewCmcDroplets();
    }

    state.cmc.plotInProgress = true;
    try {
      setStatus("Plotting/Fitting CMC from cached QC...");
      await allowStatusPaint();
      const reviewForPlot = compactReviewPayloadForPlot(applyCurrentUsedOverrides());
      const plotPayload = await pyodideClient.callBridge(
        "build_cmc_plot_payload_from_review_json",
        JSON.stringify(reviewForPlot),
        JSON.stringify(getCmcPlotOptions())
      );

      recordCmcPlotPayload(plotPayload);
      await charts.renderCmcPlot(dom.cmcCanvas, plotPayload);
      renderCmcSummary(plotPayload);
      renderCmcTable();
      if (plotOptions.renderReview !== false) {
        renderCmcDropletReview(applyCurrentUsedOverrides());
      }
      const warningText = plotWarningText(plotPayload);
      if (warningText) {
        showWarning(warningText);
      }
      setStatus(
        warningText
          ? "Plotted/Fitted CMC from cached QC; some files were skipped."
          : "Plotted/Fitted CMC from cached droplet QC."
      );
      return plotPayload;
    } finally {
      state.cmc.plotInProgress = false;
      if (state.cmc.pendingAutoPlot) {
        state.cmc.pendingAutoPlot = false;
        scheduleCmcPlotRebuild();
      }
    }
  }

  async function rebuildCmcPlotIfReady() {
    if (!state.cmc.plotPayload || !state.cmc.reviewPayload || state.cmc.reviewDirty) {
      return;
    }
    try {
      clearError();
      await plotCmcFromReview({ silentReview: true, renderReview: false });
    } catch (error) {
      showError(normalizeUiError(error));
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
        setCmcBusy(true);
        await handler();
      } catch (error) {
        showError(normalizeUiError(error));
      } finally {
        setCmcBusy(false);
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
        markCmcPlotDirty();
        scheduleCmcPlotRebuild();
      }
    });

    dom.cmcTableBody.addEventListener("click", (event) => {
      const sortButton = event.target.closest("[data-cmc-sort]");
      if (sortButton && sortButton.dataset.cmcSort === "concentration") {
        sortCmcRowsByConcentration();
        return;
      }

      const button = event.target.closest("[data-cmc-remove-index]");
      if (!button) {
        return;
      }
      const index = Number(button.dataset.cmcRemoveIndex);
      if (!Number.isInteger(index)) {
        return;
      }
      state.cmc.rows.splice(index, 1);
      clearCmcResults({ clearOverrides: true });
      renderCmcTable();
    });

    dom.cmcDropletReview.addEventListener("change", (event) => {
      const checkbox = event.target.closest("[data-cmc-used-key]");
      if (!checkbox) {
        return;
      }
      state.cmc.usedOverrides[checkbox.dataset.cmcUsedKey] = checkbox.checked;
      markCmcPlotDirty();
      updateCmcReviewFileSummary(checkbox.closest("details"));
      scheduleCmcPlotRebuild();
    });
  }

  function exportCmcJson() {
    if (!state.cmc.reviewPayload && !state.cmc.plotPayload) {
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reviewForExport = applyCurrentUsedOverrides();
    const plotPayload = state.cmc.plotPayload;
    const payload = {
      exportedAt: new Date().toISOString(),
      analysisType: "cmc",
      options: getCmcOptions(),
      reviewPayload: reviewForExport,
      plotPayload,
      usedOverrides: state.cmc.usedOverrides,
      manualOverrides: state.cmc.usedOverrides,
      summary: plotPayload ? plotPayload.summary : (reviewForExport && reviewForExport.summary),
      rows: plotPayload ? plotPayload.rows : [],
      points: plotPayload ? plotPayload.points : [],
      files: plotPayload ? plotPayload.files : (reviewForExport ? reviewForExport.files : []),
      droplets: ((plotPayload && plotPayload.files) || (reviewForExport && reviewForExport.files) || []).flatMap((file) =>
        (file.droplets || []).map((droplet) => ({
          filename: file.filename,
          metadata: file.metadata,
          ...droplet,
        }))
      ),
      fit: plotPayload ? plotPayload.fit : null,
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
    const concentrationSortButton = document.querySelector("[data-cmc-sort='concentration']");
    if (concentrationSortButton) {
      concentrationSortButton.addEventListener("click", sortCmcRowsByConcentration);
    }
    dom.cmcEquilibriumMode.addEventListener("change", () => {
      syncCmcModeFields();
      markCmcReviewDirty();
    });
    [
      dom.cmcTimeMin,
      dom.cmcTimeMax,
      dom.cmcMinPlateauWindow,
      dom.cmcMaxSlope,
      dom.cmcMaxSd,
      dom.cmcMaxEvaporationRate,
      dom.cmcDensityOverride,
      dom.cmcPerformancePreset,
    ].forEach((element) => {
      element.addEventListener("input", markCmcReviewDirty);
      element.addEventListener("change", markCmcReviewDirty);
    });
    [
      dom.cmcUseLog,
      dom.cmcFitModel,
      dom.cmcSampleType,
      dom.cmcAggregationMethod,
      dom.cmcUnit,
      dom.cmcTemperature,
    ].forEach((element) => {
      element.addEventListener("change", () => {
        markCmcPlotDirty();
        scheduleCmcPlotRebuild();
      });
      element.addEventListener("input", () => {
        markCmcPlotDirty();
      });
    });
    dom.cmcReview.addEventListener("click", withUiLock(() => reviewCmcDroplets({ force: true })));
    dom.cmcPlotFit.addEventListener("click", withUiLock(plotCmcFromReview));
    dom.cmcClearFiles.addEventListener("click", clearCmcFiles);
    dom.cmcHelpButton.addEventListener("click", openCmcHelp);
    dom.cmcHelpClose.addEventListener("click", closeCmcHelp);
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
      if (state.cmc.plotPayload) {
        await charts.exportPlotAsPng(dom.cmcCanvas, "cmc-curve");
      }
    });
    dom.cmcExportSvg.addEventListener("click", async () => {
      if (state.cmc.plotPayload) {
        await charts.exportPlotImage(dom.cmcCanvas, "cmc-curve", { format: "svg" });
      }
    });
    dom.cmcExportJson.addEventListener("click", exportCmcJson);
    dom.cmcSendPublication.addEventListener("click", () => {
      if (!state.cmc.plotPayload || !publicationController) {
        return;
      }
      publicationController.copyFromPlot(dom.cmcCanvas, {
        sourceType: "cmc",
        sourceTitle: "CMC plot",
        filenameBase: "cmc-publication",
      });
    });
    const cmcPanel = document.querySelector("[data-tab-panel='cmc']");
    if (cmcPanel) {
      cmcPanel.addEventListener("dragover", (event) => {
        event.preventDefault();
        cmcPanel.classList.add("drop-active");
      });
      cmcPanel.addEventListener("dragleave", () => {
        cmcPanel.classList.remove("drop-active");
      });
      cmcPanel.addEventListener("drop", (event) => {
        event.preventDefault();
        cmcPanel.classList.remove("drop-active");
        const files = Array.from(event.dataTransfer ? event.dataTransfer.files || [] : []);
        if (!files.length) {
          return;
        }
        state.cmc.rows = cmcWorkflow.appendFileRows(
          state.cmc.rows,
          files,
          inferConcentrationFromFilename
        );
        clearCmcResults({ clearOverrides: true });
        renderCmcTable();
      });
    }
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
