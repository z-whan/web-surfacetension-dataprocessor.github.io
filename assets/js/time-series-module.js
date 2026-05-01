(function () {
  const domUtils = window.SurfaceLabDomUtils;
  const downloads = window.SurfaceLabDownloads;

  const TREND_METHODS = {
    moving_average: {
      label: "Moving Average / Rolling Mean",
      params: [
        {
          key: "windowSize",
          label: "Window Size",
          type: "number",
          defaultValue: "7",
          min: "2",
          step: "1",
        },
        {
          key: "windowUnit",
          label: "Window Unit",
          type: "select",
          defaultValue: "points",
          options: [
            { value: "points", label: "Points" },
            { value: "milliseconds", label: "Milliseconds" },
            { value: "seconds", label: "Seconds" },
          ],
        },
      ],
      help: {
        principle: "Averages neighboring samples inside a sliding window.",
        use: "Good for simple smoothing when you want a stable baseline.",
        interpret: "Larger windows remove more short-term variation but also flatten fast changes.",
      },
    },
    median_filter: {
      label: "Median Filter",
      params: [
        {
          key: "windowSize",
          label: "Window Size (points)",
          type: "number",
          defaultValue: "5",
          min: "3",
          step: "1",
        },
      ],
      help: {
        principle: "Replaces each point with the median inside the local window.",
        use: "Useful when spikes or outliers should be suppressed without heavy blurring.",
        interpret: "A cleaner curve with preserved step-like changes usually means the filter is working well.",
      },
    },
    savitzky_golay: {
      label: "Savitzky–Golay Filter",
      params: [
        {
          key: "windowLength",
          label: "Window Length (points)",
          type: "number",
          defaultValue: "7",
          min: "3",
          step: "1",
        },
        {
          key: "polyOrder",
          label: "Polynomial Order",
          type: "number",
          defaultValue: "2",
          min: "1",
          step: "1",
        },
      ],
      help: {
        principle: "Fits a small polynomial inside each local window and keeps the center value.",
        use: "Useful when you want smoothing but still want to preserve peak shape and curvature.",
        interpret: "A good result follows the overall structure closely while reducing high-frequency jitter.",
      },
    },
  };

  const NOISE_METHODS = {
    residual_std: {
      label: "Residual Standard Deviation",
      params: [
        {
          key: "useTrend",
          label: "Use extracted trend residual",
          type: "checkbox",
          defaultValue: true,
        },
      ],
      help: {
        principle: "Measures the spread of the residual after removing a baseline.",
        use: "Useful for quantifying noise amplitude after trend removal.",
        interpret: "Smaller residual standard deviation means the signal is tighter around the baseline.",
      },
    },
    adjacent_difference: {
      label: "Adjacent Difference Statistics",
      params: [],
      help: {
        principle: "Analyzes how much each point changes relative to the next one.",
        use: "Useful for quick point-to-point noise checks and jump detection.",
        interpret: "Larger adjacent differences suggest stronger short-range fluctuation or spikes.",
      },
    },
    rolling_std: {
      label: "Rolling Standard Deviation",
      params: [
        {
          key: "windowSize",
          label: "Window Size (points)",
          type: "number",
          defaultValue: "7",
          min: "2",
          step: "1",
        },
      ],
      help: {
        principle: "Computes a local standard deviation inside a moving window.",
        use: "Useful for seeing whether noise changes over time.",
        interpret: "Peaks in rolling standard deviation highlight noisier time regions.",
      },
    },
    allan_deviation: {
      label: "Allan Deviation",
      params: [
        {
          key: "samplingInterval",
          label: "Sampling Interval",
          type: "text",
          defaultValue: "",
          placeholder: "Auto from time axis",
        },
        {
          key: "tauCount",
          label: "Tau Count",
          type: "number",
          defaultValue: "10",
          min: "3",
          step: "1",
        },
      ],
      help: {
        principle: "Compares averaged blocks of the signal at multiple time scales.",
        use: "Useful for separating short-term and long-term stability behavior.",
        interpret: "The curve shape shows which averaging times reduce noise and where drift starts to dominate.",
      },
    },
    psd: {
      label: "Power Spectral Density (PSD)",
      params: [
        {
          key: "processingMode",
          label: "Processing",
          type: "select",
          defaultValue: "remove_mean_only",
          options: [
            { value: "none", label: "None" },
            { value: "remove_mean_only", label: "Remove mean only" },
            { value: "linear_detrend", label: "Linear detrend" },
            { value: "subtract_extracted_trend", label: "Subtract extracted trend" },
          ],
        },
        {
          key: "samplingInterval",
          label: "Sampling Interval",
          type: "text",
          defaultValue: "",
          placeholder: "Auto from time axis",
        },
      ],
      help: {
        principle: "Transforms the time signal into the frequency domain and estimates power by frequency.",
        use: "Useful for spotting periodic noise or dominant frequency bands.",
        interpret: "Sharp peaks indicate dominant periodic components; a broad spectrum suggests broadband noise.",
      },
    },
  };

  function populateMethodSelect(select, definitionMap) {
    domUtils.populateSelect(
      select,
      Object.keys(definitionMap).map((key) => ({
        value: key,
        label: definitionMap[key].label,
      }))
    );
  }

  function renderParameterFields(container, definition) {
    domUtils.clear(container);

    if (!definition.params.length) {
      container.appendChild(domUtils.el("div", { className: "info-box", text: "No additional parameters." }));
      return;
    }

    definition.params.forEach((param) => {
      if (param.type === "checkbox") {
        const input = domUtils.el("input", {
          attrs: { type: "checkbox", "data-param-key": param.key },
          props: { checked: Boolean(param.defaultValue) },
        });
        const label = domUtils.el("label", { className: "checkbox-row checkbox-row-compact" }, [
          input,
          param.label,
        ]);
        container.appendChild(label);
        return;
      }

      const field = domUtils.el("div", { className: "field" });
      field.appendChild(domUtils.el("label", { text: param.label }));

      if (param.type === "select") {
        const select = domUtils.el("select", {
          attrs: { "data-param-key": param.key },
        });
        domUtils.populateSelect(
          select,
          param.options.map((option) => ({
            value: option.value,
            label: option.label,
            selected: option.value === param.defaultValue,
          }))
        );
        field.appendChild(select);
      } else {
        field.appendChild(domUtils.el("input", {
          attrs: {
            type: param.type === "number" ? "number" : "text",
            "data-param-key": param.key,
            placeholder: param.placeholder,
            min: param.min,
            step: param.step,
          },
          props: { value: param.defaultValue || "" },
        }));
      }

      container.appendChild(field);
    });
  }

  function collectParameters(container, definition) {
    const params = {};

    definition.params.forEach((param) => {
      const input = container.querySelector(`[data-param-key="${param.key}"]`);
      if (!input) {
        return;
      }

      if (param.type === "checkbox") {
        params[param.key] = Boolean(input.checked);
      } else {
        params[param.key] = input.value.trim();
      }
    });

    return params;
  }

  function applyParameters(container, definition, values) {
    const source = values && typeof values === "object" ? values : {};
    definition.params.forEach((param) => {
      const input = container.querySelector(`[data-param-key="${param.key}"]`);
      if (!input || !Object.prototype.hasOwnProperty.call(source, param.key)) {
        return;
      }

      if (param.type === "checkbox") {
        input.checked = Boolean(source[param.key]);
      } else {
        input.value = source[param.key] == null ? "" : String(source[param.key]);
      }
    });
  }

  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === "[object Object]";
  }

  function formatValue(value) {
    if (value === null || typeof value === "undefined" || value === "") {
      return "—";
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return "—";
      }
      return Math.abs(value) >= 1000 || Math.abs(value) < 0.01
        ? value.toExponential(3)
        : value.toFixed(4).replace(/\.?0+$/, "");
    }
    return String(value);
  }

  function formatAxisRangeValue(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "";
    }
    return Math.abs(value) >= 1000 || (Math.abs(value) > 0 && Math.abs(value) < 0.01)
      ? value.toExponential(4)
      : value.toFixed(4).replace(/\.?0+$/, "");
  }

  function cloneSeriesValues(values) {
    return Array.isArray(values) ? values.slice() : [];
  }

  function buildHelpSection(title, methods) {
    const section = domUtils.el("section", { className: "help-section" }, [
      domUtils.el("h3", { text: title }),
    ]);

    Object.keys(methods).forEach((key) => {
      const item = methods[key];
      const helpItem = domUtils.el("div", { className: "help-item" }, [
        domUtils.el("h4", { text: item.label }),
        buildHelpLine("Principle:", item.help.principle),
        buildHelpLine("Useful for:", item.help.use),
        buildHelpLine("Interpretation:", item.help.interpret),
      ]);
      section.appendChild(helpItem);
    });

    return section;
  }

  function buildHelpLine(label, text) {
    const paragraph = domUtils.el("p");
    paragraph.appendChild(domUtils.el("strong", { text: label }));
    paragraph.appendChild(document.createTextNode(" " + text));
    return paragraph;
  }

  function renderHelpContent(container) {
    domUtils.replaceChildren(container, [
      buildHelpSection("Trend Extraction", TREND_METHODS),
      buildHelpSection("Noise Analysis", NOISE_METHODS),
    ]);
  }

  function buildSummaryTable(columns, rows) {
    if (!rows.length) {
      return domUtils.el("div", { className: "empty-state", text: "No summary data available." });
    }

    const table = domUtils.el("table");
    const headerRow = domUtils.el("tr");
    columns.forEach((column) => {
      headerRow.appendChild(domUtils.el("th", { text: column }));
    });

    const body = domUtils.el("tbody");
    rows.forEach((row) => {
      const tr = domUtils.el("tr");
      columns.forEach((column) => {
        tr.appendChild(domUtils.el("td", { text: formatValue(row[column]) }));
      });
      body.appendChild(tr);
    });

    table.appendChild(domUtils.el("thead", {}, [headerRow]));
    table.appendChild(body);
    return domUtils.el("div", { className: "table-scroll" }, [table]);
  }

  function renderMetricCards(container, cards) {
    domUtils.replaceChildren(
      container,
      cards.map((card) => domUtils.metricCard(card.label, card.value))
    );
  }

  function renderKeyValueTable(rows) {
    if (!rows.length) {
      return domUtils.el("div", { className: "empty-state", text: "No metrics available." });
    }

    const body = domUtils.el("tbody");
    rows.forEach((row) => {
      body.appendChild(domUtils.el("tr", {}, [
        domUtils.el("td", { text: row.label }),
        domUtils.el("td", { text: row.value }),
      ]));
    });

    const table = domUtils.el("table", {}, [
      domUtils.el("tbody", {}, Array.from(body.childNodes)),
    ]);
    return domUtils.el("div", { className: "table-scroll" }, [table]);
  }

  function renderTextList(title, items, emptyText) {
    const section = domUtils.el("div", { className: "info-box" }, [
      domUtils.el("strong", { text: title }),
    ]);

    if (!items.length) {
      section.appendChild(domUtils.el("p", { text: emptyText }));
      return section;
    }

    const list = domUtils.el("ul");
    items.forEach((item) => {
      list.appendChild(domUtils.el("li", { text: item }));
    });
    section.appendChild(list);
    return section;
  }

  function formatMetricValue(value) {
    if (value === null || typeof value === "undefined") {
      return "—";
    }
    if (typeof value === "boolean") {
      return value ? "Yes" : "No";
    }
    return formatValue(value);
  }

  class TimeSeriesModuleController {
    constructor(options) {
      this.config = options.config;
      this.charts = options.charts;
      this.pyodideClient = options.pyodideClient;
      this.isRuntimeReady = options.isRuntimeReady;
      this.setStatus = options.setStatus;
      this.showError = options.showError;
      this.clearError = options.clearError;
      this.normalizeUiError = options.normalizeUiError;
      this.onMarkForCompare = options.onMarkForCompare;
      this.onSendToPublication = options.onSendToPublication;

      this.state = {
        file: null,
        rawPayload: null,
        trendPayload: null,
        trendRequest: null,
        noisePayload: null,
        qualityPayload: null,
        showRaw: true,
        manualYRange: null,
      };

      this.dom = {
        plotInput: document.querySelector("#plot-file"),
        plotMeta: document.querySelector("[data-plot-meta]"),
        plotStart: document.querySelector("#plot-start"),
        plotEnd: document.querySelector("#plot-end"),
        plotExpRange: document.querySelector("#plot-exp-range"),
        plotAvgOnly: document.querySelector("#plot-avg-only"),
        plotAvgShowOriginal: document.querySelector("#plot-avg-show-original"),
        plotAnalyze: document.querySelector("#plot-run"),
        plotMarkCompare: document.querySelector("#plot-mark-compare"),
        plotExport: document.querySelector("#plot-export"),
        plotExportSvg: document.querySelector("#plot-export-svg"),
        plotSendPublication: document.querySelector("#plot-send-publication"),
        plotReset: document.querySelector("#plot-reset"),
        plotSummary: document.querySelector("[data-plot-summary]"),
        plotCanvas: document.querySelector("#plot-canvas"),
        plotYSpan: document.querySelector("#plot-y-span"),
        plotYSpanValue: document.querySelector("[data-plot-y-span-value]"),
        plotYMin: document.querySelector("#plot-y-min"),
        plotYMax: document.querySelector("#plot-y-max"),
        trendMethod: document.querySelector("#plot-trend-method"),
        trendParams: document.querySelector("#plot-trend-params"),
        trendApply: document.querySelector("#plot-trend-apply"),
        showRawToggle: document.querySelector("#plot-show-raw"),
        trendStatus: document.querySelector("[data-plot-trend-status]"),
        qualityAnalyze: document.querySelector("#plot-quality-run"),
        qualityExport: document.querySelector("#plot-quality-export"),
        qualityStatus: document.querySelector("[data-plot-quality-status]"),
        qualitySummary: document.querySelector("[data-plot-quality-summary]"),
        qualityWarnings: document.querySelector("[data-plot-quality-warnings]"),
        qualityMetrics: document.querySelector("[data-plot-quality-metrics]"),
        qualityActions: document.querySelector("[data-plot-quality-actions]"),
        noiseMethod: document.querySelector("#plot-noise-method"),
        noiseParams: document.querySelector("#plot-noise-params"),
        noiseAnalyze: document.querySelector("#plot-noise-run"),
        noiseSummary: document.querySelector("[data-plot-noise-summary]"),
        noiseTable: document.querySelector("[data-plot-noise-table]"),
        noiseCanvas: document.querySelector("#plot-noise-canvas"),
        noiseExport: document.querySelector("#plot-noise-export"),
        noiseExportSvg: document.querySelector("#plot-noise-export-svg"),
        noiseSendPublication: document.querySelector("#plot-noise-send-publication"),
        noiseCard: document.querySelector("[data-plot-noise-card]"),
        helpButton: document.querySelector("#plot-help-button"),
        helpDialog: document.querySelector("#plot-help-dialog"),
        helpContent: document.querySelector("[data-plot-help-content]"),
        helpClose: document.querySelector("#plot-help-close"),
      };
    }

    bind() {
      this.dom.plotInput.accept = this.config.ACCEPTED_DATA_EXTENSIONS;
      populateMethodSelect(this.dom.trendMethod, TREND_METHODS);
      populateMethodSelect(this.dom.noiseMethod, NOISE_METHODS);
      renderParameterFields(this.dom.trendParams, TREND_METHODS[this.dom.trendMethod.value]);
      renderParameterFields(this.dom.noiseParams, NOISE_METHODS[this.dom.noiseMethod.value]);
      renderHelpContent(this.dom.helpContent);
      this.renderTrendStatus("No trend has been applied yet.");
      this.renderQualityDiagnostics(null);
      this.renderNoiseOutput(null);
      this.updateYSpanLabel();
      this.syncAvgOverlayOption();

      this.dom.plotInput.addEventListener("change", () => this.handleFileSelection());
      this.dom.plotAvgOnly.addEventListener("change", () => this.handleAvgOnlyChange());
      this.dom.trendMethod.addEventListener("change", () => {
        renderParameterFields(this.dom.trendParams, TREND_METHODS[this.dom.trendMethod.value]);
      });
      this.dom.noiseMethod.addEventListener("change", () => {
        renderParameterFields(this.dom.noiseParams, NOISE_METHODS[this.dom.noiseMethod.value]);
      });
      this.dom.showRawToggle.addEventListener("change", () => this.handleShowRawToggle());
      if (this.dom.plotYSpan) {
        this.dom.plotYSpan.addEventListener("input", () => this.handleYSpanChange());
      }
      if (this.dom.plotYMin) {
        this.dom.plotYMin.addEventListener("change", () => this.handleYRangeInputChange());
      }
      if (this.dom.plotYMax) {
        this.dom.plotYMax.addEventListener("change", () => this.handleYRangeInputChange());
      }
      this.dom.plotAnalyze.addEventListener("click", () => {
        this.withRuntime(() => this.runPlot())();
      });
      this.dom.plotMarkCompare.addEventListener("click", () => this.handleMarkForCompare());
      this.dom.plotReset.addEventListener("click", () => this.resetInputs());
      this.dom.trendApply.addEventListener("click", () => {
        this.withRuntime(() => this.applyTrend())();
      });
      this.dom.qualityAnalyze.addEventListener("click", () => {
        this.withRuntime(() => this.runQualityDiagnostics())();
      });
      this.dom.qualityExport.addEventListener("click", () => {
        this.exportQualityDiagnostics();
      });
      this.dom.noiseAnalyze.addEventListener("click", () => {
        this.withRuntime(() => this.runNoise())();
      });
      this.dom.plotExport.addEventListener("click", async () => {
        if (this.state.rawPayload) {
          await this.charts.exportPlotAsPng(this.dom.plotCanvas, "time-series-plot");
        }
      });
      this.dom.plotExportSvg.addEventListener("click", async () => {
        if (this.state.rawPayload) {
          await this.charts.exportPlotImage(this.dom.plotCanvas, "time-series-plot", { format: "svg" });
        }
      });
      this.dom.plotSendPublication.addEventListener("click", () => {
        this.sendToPublication(this.dom.plotCanvas, {
          sourceType: "time-series",
          sourceTitle: "Time-series plot",
          filenameBase: "time-series-publication",
        });
      });
      this.dom.noiseExport.addEventListener("click", async () => {
        if (this.state.noisePayload && this.state.noisePayload.plot) {
          await this.charts.exportPlotAsPng(this.dom.noiseCanvas, "noise-analysis-plot");
        }
      });
      this.dom.noiseExportSvg.addEventListener("click", async () => {
        if (this.state.noisePayload && this.state.noisePayload.plot) {
          await this.charts.exportPlotImage(this.dom.noiseCanvas, "noise-analysis-plot", { format: "svg" });
        }
      });
      this.dom.noiseSendPublication.addEventListener("click", () => {
        this.sendToPublication(this.dom.noiseCanvas, {
          sourceType: "noise",
          sourceTitle: "Noise analysis plot",
          filenameBase: "noise-analysis-publication",
        });
      });
      this.dom.helpButton.addEventListener("click", () => this.openHelp());
      this.dom.helpClose.addEventListener("click", () => this.closeHelp());
    }

    withRuntime(handler) {
      return async () => {
        if (!this.isRuntimeReady()) {
          this.showError("Python runtime is not ready yet. Wait for Runtime to become Ready, then try again.");
          return;
        }

        try {
          this.clearError();
          await handler();
        } catch (error) {
          this.showError(this.normalizeUiError(error));
        }
      };
    }

    handleFileSelection() {
      this.clearError();
      this.state.file = this.dom.plotInput.files[0] || null;
      this.state.rawPayload = null;
      this.state.trendPayload = null;
      this.state.trendRequest = null;
      this.state.noisePayload = null;
      this.state.qualityPayload = null;
      this.state.showRaw = true;
      this.state.manualYRange = null;
      this.dom.showRawToggle.checked = true;
      this.dom.plotMeta.textContent = this.describeFile(this.state.file);
      this.dom.plotExport.disabled = true;
      this.dom.plotExportSvg.disabled = true;
      this.dom.plotSendPublication.disabled = true;
      this.renderPlotSummary(null);
      this.renderTrendStatus("No trend has been applied yet.");
      this.renderQualityDiagnostics(null);
      this.renderNoiseOutput(null);
      this.resetYRangeControls();
      this.charts.clearPlot(this.dom.plotCanvas);
      this.charts.clearPlot(this.dom.noiseCanvas);
    }

    resetInputs() {
      const currentFile = this.state.file;
      this.clearError();

      this.state.rawPayload = null;
      this.state.trendPayload = null;
      this.state.trendRequest = null;
      this.state.noisePayload = null;
      this.state.qualityPayload = null;
      this.state.showRaw = true;
      this.state.manualYRange = null;

      this.dom.plotStart.value = "";
      this.dom.plotEnd.value = "";
      this.dom.plotExpRange.value = "";
      this.dom.plotAvgOnly.checked = false;
      this.dom.plotAvgShowOriginal.checked = false;
      this.syncAvgOverlayOption();

      const defaultTrendMethod = Object.keys(TREND_METHODS)[0];
      if (defaultTrendMethod) {
        this.dom.trendMethod.value = defaultTrendMethod;
        renderParameterFields(this.dom.trendParams, TREND_METHODS[defaultTrendMethod]);
      }
      this.dom.showRawToggle.checked = true;

      const defaultNoiseMethod = Object.keys(NOISE_METHODS)[0];
      if (defaultNoiseMethod) {
        this.dom.noiseMethod.value = defaultNoiseMethod;
        renderParameterFields(this.dom.noiseParams, NOISE_METHODS[defaultNoiseMethod]);
      }

      if (this.dom.plotYSpan) {
        this.dom.plotYSpan.value = "100";
      }
      this.updateYSpanLabel();
      this.resetYRangeControls();

      this.dom.plotMeta.textContent = this.describeFile(currentFile);
      this.dom.plotExport.disabled = true;
      this.dom.plotExportSvg.disabled = true;
      this.dom.plotSendPublication.disabled = true;
      this.renderPlotSummary(null);
      this.renderTrendStatus("No trend has been applied yet.");
      this.renderQualityDiagnostics(null);
      this.renderNoiseOutput(null);
      this.charts.clearPlot(this.dom.plotCanvas);
      this.charts.clearPlot(this.dom.noiseCanvas);
      this.setStatus(
        currentFile
          ? `Time Series inputs reset. ${currentFile.name} remains selected.`
          : "Time Series inputs reset."
      );
    }

    handleAvgOnlyChange() {
      this.syncAvgOverlayOption();
    }

    handleShowRawToggle() {
      this.state.showRaw = Boolean(this.dom.showRawToggle.checked);
      if (this.state.rawPayload) {
        this.renderCurrentPlot();
      }
    }

    handleMarkForCompare() {
      try {
        this.clearError();
        const curves = this.currentVisibleCompareCurves();
        if (!curves.length) {
          this.showError("No visible curves are available to mark. Analyze and plot data first.");
          return;
        }

        const result = this.onMarkForCompare ? this.onMarkForCompare(curves) : null;
        if (!result) {
          this.setStatus(`Marked ${curves.length} visible curve${curves.length === 1 ? "" : "s"} for Compare.`);
          return;
        }

        if (result.addedCount > 0) {
          const skippedText = result.skippedCount
            ? ` ${result.skippedCount} duplicate curve${result.skippedCount === 1 ? "" : "s"} skipped.`
            : "";
          this.setStatus(
            `Marked ${result.addedCount} curve${result.addedCount === 1 ? "" : "s"} for Compare.${skippedText}`
          );
        } else {
          this.showError("These visible curves are already in the Compare list.");
        }
      } catch (error) {
        this.showError(this.normalizeUiError(error));
      }
    }

    handleYSpanChange() {
      this.clearError();
      this.state.manualYRange = null;
      this.updateYSpanLabel();
      if (this.state.rawPayload) {
        this.renderCurrentPlot();
      }
    }

    async handleYRangeInputChange() {
      if (!this.state.rawPayload) {
        return;
      }

      const minText = this.dom.plotYMin ? this.dom.plotYMin.value.trim() : "";
      const maxText = this.dom.plotYMax ? this.dom.plotYMax.value.trim() : "";

      if (!minText && !maxText) {
        this.clearError();
        this.state.manualYRange = null;
        await this.renderCurrentPlot();
        return;
      }

      if (!minText || !maxText) {
        return;
      }

      const yMin = Number(minText);
      const yMax = Number(maxText);
      if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
        this.showError("Y-axis limits must be numeric values.");
        return;
      }
      if (yMax <= yMin) {
        this.showError("The upper y-axis limit must be greater than the lower limit.");
        return;
      }

      this.clearError();
      this.state.manualYRange = [yMin, yMax];
      this.syncYRangeInputs(this.state.manualYRange);
      await this.renderCurrentPlot();
    }

    describeFile(file) {
      if (!file) {
        return "No file selected yet.";
      }
      return `${file.name} · ${(file.size / 1024).toFixed(1)} KB · ready for local analysis`;
    }

    currentSelectionArgs() {
      return {
        startText: this.dom.plotStart.value,
        endText: this.dom.plotEnd.value,
        expRangeText: this.dom.plotExpRange.value,
        avgOnly: this.dom.plotAvgOnly.checked,
        showOriginalWithAvg: Boolean(
          this.dom.plotAvgOnly.checked &&
            this.dom.plotAvgShowOriginal &&
            this.dom.plotAvgShowOriginal.checked
        ),
      };
    }

    currentExperimentLabel() {
      return (
        this.dom.plotExpRange.value.trim() ||
        this.state.rawPayload.defaultExpRange ||
        this.state.rawPayload.expTag ||
        "all"
      );
    }

    buildCompareCurve(series, dataType, index) {
      const isTrend = dataType === "trend";
      const trendMethod = isTrend && this.state.trendPayload ? this.state.trendPayload.method.label : "";
      const trendParameters =
        isTrend && this.state.trendPayload ? { ...this.state.trendPayload.method.parameters } : {};

      return {
        sourceFileName: this.state.file ? this.state.file.name : "Unknown file",
        experimentRange: this.currentExperimentLabel(),
        expTag: this.state.rawPayload.expTag,
        rowRange: this.state.rawPayload.rowRange ? this.state.rawPayload.rowRange.slice() : [],
        selection: String(series.name || `Series ${index + 1}`),
        dataType,
        trendMethod,
        trendParameters,
        xLabel: this.state.rawPayload.xLabel,
        yLabel: "I.T. (mN/m)",
        x: cloneSeriesValues(series.x),
        y: cloneSeriesValues(series.y),
        points: Array.isArray(series.y) ? series.y.length : 0,
      };
    }

    currentVisibleCompareCurves() {
      if (!this.state.rawPayload) {
        return [];
      }

      const curves = [];
      if (!this.state.trendPayload || this.state.showRaw) {
        this.state.rawPayload.series.forEach((series, index) => {
          curves.push(this.buildCompareCurve(series, "raw", index));
        });
      }

      if (this.state.trendPayload) {
        this.state.trendPayload.series.forEach((series, index) => {
          curves.push(this.buildCompareCurve(series, "trend", index));
        });
      }

      const plottedTraces = Array.from(this.dom.plotCanvas.data || []);
      if (!plottedTraces.length) {
        return curves;
      }

      return curves.filter((curve, index) => {
        const trace = plottedTraces[index];
        return !trace || (trace.visible !== false && trace.visible !== "legendonly");
      });
    }

    syncAvgOverlayOption() {
      if (!this.dom.plotAvgShowOriginal) {
        return;
      }

      const enabled = Boolean(this.dom.plotAvgOnly.checked);
      this.dom.plotAvgShowOriginal.disabled = !enabled;
      if (!enabled) {
        this.dom.plotAvgShowOriginal.checked = false;
      }
    }

    ensureFileSelected() {
      if (!this.state.file) {
        throw new Error("Please choose a data file first.");
      }
    }

    currentYSpanPercent() {
      return this.dom.plotYSpan ? Number(this.dom.plotYSpan.value) || 100 : 100;
    }

    updateYSpanLabel() {
      if (!this.dom.plotYSpanValue) {
        return;
      }
      this.dom.plotYSpanValue.textContent = `${this.currentYSpanPercent()}%`;
    }

    currentAutoYRange() {
      if (!this.state.rawPayload) {
        return null;
      }

      return this.charts.resolveTimeSeriesYRange(this.state.rawPayload, {
        trendPayload: this.state.trendPayload,
        ySpanPercent: this.currentYSpanPercent(),
      });
    }

    syncYRangeInputs(range) {
      if (!this.dom.plotYMin || !this.dom.plotYMax) {
        return;
      }

      if (!range) {
        this.dom.plotYMin.value = "";
        this.dom.plotYMax.value = "";
        return;
      }

      this.dom.plotYMin.value = formatAxisRangeValue(range[0]);
      this.dom.plotYMax.value = formatAxisRangeValue(range[1]);
    }

    setYRangeInputsEnabled(enabled) {
      if (this.dom.plotYMin) {
        this.dom.plotYMin.disabled = !enabled;
      }
      if (this.dom.plotYMax) {
        this.dom.plotYMax.disabled = !enabled;
      }
    }

    resetYRangeControls() {
      this.setYRangeInputsEnabled(false);
      this.syncYRangeInputs(null);
    }

    async ensureFileDependencies() {
      const lowerName = this.state.file.name.toLowerCase();
      if (lowerName.endsWith(".xlsx")) {
        this.setStatus("Preparing XLSX reading support...");
        await this.pyodideClient.ensureOptionalPackages(this.config.OPTIONAL_PYTHON_PACKAGES.xlsx);
      } else if (lowerName.endsWith(".xls")) {
        this.setStatus("Preparing XLS reading support...");
        await this.pyodideClient.ensureOptionalPackages(this.config.OPTIONAL_PYTHON_PACKAGES.xls);
      }
    }

    async loadRawPayload() {
      this.ensureFileSelected();
      await this.ensureFileDependencies();
      const args = this.currentSelectionArgs();
      const staged = await this.pyodideClient.stageBrowserFile(this.state.file, "plot");

      try {
        const payload = await this.pyodideClient.callBridge(
          "analyze_plot_file",
          staged.fsPath,
          args.startText,
          args.endText,
          args.expRangeText,
          args.avgOnly,
          args.showOriginalWithAvg
        );
        this.state.rawPayload = payload;
        if (payload.defaultExpRange) {
          this.dom.plotExpRange.value = payload.defaultExpRange;
        }
        return payload;
      } finally {
        this.pyodideClient.removeFsFile(staged.fsPath);
      }
    }

    async runPlot() {
      this.state.trendPayload = null;
      this.state.trendRequest = null;
      this.state.noisePayload = null;
      this.state.showRaw = true;
      this.dom.showRawToggle.checked = true;
      this.renderTrendStatus("No trend has been applied yet.");
      this.renderNoiseOutput(null);

      const payload = await this.loadRawPayload();
      this.renderPlotSummary(payload);
      await this.renderCurrentPlot();
      this.dom.plotExport.disabled = false;
      this.dom.plotExportSvg.disabled = false;
      this.dom.plotSendPublication.disabled = false;
      this.setStatus(`Rendered ${payload.summary.seriesCount} series from ${this.state.file.name}.`);
    }

    async applyTrend() {
      const rawPayload = await this.loadRawPayload();
      const methodKey = this.dom.trendMethod.value;
      const methodDefinition = TREND_METHODS[methodKey];
      const parameters = collectParameters(this.dom.trendParams, methodDefinition);
      const args = this.currentSelectionArgs();
      const staged = await this.pyodideClient.stageBrowserFile(this.state.file, "plot-trend");

      try {
        const trendPayload = await this.pyodideClient.callBridge(
          "extract_plot_trend",
          staged.fsPath,
          args.startText,
          args.endText,
          args.expRangeText,
          args.avgOnly,
          methodKey,
          parameters,
          args.showOriginalWithAvg
        );

        this.state.rawPayload = rawPayload;
        this.state.trendPayload = trendPayload;
        this.state.trendRequest = { methodKey, parameters };
        this.state.noisePayload = null;
        this.renderNoiseOutput(null);
        this.renderPlotSummary(rawPayload);
        this.renderTrendStatus(trendPayload.summaryText);
        await this.renderCurrentPlot();
        this.dom.plotExport.disabled = false;
        this.dom.plotExportSvg.disabled = false;
        this.dom.plotSendPublication.disabled = false;
        this.setStatus(`${trendPayload.method.label} applied to ${this.state.file.name}.`);
      } finally {
        this.pyodideClient.removeFsFile(staged.fsPath);
      }
    }

    async runQualityDiagnostics() {
      if (!this.state.file) {
        throw new Error("Choose a data file before running data quality diagnostics.");
      }

      const args = this.currentSelectionArgs();
      const staged = await this.pyodideClient.stageBrowserFile(this.state.file, "plot-quality");

      try {
        const payload = await this.pyodideClient.callBridge(
          "analyze_time_series_quality",
          staged.fsPath,
          args.startText,
          args.endText,
          args.expRangeText,
          args.avgOnly,
          args.showOriginalWithAvg
        );
        this.state.qualityPayload = payload;
        this.renderQualityDiagnostics(payload);
        this.setStatus(`Data quality diagnostics completed for ${this.state.file.name}.`);
      } finally {
        this.pyodideClient.removeFsFile(staged.fsPath);
      }
    }

    async runNoise() {
      const rawPayload = await this.loadRawPayload();
      const methodKey = this.dom.noiseMethod.value;
      const methodDefinition = NOISE_METHODS[methodKey];
      const parameters = collectParameters(this.dom.noiseParams, methodDefinition);

      if (methodKey === "residual_std" && parameters.useTrend && !this.state.trendRequest) {
        throw new Error("Apply a trend first or disable trend-based residual analysis.");
      }
      if (
        methodKey === "psd" &&
        parameters.processingMode === "subtract_extracted_trend" &&
        !this.state.trendRequest
      ) {
        throw new Error("Apply a trend first before using PSD with 'Subtract extracted trend'.");
      }

      const args = this.currentSelectionArgs();
      const staged = await this.pyodideClient.stageBrowserFile(this.state.file, "plot-noise");

      try {
        const payload = await this.pyodideClient.callBridge(
          "analyze_plot_noise",
          staged.fsPath,
          args.startText,
          args.endText,
          args.expRangeText,
          args.avgOnly,
          methodKey,
          parameters,
          this.state.trendRequest,
          args.showOriginalWithAvg
        );

        this.state.rawPayload = rawPayload;
        this.state.noisePayload = payload;
        this.renderPlotSummary(rawPayload);
        await this.renderCurrentPlot();
        this.dom.plotExport.disabled = false;
        this.dom.plotExportSvg.disabled = false;
        this.dom.plotSendPublication.disabled = false;
        await this.renderNoiseOutput(payload);
        this.setStatus(`${payload.method.label} completed for ${this.state.file.name}.`);
      } finally {
        this.pyodideClient.removeFsFile(staged.fsPath);
      }
    }

    renderPlotSummary(payload) {
      if (!payload) {
        domUtils.clear(this.dom.plotSummary);
        return;
      }

      renderMetricCards(this.dom.plotSummary, [
        { label: "Rows", value: payload.summary.rows },
        { label: "Series", value: payload.summary.seriesCount },
        { label: "Row Range", value: payload.rowRange.join(" - ") },
        { label: "Selection", value: payload.expTag },
      ]);
    }

    renderTrendStatus(text) {
      this.dom.trendStatus.textContent = text;
    }

    renderQualityDiagnostics(payload) {
      this.state.qualityPayload = payload;
      domUtils.clear(this.dom.qualitySummary);
      domUtils.clear(this.dom.qualityWarnings);
      domUtils.clear(this.dom.qualityMetrics);
      domUtils.clear(this.dom.qualityActions);
      this.dom.qualityExport.disabled = !payload;

      if (!payload) {
        this.dom.qualityStatus.textContent = "No diagnostics have been run yet.";
        return;
      }

      this.dom.qualityStatus.textContent = payload.summary.message;
      renderMetricCards(this.dom.qualitySummary, [
        { label: "Status", value: payload.summary.status === "clean" ? "Clean" : "Warnings" },
        { label: "Rows", value: payload.summary.rowCount },
        { label: "Valid Rows", value: payload.summary.validRowCount },
        { label: "Series", value: payload.summary.seriesCount },
      ]);

      const warnings = payload.warnings || [];
      const warningMessages = warnings.map((warning) => {
        const severity = String(warning.severity || "info").toUpperCase();
        return `${severity}: ${warning.message}`;
      });
      this.dom.qualityWarnings.appendChild(renderTextList(
        "Warnings",
        warningMessages,
        "No warnings for the selected data."
      ));

      const metrics = payload.metrics || {};
      const sampling = metrics.samplingInterval || {};
      const rows = [
        { label: "Missing time values", value: metrics.missingTimeCount },
        { label: "Missing signal values", value: metrics.missingSignalValueCount },
        { label: "Duplicate time values", value: metrics.duplicateTimeCount },
        { label: "Non-monotonic intervals", value: metrics.nonMonotonicIntervalCount },
        { label: "Zero-length intervals", value: metrics.zeroIntervalCount },
        { label: "Median sampling interval", value: sampling.median },
        { label: "Minimum sampling interval", value: sampling.min },
        { label: "Maximum sampling interval", value: sampling.max },
        { label: "Irregular intervals", value: sampling.irregularCount },
        { label: "Large gaps", value: sampling.largeGapCount },
      ].map((row) => ({
        label: row.label,
        value: formatMetricValue(row.value),
      }));

      (metrics.signals || []).forEach((signal) => {
        rows.push({
          label: `${signal.series} valid points`,
          value: formatMetricValue(signal.validCount),
        });
        rows.push({
          label: `${signal.series} mean / std`,
          value: `${formatMetricValue(signal.mean)} / ${formatMetricValue(signal.std)}`,
        });
        rows.push({
          label: `${signal.series} min / max`,
          value: `${formatMetricValue(signal.min)} / ${formatMetricValue(signal.max)}`,
        });
        rows.push({
          label: `${signal.series} outliers`,
          value: formatMetricValue(signal.outlierCount),
        });
        rows.push({
          label: `${signal.series} near constant`,
          value: formatMetricValue(signal.nearConstant),
        });
      });

      this.dom.qualityMetrics.appendChild(renderKeyValueTable(rows));
      this.dom.qualityActions.appendChild(renderTextList(
        "Suggested Actions",
        payload.suggestedActions || [],
        "No suggested actions."
      ));
    }

    exportQualityDiagnostics() {
      if (!this.state.qualityPayload) {
        return;
      }

      const filenameBase = this.state.file
        ? this.state.file.name.replace(/\.[^.]+$/, "")
        : "time-series";
      const safeName = filenameBase
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "") || "time-series";
      downloads.downloadText(
        `${safeName}-data-quality.json`,
        JSON.stringify(this.state.qualityPayload, null, 2),
        "application/json;charset=utf-8"
      );
    }

    async renderCurrentPlot() {
      if (!this.state.rawPayload) {
        this.resetYRangeControls();
        this.charts.clearPlot(this.dom.plotCanvas);
        return;
      }

      const autoRange = this.currentAutoYRange();
      this.setYRangeInputsEnabled(true);
      if (!this.state.manualYRange) {
        this.syncYRangeInputs(autoRange);
      }

      await this.charts.renderTimeSeriesPlot(this.dom.plotCanvas, this.state.rawPayload, {
        trendPayload: this.state.trendPayload,
        showRaw: this.state.showRaw,
        ySpanPercent: this.currentYSpanPercent(),
        // The slider remains an automatic span tool. Manual input boxes can
        // override the plotted range without forcing the slider to re-sync.
        explicitYRange: this.state.manualYRange,
      });
    }

    async renderNoiseOutput(payload) {
      if (!payload) {
        this.dom.noiseSummary.textContent = "No noise analysis yet.";
        domUtils.clear(this.dom.noiseTable);
        this.dom.noiseCanvas.hidden = true;
        this.dom.noiseExport.disabled = true;
        this.dom.noiseExportSvg.disabled = true;
        this.dom.noiseSendPublication.disabled = true;
        this.charts.clearPlot(this.dom.noiseCanvas);
        return;
      }

      this.dom.noiseSummary.textContent = payload.summaryText;
      domUtils.replaceChildren(
        this.dom.noiseTable,
        buildSummaryTable(payload.summaryColumns, payload.summaryRows)
      );

      if (payload.plot) {
        this.dom.noiseCanvas.hidden = false;
        await this.charts.renderAnalysisPlot(this.dom.noiseCanvas, payload.plot);
        this.dom.noiseExport.disabled = false;
        this.dom.noiseExportSvg.disabled = false;
        this.dom.noiseSendPublication.disabled = false;
      } else {
        this.dom.noiseCanvas.hidden = true;
        this.dom.noiseExport.disabled = true;
        this.dom.noiseExportSvg.disabled = true;
        this.dom.noiseSendPublication.disabled = true;
        this.charts.clearPlot(this.dom.noiseCanvas);
      }
    }

    sendToPublication(plotElement, metadata) {
      if (!this.onSendToPublication) {
        this.showError("Publication Plot is not available.");
        return;
      }
      this.onSendToPublication(plotElement, metadata);
    }

    openHelp() {
      if (typeof this.dom.helpDialog.showModal === "function") {
        this.dom.helpDialog.showModal();
      } else {
        this.dom.helpDialog.setAttribute("open", "open");
      }
    }

    closeHelp() {
      if (typeof this.dom.helpDialog.close === "function") {
        this.dom.helpDialog.close();
      } else {
        this.dom.helpDialog.removeAttribute("open");
      }
    }

    getSessionState() {
      const trendDefinition = TREND_METHODS[this.dom.trendMethod.value];
      const noiseDefinition = NOISE_METHODS[this.dom.noiseMethod.value];
      return {
        file: this.state.file
          ? {
              name: this.state.file.name,
              size: this.state.file.size,
              type: this.state.file.type,
              lastModified: this.state.file.lastModified,
            }
          : null,
        selection: this.currentSelectionArgs(),
        trend: {
          methodKey: this.dom.trendMethod.value,
          parameters: trendDefinition ? collectParameters(this.dom.trendParams, trendDefinition) : {},
          showRaw: Boolean(this.dom.showRawToggle.checked),
          applied: Boolean(this.state.trendRequest),
        },
        noise: {
          methodKey: this.dom.noiseMethod.value,
          parameters: noiseDefinition ? collectParameters(this.dom.noiseParams, noiseDefinition) : {},
        },
        yAxis: {
          spanPercent: this.currentYSpanPercent(),
          manualRange: this.state.manualYRange ? this.state.manualYRange.slice() : null,
          yMinText: this.dom.plotYMin ? this.dom.plotYMin.value : "",
          yMaxText: this.dom.plotYMax ? this.dom.plotYMax.value : "",
        },
      };
    }

    restoreSessionState(sessionState) {
      const warnings = [];
      const input = isPlainObject(sessionState) ? sessionState : {};
      const selection = isPlainObject(input.selection) ? input.selection : {};
      const trend = isPlainObject(input.trend) ? input.trend : {};
      const noise = isPlainObject(input.noise) ? input.noise : {};
      const yAxis = isPlainObject(input.yAxis) ? input.yAxis : {};

      this.state.file = null;
      this.state.rawPayload = null;
      this.state.trendPayload = null;
      this.state.trendRequest = null;
      this.state.noisePayload = null;
      this.state.qualityPayload = null;
      this.state.showRaw = typeof trend.showRaw === "boolean" ? trend.showRaw : true;
      this.state.manualYRange = Array.isArray(yAxis.manualRange)
        ? yAxis.manualRange.map((value) => Number(value)).filter((value) => Number.isFinite(value)).slice(0, 2)
        : null;
      if (this.state.manualYRange && this.state.manualYRange.length !== 2) {
        this.state.manualYRange = null;
      }

      this.dom.plotInput.value = "";
      this.dom.plotStart.value = typeof selection.startText === "string" ? selection.startText : "";
      this.dom.plotEnd.value = typeof selection.endText === "string" ? selection.endText : "";
      this.dom.plotExpRange.value = typeof selection.expRangeText === "string" ? selection.expRangeText : "";
      this.dom.plotAvgOnly.checked = Boolean(selection.avgOnly);
      this.dom.plotAvgShowOriginal.checked = Boolean(selection.showOriginalWithAvg);
      this.syncAvgOverlayOption();

      if (typeof trend.methodKey === "string" && TREND_METHODS[trend.methodKey]) {
        this.dom.trendMethod.value = trend.methodKey;
      } else {
        warnings.push("Unsupported Time Series trend method was ignored.");
      }
      renderParameterFields(this.dom.trendParams, TREND_METHODS[this.dom.trendMethod.value]);
      applyParameters(this.dom.trendParams, TREND_METHODS[this.dom.trendMethod.value], trend.parameters);
      this.dom.showRawToggle.checked = this.state.showRaw;

      if (typeof noise.methodKey === "string" && NOISE_METHODS[noise.methodKey]) {
        this.dom.noiseMethod.value = noise.methodKey;
      } else {
        warnings.push("Unsupported Time Series noise method was ignored.");
      }
      renderParameterFields(this.dom.noiseParams, NOISE_METHODS[this.dom.noiseMethod.value]);
      applyParameters(this.dom.noiseParams, NOISE_METHODS[this.dom.noiseMethod.value], noise.parameters);

      if (this.dom.plotYSpan && Number.isFinite(Number(yAxis.spanPercent))) {
        this.dom.plotYSpan.value = String(yAxis.spanPercent);
      }
      this.updateYSpanLabel();
      this.resetYRangeControls();
      if (this.state.manualYRange) {
        this.syncYRangeInputs(this.state.manualYRange);
      }

      this.dom.plotMeta.textContent = input.file && input.file.name
        ? `Session restored settings for ${input.file.name}. Select the data file again to rerun analysis.`
        : "Session restored settings. Select a data file to rerun analysis.";
      this.dom.plotExport.disabled = true;
      this.dom.plotExportSvg.disabled = true;
      this.dom.plotSendPublication.disabled = true;
      this.renderPlotSummary(null);
      this.renderTrendStatus("Session settings restored. Apply analysis after selecting the data file.");
      this.renderQualityDiagnostics(null);
      this.renderNoiseOutput(null);
      this.charts.clearPlot(this.dom.plotCanvas);
      this.charts.clearPlot(this.dom.noiseCanvas);
      warnings.push("Time Series settings were restored, but local file selection must be repeated.");
      return warnings;
    }
  }

  window.SurfaceLabTimeSeriesModule = {
    createController(options) {
      return new TimeSeriesModuleController(options);
    },
  };
})();
