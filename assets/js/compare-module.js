(function () {
  const domUtils = window.SurfaceLabDomUtils;

  function formatTrendDetails(curve) {
    if (curve.dataType !== "trend") {
      return "";
    }

    const method = curve.trendMethod || "Trend";
    const params = curve.trendParameters || {};
    const paramText = Object.keys(params)
      .map((key) => `${key}: ${params[key]}`)
      .join(", ");
    return paramText ? `${method} (${paramText})` : method;
  }

  function stableStringify(value) {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }

    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  function buildDuplicateKey(curve) {
    return stableStringify({
      sourceFileName: curve.sourceFileName,
      experimentRange: curve.experimentRange,
      rowRange: curve.rowRange,
      selection: curve.selection,
      dataType: curve.dataType,
      trendMethod: curve.trendMethod,
      trendParameters: curve.trendParameters,
    });
  }

  function hasUsableSeries(curve) {
    if (!Array.isArray(curve.x) || !Array.isArray(curve.y) || curve.x.length !== curve.y.length) {
      return false;
    }
    return curve.y.some((value) => Number.isFinite(Number(value)));
  }

  function formatAxisRangeValue(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "";
    }
    return Math.abs(value) >= 1000 || (Math.abs(value) > 0 && Math.abs(value) < 0.01)
      ? value.toExponential(4)
      : value.toFixed(4).replace(/\.?0+$/, "");
  }

  function defaultDisplayLabel(curve) {
    return `#${curve.displayIndex}`;
  }

  function curveDisplayLabel(curve) {
    const label = String(curve.displayLabel || "").trim();
    return label || defaultDisplayLabel(curve);
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function numericArray(values) {
    if (!Array.isArray(values)) {
      return [];
    }
    return values.map((value) => {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? numberValue : null;
    });
  }

  function sanitizeImportedCurve(curve, fallbackIndex) {
    if (!curve || typeof curve !== "object") {
      return null;
    }
    const x = numericArray(curve.x);
    const y = numericArray(curve.y);
    if (!x.length || x.length !== y.length) {
      return null;
    }
    const displayIndex = Number.isFinite(Number(curve.displayIndex))
      ? Number(curve.displayIndex)
      : fallbackIndex;
    return {
      sourceFileName: String(curve.sourceFileName || "Imported session"),
      experimentRange: String(curve.experimentRange || ""),
      expTag: String(curve.expTag || ""),
      rowRange: Array.isArray(curve.rowRange) ? curve.rowRange.slice(0, 2) : [],
      selection: String(curve.selection || `Series ${fallbackIndex}`),
      dataType: String(curve.dataType || "raw"),
      trendMethod: String(curve.trendMethod || ""),
      trendParameters: curve.trendParameters && typeof curve.trendParameters === "object"
        ? cloneJson(curve.trendParameters)
        : {},
      xLabel: String(curve.xLabel || "Time"),
      yLabel: String(curve.yLabel || "I.T. (mN/m)"),
      x,
      y,
      points: y.length,
      displayIndex,
      displayLabel: String(curve.displayLabel || `#${displayIndex}`),
      createdAt: String(curve.createdAt || new Date().toISOString()),
    };
  }

  class CompareModuleController {
    constructor(options) {
      this.charts = options.charts;
      this.setStatus = options.setStatus;
      this.showError = options.showError;
      this.clearError = options.clearError;
      this.onSendToPublication = options.onSendToPublication;

      this.state = {
        curves: [],
        selectedIds: new Set(),
        nextId: 1,
        nextDisplayIndex: 1,
        lastPlottedIds: [],
        manualYRange: null,
        labelUpdateTimer: null,
      };

      this.dom = {
        tableBody: document.querySelector("[data-compare-table-body]"),
        emptyState: document.querySelector("[data-compare-empty]"),
        summary: document.querySelector("[data-compare-summary]"),
        canvas: document.querySelector("#compare-canvas"),
        plotButton: document.querySelector("#compare-plot"),
        exportButton: document.querySelector("#compare-export"),
        exportSvgButton: document.querySelector("#compare-export-svg"),
        sendPublicationButton: document.querySelector("#compare-send-publication"),
        removeSelectedButton: document.querySelector("#compare-remove-selected"),
        clearButton: document.querySelector("#compare-clear"),
        ySpan: document.querySelector("#compare-y-span"),
        ySpanValue: document.querySelector("[data-compare-y-span-value]"),
        yMin: document.querySelector("#compare-y-min"),
        yMax: document.querySelector("#compare-y-max"),
        selectAll: document.querySelector("#compare-select-all"),
      };
    }

    bind() {
      this.render();
      this.updateYSpanLabel();
      this.charts.clearPlot(this.dom.canvas);

      this.dom.tableBody.addEventListener("change", (event) => {
        const checkbox = event.target.closest("[data-compare-select-id]");
        if (!checkbox) {
          return;
        }

        const id = Number(checkbox.dataset.compareSelectId);
        if (checkbox.checked) {
          this.state.selectedIds.add(id);
        } else {
          this.state.selectedIds.delete(id);
        }
        this.state.lastPlottedIds = [];
        this.dom.exportButton.disabled = true;
        this.dom.exportSvgButton.disabled = true;
        this.dom.sendPublicationButton.disabled = true;
        this.syncYRangeInputsFromCurrentSelection();
        this.updateSelectAllState();
        this.renderSummary();
      });

      this.dom.tableBody.addEventListener("input", (event) => {
        const input = event.target.closest("[data-compare-label-id]");
        if (!input) {
          return;
        }

        this.handleDisplayLabelInput(input);
      });

      this.dom.tableBody.addEventListener("blur", (event) => {
        const input = event.target.closest("[data-compare-label-id]");
        if (!input) {
          return;
        }

        this.normalizeDisplayLabelInput(input);
      }, true);

      this.dom.selectAll.addEventListener("change", () => {
        if (this.dom.selectAll.checked) {
          this.state.curves.forEach((curve) => this.state.selectedIds.add(curve.id));
        } else {
          this.state.selectedIds.clear();
        }
        this.state.lastPlottedIds = [];
        this.dom.exportButton.disabled = true;
        this.dom.exportSvgButton.disabled = true;
        this.dom.sendPublicationButton.disabled = true;
        this.syncYRangeInputsFromCurrentSelection();
        this.render();
      });

      this.dom.tableBody.addEventListener("click", (event) => {
        const button = event.target.closest("[data-compare-remove-id]");
        if (!button) {
          return;
        }
        this.removeCurves([Number(button.dataset.compareRemoveId)]);
      });

      this.dom.plotButton.addEventListener("click", () => {
        this.plotSelected();
      });
      this.dom.removeSelectedButton.addEventListener("click", () => {
        this.removeCurves(Array.from(this.state.selectedIds));
      });
      this.dom.clearButton.addEventListener("click", () => {
        this.clearAll();
      });
      this.dom.exportButton.addEventListener("click", async () => {
        if (!this.state.lastPlottedIds.length) {
          return;
        }
        await this.charts.exportPlotAsPng(this.dom.canvas, "compare-curves");
      });
      this.dom.exportSvgButton.addEventListener("click", async () => {
        if (!this.state.lastPlottedIds.length) {
          return;
        }
        await this.charts.exportPlotImage(this.dom.canvas, "compare-curves", { format: "svg" });
      });
      this.dom.sendPublicationButton.addEventListener("click", () => {
        if (!this.state.lastPlottedIds.length) {
          return;
        }
        if (!this.onSendToPublication) {
          this.showError("Publication Plot is not available.");
          return;
        }
        this.onSendToPublication(this.dom.canvas, {
          sourceType: "compare",
          sourceTitle: "Compare plot",
          filenameBase: "compare-publication",
        });
      });
      this.dom.ySpan.addEventListener("input", () => {
        this.handleYSpanChange();
      });
      this.dom.yMin.addEventListener("change", () => {
        this.handleYRangeInputChange();
      });
      this.dom.yMax.addEventListener("change", () => {
        this.handleYRangeInputChange();
      });
    }

    handleYSpanChange() {
      this.clearError();
      this.state.manualYRange = null;
      this.updateYSpanLabel();
      this.syncYRangeInputsFromCurrentSelection();
      if (this.state.lastPlottedIds.length) {
        this.plotSelected({ quiet: true });
      }
    }

    async handleYRangeInputChange() {
      const minText = this.dom.yMin ? this.dom.yMin.value.trim() : "";
      const maxText = this.dom.yMax ? this.dom.yMax.value.trim() : "";

      if (!minText && !maxText) {
        this.clearError();
        this.state.manualYRange = null;
        this.syncYRangeInputsFromCurrentSelection();
        if (this.state.lastPlottedIds.length) {
          await this.plotSelected({ quiet: true });
        }
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
      if (this.state.lastPlottedIds.length) {
        await this.plotSelected({ quiet: true });
      }
    }

    addCurves(curves) {
      const duplicateKeys = new Set(this.state.curves.map((curve) => curve.duplicateKey));
      const added = [];
      let skipped = 0;

      curves.forEach((curve) => {
        const duplicateKey = buildDuplicateKey(curve);
        if (duplicateKeys.has(duplicateKey)) {
          skipped += 1;
          return;
        }

        duplicateKeys.add(duplicateKey);
        const id = this.state.nextId;
        const displayIndex = this.state.nextDisplayIndex;
        this.state.nextId += 1;
        this.state.nextDisplayIndex += 1;
        const markedCurve = {
          ...curve,
          id,
          displayIndex,
          displayLabel: `#${displayIndex}`,
          duplicateKey,
          createdAt: new Date().toISOString(),
        };
        this.state.curves.push(markedCurve);
        this.state.selectedIds.add(id);
        added.push(markedCurve);
      });

      this.state.lastPlottedIds = [];
      this.dom.exportButton.disabled = true;
      this.dom.exportSvgButton.disabled = true;
      this.dom.sendPublicationButton.disabled = true;
      this.setYRangeInputsEnabled(this.state.curves.length > 0);
      this.syncYRangeInputsFromCurrentSelection();
      this.render();
      return { addedCount: added.length, skippedCount: skipped, totalCount: curves.length };
    }

    selectedCurves() {
      return this.state.curves.filter((curve) => this.state.selectedIds.has(curve.id));
    }

    async plotSelected(options) {
      const opts = options || {};
      const selected = this.selectedCurves();
      if (!selected.length) {
        this.showError("Select at least one marked curve to compare.");
        return;
      }

      const valid = selected.filter(hasUsableSeries);
      const skipped = selected.length - valid.length;
      if (!valid.length) {
        this.showError("No selected curves contain usable numeric y-values.");
        return;
      }

      this.clearError();
      await this.charts.renderComparePlot(this.dom.canvas, valid, {
        xLabel: valid[0].xLabel || "Time",
        yLabel: valid[0].yLabel || "I.T. (mN/m)",
        ySpanPercent: this.currentYSpanPercent(),
        explicitYRange: this.state.manualYRange,
      });
      this.state.lastPlottedIds = valid.map((curve) => curve.id);
      this.dom.exportButton.disabled = false;
      this.dom.exportSvgButton.disabled = false;
      this.dom.sendPublicationButton.disabled = false;
      this.renderSummary(valid.length, skipped);
      if (!opts.quiet) {
        this.setStatus(`Compared ${valid.length} marked curve${valid.length === 1 ? "" : "s"}.`);
      }
      if (skipped > 0) {
        this.showError(`Skipped ${skipped} selected curve${skipped === 1 ? "" : "s"} with invalid data.`);
      }
    }

    handleDisplayLabelInput(input) {
      const id = Number(input.dataset.compareLabelId);
      const curve = this.state.curves.find((item) => item.id === id);
      if (!curve) {
        return;
      }

      curve.displayLabel = input.value.trim();

      if (this.state.lastPlottedIds.includes(id)) {
        window.clearTimeout(this.state.labelUpdateTimer);
        this.state.labelUpdateTimer = window.setTimeout(() => {
          this.plotSelected({ quiet: true });
        }, 120);
      }
    }

    normalizeDisplayLabelInput(input) {
      const id = Number(input.dataset.compareLabelId);
      const curve = this.state.curves.find((item) => item.id === id);
      if (!curve) {
        return;
      }

      curve.displayLabel = curveDisplayLabel(curve);
      input.value = curve.displayLabel;
    }

    cancelPendingLabelUpdate() {
      window.clearTimeout(this.state.labelUpdateTimer);
      this.state.labelUpdateTimer = null;
    }

    removeCurves(ids) {
      const idSet = new Set(ids.filter((id) => Number.isFinite(id)));
      if (!idSet.size) {
        this.showError("Select at least one marked curve to remove.");
        return;
      }

      this.cancelPendingLabelUpdate();
      this.state.curves = this.state.curves.filter((curve) => !idSet.has(curve.id));
      idSet.forEach((id) => this.state.selectedIds.delete(id));
      this.state.lastPlottedIds = [];
      this.dom.exportButton.disabled = true;
      this.dom.exportSvgButton.disabled = true;
      this.dom.sendPublicationButton.disabled = true;
      this.charts.clearPlot(this.dom.canvas);
      this.setYRangeInputsEnabled(this.state.curves.length > 0);
      this.syncYRangeInputsFromCurrentSelection();
      this.render();
      this.setStatus("Removed selected compare curve entries.");
    }

    clearAll() {
      this.cancelPendingLabelUpdate();
      this.state.curves = [];
      this.state.selectedIds.clear();
      this.state.lastPlottedIds = [];
      this.dom.exportButton.disabled = true;
      this.dom.exportSvgButton.disabled = true;
      this.dom.sendPublicationButton.disabled = true;
      this.charts.clearPlot(this.dom.canvas);
      this.state.manualYRange = null;
      this.setYRangeInputsEnabled(false);
      this.syncYRangeInputs(null);
      this.render();
      this.setStatus("Cleared compare list.");
    }

    currentYSpanPercent() {
      return this.dom.ySpan ? Number(this.dom.ySpan.value) || 100 : 100;
    }

    updateYSpanLabel() {
      if (this.dom.ySpanValue) {
        this.dom.ySpanValue.textContent = `${this.currentYSpanPercent()}%`;
      }
    }

    currentAutoYRange() {
      const selected = this.selectedCurves().filter(hasUsableSeries);
      if (!selected.length || !this.charts.resolveSeriesYRange) {
        return null;
      }
      return this.charts.resolveSeriesYRange(selected, {
        ySpanPercent: this.currentYSpanPercent(),
      });
    }

    syncYRangeInputs(range) {
      if (!this.dom.yMin || !this.dom.yMax) {
        return;
      }

      if (!range) {
        this.dom.yMin.value = "";
        this.dom.yMax.value = "";
        return;
      }

      this.dom.yMin.value = formatAxisRangeValue(range[0]);
      this.dom.yMax.value = formatAxisRangeValue(range[1]);
    }

    syncYRangeInputsFromCurrentSelection() {
      if (!this.state.manualYRange) {
        this.syncYRangeInputs(this.currentAutoYRange());
      }
    }

    setYRangeInputsEnabled(enabled) {
      if (this.dom.yMin) {
        this.dom.yMin.disabled = !enabled;
      }
      if (this.dom.yMax) {
        this.dom.yMax.disabled = !enabled;
      }
    }

    updateSelectAllState() {
      if (!this.dom.selectAll) {
        return;
      }

      const marked = this.state.curves.length;
      const selected = this.state.curves.filter((curve) => this.state.selectedIds.has(curve.id)).length;
      this.dom.selectAll.disabled = marked === 0;
      this.dom.selectAll.checked = marked > 0 && selected === marked;
      this.dom.selectAll.indeterminate = selected > 0 && selected < marked;
    }

    renderSummary(plottedCount, skippedCount) {
      const marked = this.state.curves.length;
      const selected = this.state.selectedIds.size;
      const plotted = typeof plottedCount === "number" ? plottedCount : this.state.lastPlottedIds.length;
      const skipped = skippedCount || 0;
      domUtils.replaceChildren(this.dom.summary, [
        domUtils.metricCard("Marked", marked),
        domUtils.metricCard("Selected", selected),
        domUtils.metricCard("Plotted", plotted),
        domUtils.metricCard("Skipped", skipped),
      ]);
    }

    render() {
      this.dom.emptyState.hidden = this.state.curves.length > 0;
      domUtils.clear(this.dom.tableBody);

      this.state.curves.forEach((curve) => {
        const selectInput = domUtils.el("input", {
          attrs: {
            type: "checkbox",
            "data-compare-select-id": curve.id,
            "aria-label": "Select compare curve " + curveDisplayLabel(curve),
          },
          props: { checked: this.state.selectedIds.has(curve.id) },
        });
        const labelInput = domUtils.el("input", {
          className: "table-input compare-index-input",
          attrs: {
            type: "text",
            "data-compare-label-id": curve.id,
            "aria-label": "Compare curve label " + defaultDisplayLabel(curve),
          },
          props: { value: curveDisplayLabel(curve) },
        });
        const removeButton = domUtils.el("button", {
          className: "ghost-button compact-button",
          text: "Remove",
          attrs: {
            type: "button",
            "data-compare-remove-id": curve.id,
          },
        });

        const tr = domUtils.el("tr", {}, [
          domUtils.el("td", {}, [selectInput]),
          domUtils.el("td", {}, [labelInput]),
          domUtils.el("td", {}, [
            domUtils.el("span", { className: "table-file", text: "[" + curve.sourceFileName + "]" }),
          ]),
          domUtils.el("td", { text: curve.experimentRange || "—" }),
          domUtils.el("td", { text: curve.selection || "—" }),
          domUtils.el("td", { text: curve.dataType || "raw" }),
          domUtils.el("td", { text: formatTrendDetails(curve) || "—" }),
          domUtils.el("td", { text: curve.points || 0 }),
          domUtils.el("td", {}, [removeButton]),
        ]);
        this.dom.tableBody.appendChild(tr);
      });

      this.renderSummary();
      this.updateSelectAllState();
    }

    getSessionState() {
      const curves = this.state.curves.map((curve) => {
        const copy = cloneJson(curve);
        delete copy.id;
        delete copy.duplicateKey;
        return copy;
      });
      const idToDisplay = new Map(this.state.curves.map((curve) => [curve.id, curve.displayIndex]));
      return {
        curves,
        selectedDisplayIndexes: Array.from(this.state.selectedIds)
          .map((id) => idToDisplay.get(id))
          .filter((value) => typeof value === "number"),
        lastPlottedDisplayIndexes: this.state.lastPlottedIds
          .map((id) => idToDisplay.get(id))
          .filter((value) => typeof value === "number"),
        yAxis: {
          spanPercent: this.currentYSpanPercent(),
          manualRange: this.state.manualYRange ? this.state.manualYRange.slice() : null,
          yMinText: this.dom.yMin ? this.dom.yMin.value : "",
          yMaxText: this.dom.yMax ? this.dom.yMax.value : "",
        },
      };
    }

    async restoreSessionState(sessionState) {
      const warnings = [];
      const input = sessionState && typeof sessionState === "object" ? sessionState : {};
      const importedCurves = Array.isArray(input.curves) ? input.curves : [];
      const curves = importedCurves
        .map((curve, index) => sanitizeImportedCurve(curve, index + 1))
        .filter(Boolean);
      if (curves.length !== importedCurves.length) {
        warnings.push("Some Compare curves were skipped because their x/y data was missing or invalid.");
      }

      this.cancelPendingLabelUpdate();
      this.state.curves = [];
      this.state.selectedIds.clear();
      this.state.lastPlottedIds = [];
      this.state.nextId = 1;
      this.state.nextDisplayIndex = 1;

      curves.forEach((curve) => {
        const id = this.state.nextId;
        this.state.nextId += 1;
        this.state.nextDisplayIndex = Math.max(this.state.nextDisplayIndex, curve.displayIndex + 1);
        this.state.curves.push({
          ...curve,
          id,
          duplicateKey: buildDuplicateKey(curve),
        });
      });

      const selectedIndexes = new Set(
        Array.isArray(input.selectedDisplayIndexes) ? input.selectedDisplayIndexes.map(Number) : []
      );
      this.state.curves.forEach((curve) => {
        if (!selectedIndexes.size || selectedIndexes.has(curve.displayIndex)) {
          this.state.selectedIds.add(curve.id);
        }
      });

      const yAxis = input.yAxis && typeof input.yAxis === "object" ? input.yAxis : {};
      if (this.dom.ySpan && Number.isFinite(Number(yAxis.spanPercent))) {
        this.dom.ySpan.value = String(yAxis.spanPercent);
      }
      this.updateYSpanLabel();
      this.state.manualYRange = Array.isArray(yAxis.manualRange)
        ? yAxis.manualRange.map((value) => Number(value)).filter((value) => Number.isFinite(value)).slice(0, 2)
        : null;
      if (this.state.manualYRange && this.state.manualYRange.length !== 2) {
        this.state.manualYRange = null;
      }

      this.setYRangeInputsEnabled(this.state.curves.length > 0);
      this.syncYRangeInputs(this.state.manualYRange || this.currentAutoYRange());
      this.render();
      this.dom.exportButton.disabled = true;
      this.dom.exportSvgButton.disabled = true;
      this.dom.sendPublicationButton.disabled = true;

      if (this.selectedCurves().filter(hasUsableSeries).length) {
        await this.plotSelected({ quiet: true });
      } else {
        this.charts.clearPlot(this.dom.canvas);
      }
      return warnings;
    }
  }

  window.SurfaceLabCompareModule = {
    createController(options) {
      return new CompareModuleController(options);
    },
  };
})();
