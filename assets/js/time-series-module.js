(function () {
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

  function buildOptionsHtml(definitionMap) {
    return Object.keys(definitionMap)
      .map((key) => `<option value="${key}">${definitionMap[key].label}</option>`)
      .join("");
  }

  function renderParameterFields(container, definition) {
    container.innerHTML = "";

    if (!definition.params.length) {
      container.innerHTML = '<div class="info-box">No additional parameters.</div>';
      return;
    }

    definition.params.forEach((param) => {
      if (param.type === "checkbox") {
        const label = document.createElement("label");
        label.className = "checkbox-row checkbox-row-compact";
        label.innerHTML = `
          <input
            type="checkbox"
            data-param-key="${param.key}"
            ${param.defaultValue ? "checked" : ""}
          />
          ${param.label}
        `;
        container.appendChild(label);
        return;
      }

      const field = document.createElement("div");
      field.className = "field";

      if (param.type === "select") {
        field.innerHTML = `
          <label>${param.label}</label>
          <select data-param-key="${param.key}">
            ${param.options
              .map(
                (option) =>
                  `<option value="${option.value}"${
                    option.value === param.defaultValue ? " selected" : ""
                  }>${option.label}</option>`
              )
              .join("")}
          </select>
        `;
      } else {
        field.innerHTML = `
          <label>${param.label}</label>
          <input
            type="${param.type === "number" ? "number" : "text"}"
            data-param-key="${param.key}"
            value="${param.defaultValue || ""}"
            ${param.placeholder ? `placeholder="${param.placeholder}"` : ""}
            ${param.min ? `min="${param.min}"` : ""}
            ${param.step ? `step="${param.step}"` : ""}
          />
        `;
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

  function buildHelpHtml() {
    const buildSection = (title, methods) => {
      return `
        <section class="help-section">
          <h3>${title}</h3>
          ${Object.keys(methods)
            .map((key) => {
              const item = methods[key];
              return `
                <div class="help-item">
                  <h4>${item.label}</h4>
                  <p><strong>Principle:</strong> ${item.help.principle}</p>
                  <p><strong>Useful for:</strong> ${item.help.use}</p>
                  <p><strong>Interpretation:</strong> ${item.help.interpret}</p>
                </div>
              `;
            })
            .join("")}
        </section>
      `;
    };

    return buildSection("Trend Extraction", TREND_METHODS) + buildSection("Noise Analysis", NOISE_METHODS);
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

      this.state = {
        file: null,
        rawPayload: null,
        trendPayload: null,
        trendRequest: null,
        noisePayload: null,
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
        plotAnalyze: document.querySelector("#plot-run"),
        plotExport: document.querySelector("#plot-export"),
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
        noiseMethod: document.querySelector("#plot-noise-method"),
        noiseParams: document.querySelector("#plot-noise-params"),
        noiseAnalyze: document.querySelector("#plot-noise-run"),
        noiseSummary: document.querySelector("[data-plot-noise-summary]"),
        noiseTable: document.querySelector("[data-plot-noise-table]"),
        noiseCanvas: document.querySelector("#plot-noise-canvas"),
        noiseCard: document.querySelector("[data-plot-noise-card]"),
        helpButton: document.querySelector("#plot-help-button"),
        helpDialog: document.querySelector("#plot-help-dialog"),
        helpContent: document.querySelector("[data-plot-help-content]"),
        helpClose: document.querySelector("#plot-help-close"),
      };
    }

    bind() {
      this.dom.plotInput.accept = this.config.ACCEPTED_DATA_EXTENSIONS;
      this.dom.trendMethod.innerHTML = buildOptionsHtml(TREND_METHODS);
      this.dom.noiseMethod.innerHTML = buildOptionsHtml(NOISE_METHODS);
      renderParameterFields(this.dom.trendParams, TREND_METHODS[this.dom.trendMethod.value]);
      renderParameterFields(this.dom.noiseParams, NOISE_METHODS[this.dom.noiseMethod.value]);
      this.dom.helpContent.innerHTML = buildHelpHtml();
      this.renderTrendStatus("No trend has been applied yet.");
      this.renderNoiseOutput(null);
      this.updateYSpanLabel();

      this.dom.plotInput.addEventListener("change", () => this.handleFileSelection());
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
      this.dom.trendApply.addEventListener("click", () => {
        this.withRuntime(() => this.applyTrend())();
      });
      this.dom.noiseAnalyze.addEventListener("click", () => {
        this.withRuntime(() => this.runNoise())();
      });
      this.dom.plotExport.addEventListener("click", async () => {
        if (this.state.rawPayload) {
          await this.charts.exportPlotAsPng(this.dom.plotCanvas, "time-series-plot");
        }
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
      this.state.showRaw = true;
      this.state.manualYRange = null;
      this.dom.showRawToggle.checked = true;
      this.dom.plotMeta.textContent = this.describeFile(this.state.file);
      this.dom.plotExport.disabled = true;
      this.renderPlotSummary(null);
      this.renderTrendStatus("No trend has been applied yet.");
      this.renderNoiseOutput(null);
      this.resetYRangeControls();
      this.charts.clearPlot(this.dom.plotCanvas);
      this.charts.clearPlot(this.dom.noiseCanvas);
    }

    handleShowRawToggle() {
      this.state.showRaw = Boolean(this.dom.showRawToggle.checked);
      if (this.state.rawPayload) {
        this.renderCurrentPlot();
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
      };
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
          args.avgOnly
        );
        this.state.rawPayload = payload;
        if (!this.dom.plotExpRange.value && payload.defaultExpRange) {
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
          parameters
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
        this.setStatus(`${trendPayload.method.label} applied to ${this.state.file.name}.`);
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
          this.state.trendRequest
        );

        this.state.rawPayload = rawPayload;
        this.state.noisePayload = payload;
        this.renderPlotSummary(rawPayload);
        await this.renderCurrentPlot();
        await this.renderNoiseOutput(payload);
        this.setStatus(`${payload.method.label} completed for ${this.state.file.name}.`);
      } finally {
        this.pyodideClient.removeFsFile(staged.fsPath);
      }
    }

    renderPlotSummary(payload) {
      this.dom.plotSummary.innerHTML = payload
        ? `
          <div class="metric-card"><span>Rows</span><strong>${payload.summary.rows}</strong></div>
          <div class="metric-card"><span>Series</span><strong>${payload.summary.seriesCount}</strong></div>
          <div class="metric-card"><span>Row Range</span><strong>${payload.rowRange.join(" - ")}</strong></div>
          <div class="metric-card"><span>Selection</span><strong>${payload.expTag}</strong></div>
        `
        : "";
    }

    renderTrendStatus(text) {
      this.dom.trendStatus.textContent = text;
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

    buildSummaryTable(columns, rows) {
      if (!rows.length) {
        return '<div class="empty-state">No summary data available.</div>';
      }

      const header = columns.map((column) => `<th>${column}</th>`).join("");
      const body = rows
        .map(
          (row) =>
            `<tr>${columns
              .map((column) => `<td>${formatValue(row[column])}</td>`)
              .join("")}</tr>`
        )
        .join("");

      return `
        <div class="table-scroll">
          <table>
            <thead><tr>${header}</tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      `;
    }

    async renderNoiseOutput(payload) {
      if (!payload) {
        this.dom.noiseSummary.textContent = "No noise analysis yet.";
        this.dom.noiseTable.innerHTML = "";
        this.dom.noiseCanvas.hidden = true;
        this.charts.clearPlot(this.dom.noiseCanvas);
        return;
      }

      this.dom.noiseSummary.textContent = payload.summaryText;
      this.dom.noiseTable.innerHTML = this.buildSummaryTable(
        payload.summaryColumns,
        payload.summaryRows
      );

      if (payload.plot) {
        this.dom.noiseCanvas.hidden = false;
        await this.charts.renderAnalysisPlot(this.dom.noiseCanvas, payload.plot);
      } else {
        this.dom.noiseCanvas.hidden = true;
        this.charts.clearPlot(this.dom.noiseCanvas);
      }
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
  }

  window.SurfaceLabTimeSeriesModule = {
    createController(options) {
      return new TimeSeriesModuleController(options);
    },
  };
})();
