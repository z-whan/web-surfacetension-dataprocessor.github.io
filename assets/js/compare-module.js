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
      yAxis: curve.yAxis,
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

  function nullableNumericArray(values) {
    if (!Array.isArray(values)) {
      return [];
    }
    return values.map((value) => {
      if (value === null || typeof value === "undefined" || value === "") {
        return null;
      }
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
    const error = Array.isArray(curve.error) ? nullableNumericArray(curve.error) : null;
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
      yAxis: String(curve.yAxis || "y"),
      trendMethod: String(curve.trendMethod || ""),
      trendParameters: curve.trendParameters && typeof curve.trendParameters === "object"
        ? cloneJson(curve.trendParameters)
        : {},
      xLabel: String(curve.xLabel || "Time"),
      yLabel: String(curve.yLabel || "I.T. (mN/m)"),
      x,
      y,
      error,
      errorKind: String(curve.errorKind || ""),
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
        plotStyle: "raw",
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
        clearMenu: document.querySelector("#compare-clear-menu"),
        clearAllButton: document.querySelector("#compare-clear-all"),
        removeUnselectedButton: document.querySelector("#compare-remove-unselected"),
        orderStatus: document.querySelector("[data-compare-order-status]"),
        ySpan: document.querySelector("#compare-y-span"),
        ySpanValue: document.querySelector("[data-compare-y-span-value]"),
        yMin: document.querySelector("#compare-y-min"),
        yMax: document.querySelector("#compare-y-max"),
        selectAll: document.querySelector("#compare-select-all"),
        scientificStyle: document.querySelector("#compare-line-style"),
      };
    }

    bind() {
      const defaults = window.SurfaceLabSettings.get();
      this.state.plotStyle = defaults.defaultPlotStyle;
      this.dom.scientificStyle.value = this.state.plotStyle;
      this.dom.ySpan.value = String(defaults.ySpanPercent);
      this.bindReordering();
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
      this.dom.scientificStyle.addEventListener("change", () => {
        this.state.plotStyle = this.dom.scientificStyle.value;
        if (this.state.lastPlottedIds.length) this.plotSelected({ quiet: true });
        this.setStatus(this.state.plotStyle === "band"
          ? "Shaded band: ±1 replicate SD when available; otherwise local residual SD (noise estimate)."
          : this.state.plotStyle === "error-bars" ? "Smooth + Error Bars enabled." : "Point-to-point compare style restored.");
      });
      this.dom.removeSelectedButton.addEventListener("click", () => {
        this.closeClearMenu();
        this.removeCurves(Array.from(this.state.selectedIds));
      });
      this.dom.removeUnselectedButton.addEventListener("click", () => {
        this.closeClearMenu();
        const ids = this.state.curves.filter((curve) => !this.state.selectedIds.has(curve.id)).map((curve) => curve.id);
        this.removeCurves(ids);
      });
      this.dom.clearAllButton.addEventListener("click", () => {
        this.closeClearMenu();
        this.clearAll();
      });
      this.dom.clearButton.addEventListener("click", () => {
        this.dom.clearMenu.hidden = !this.dom.clearMenu.hidden;
        this.dom.clearButton.setAttribute("aria-expanded", String(!this.dom.clearMenu.hidden));
      });
      document.addEventListener("click", (event) => {
        if (!event.target.closest(".clear-menu-wrapper")) this.closeClearMenu();
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !this.dom.clearMenu.hidden) {
          this.closeClearMenu();
          this.dom.clearButton.focus();
        }
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

    closeClearMenu() {
      this.dom.clearMenu.hidden = true;
      this.dom.clearButton.setAttribute("aria-expanded", "false");
    }

    bindReordering() {
      const body = this.dom.tableBody;
      const clearDrag = () => {
        this.pointerDrag = null;
        body.querySelectorAll(".drag-over, .dragging").forEach((row) => row.classList.remove("drag-over", "dragging"));
      };
      body.addEventListener("pointerdown", (event) => {
        const handle = event.target.closest("[data-compare-drag-id]");
        if (!handle || event.button !== 0) return;
        this.pointerDrag = { id: Number(handle.dataset.compareDragId), pointerId: event.pointerId,
          startX: event.clientX, startY: event.clientY, moved: false };
        handle.setPointerCapture(event.pointerId);
      });
      body.addEventListener("pointermove", (event) => {
        const drag = this.pointerDrag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5 && !drag.moved) return;
        drag.moved = true;
        event.preventDefault();
        body.querySelectorAll(".drag-over").forEach((row) => row.classList.remove("drag-over"));
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-compare-row-id]");
        if (row && body.contains(row)) row.classList.add("drag-over");
        body.querySelector(`[data-compare-row-id="${drag.id}"]`)?.classList.add("dragging");
      });
      body.addEventListener("pointerup", (event) => {
        const drag = this.pointerDrag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-compare-row-id]");
        clearDrag();
        if (!drag.moved || !row || !body.contains(row)) return;
        const rect = row.getBoundingClientRect();
        this.reorderCurve(drag.id, Number(row.dataset.compareRowId), event.clientY > rect.top + rect.height / 2);
      });
      body.addEventListener("pointercancel", clearDrag);
      body.addEventListener("lostpointercapture", clearDrag);
      body.addEventListener("click", (event) => {
        const button = event.target.closest("[data-compare-move-id]");
        if (!button) return;
        const id = Number(button.dataset.compareMoveId);
        const direction = Number(button.dataset.compareMoveDirection);
        const index = this.state.curves.findIndex((curve) => curve.id === id);
        const target = this.state.curves[index + direction];
        if (target) this.reorderCurve(id, target.id, direction > 0);
        const replacement = body.querySelector(`[data-compare-move-id="${id}"][data-compare-move-direction="${direction}"]`);
        if (replacement && !replacement.disabled) replacement.focus();
        else body.querySelector(`[data-compare-drag-id="${id}"]`).focus();
      });
    }

    reorderCurve(id, targetId, after) {
      if (id === targetId) return;
      const source = this.state.curves.findIndex((curve) => curve.id === id);
      if (source < 0 || !this.state.curves.some((curve) => curve.id === targetId)) return;
      this.cancelPendingLabelUpdate();
      const [curve] = this.state.curves.splice(source, 1);
      const destination = this.state.curves.findIndex((item) => item.id === targetId);
      this.state.curves.splice(destination + (after ? 1 : 0), 0, curve);
      this.render();
      this.dom.orderStatus.textContent = `${curveDisplayLabel(curve)} moved to position ${this.state.curves.indexOf(curve) + 1}. Legend order updated.`;
      if (this.state.lastPlottedIds.length) this.plotSelected({ quiet: true });
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
        secondaryYLabel: "Droplet volume, V (μL)",
        ySpanPercent: this.currentYSpanPercent(),
        explicitYRange: this.state.manualYRange,
        plotStyle: this.state.plotStyle,
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
      this.setStatus(`Removed ${idSet.size} compare curve ${idSet.size === 1 ? "entry" : "entries"}.`);
    }

    clearAll() {
      this.cancelPendingLabelUpdate();
      this.closeClearMenu();
      this.dom.orderStatus.textContent = "";
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
      const primary = selected.filter((curve) => curve.dataType !== "volume" && curve.yAxis !== "y2");
      let rangeSeries = primary.length ? primary : selected;
      if (primary.length && this.state.plotStyle !== "raw" && this.charts.scientificRangeSeries) {
        rangeSeries = this.charts.scientificRangeSeries(
          primary.filter((curve) => curve.dataType !== "trend"), this.state.plotStyle
        ).concat(primary.filter((curve) => curve.dataType === "trend"));
      }
      return this.charts.resolveSeriesYRange(rangeSeries, {
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
      this.dom.removeSelectedButton.disabled = selected === 0;
      this.dom.removeUnselectedButton.disabled = selected === marked;
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

      this.state.curves.forEach((curve, index) => {
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

        const orderControls = domUtils.el("div", { className: "curve-order-controls" }, [
          domUtils.el("button", {
            className: "curve-drag-handle", text: "⠿",
            attrs: { type: "button", draggable: "false", "data-compare-drag-id": curve.id,
              "aria-label": "Drag to reorder " + curveDisplayLabel(curve), title: "Drag to reorder" },
          }),
          ...[-1, 1].map((direction) => domUtils.el("button", {
            className: "ghost-button compact-button", text: direction < 0 ? "↑" : "↓",
            attrs: { type: "button", "data-compare-move-id": curve.id, "data-compare-move-direction": direction,
              "aria-label": `Move ${curveDisplayLabel(curve)} ${direction < 0 ? "up" : "down"}` },
            props: { disabled: direction < 0 ? index === 0 : index === this.state.curves.length - 1 },
          })),
        ]);
        const tr = domUtils.el("tr", { attrs: { "data-compare-row-id": curve.id } }, [
          domUtils.el("td", {}, [selectInput]),
          domUtils.el("td", {}, [orderControls]),
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
      this.dom.clearButton.disabled = !this.state.curves.length;
      this.dom.clearAllButton.disabled = !this.state.curves.length;
      this.dom.removeSelectedButton.disabled = !this.state.selectedIds.size;
      this.dom.removeUnselectedButton.disabled = this.state.curves.every((curve) => this.state.selectedIds.has(curve.id));
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
        plotStyle: {
          mode: this.state.plotStyle,
          scientificStyle: this.state.plotStyle !== "raw",
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
      this.closeClearMenu();
      this.dom.orderStatus.textContent = "";
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
        if (!Array.isArray(input.selectedDisplayIndexes) || selectedIndexes.has(curve.displayIndex)) {
          this.state.selectedIds.add(curve.id);
        }
      });

      const yAxis = input.yAxis && typeof input.yAxis === "object" ? input.yAxis : {};
      const plotStyle = input.plotStyle && typeof input.plotStyle === "object" ? input.plotStyle : {};
      this.state.plotStyle = this.charts.normalizePlotStyle(plotStyle.mode, plotStyle.scientificStyle);
      this.dom.scientificStyle.value = this.state.plotStyle;
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
