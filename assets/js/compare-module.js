(function () {
  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

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

  class CompareModuleController {
    constructor(options) {
      this.charts = options.charts;
      this.setStatus = options.setStatus;
      this.showError = options.showError;
      this.clearError = options.clearError;

      this.state = {
        curves: [],
        selectedIds: new Set(),
        nextId: 1,
        nextDisplayIndex: 1,
        lastPlottedIds: [],
      };

      this.dom = {
        tableBody: document.querySelector("[data-compare-table-body]"),
        emptyState: document.querySelector("[data-compare-empty]"),
        summary: document.querySelector("[data-compare-summary]"),
        canvas: document.querySelector("#compare-canvas"),
        plotButton: document.querySelector("#compare-plot"),
        exportButton: document.querySelector("#compare-export"),
        removeSelectedButton: document.querySelector("#compare-remove-selected"),
        clearButton: document.querySelector("#compare-clear"),
        ySpan: document.querySelector("#compare-y-span"),
        ySpanValue: document.querySelector("[data-compare-y-span-value]"),
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
        this.renderSummary();
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
      this.dom.ySpan.addEventListener("input", () => {
        this.updateYSpanLabel();
        if (this.state.lastPlottedIds.length) {
          this.plotSelected({ quiet: true });
        }
      });
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
          duplicateKey,
          createdAt: new Date().toISOString(),
        };
        this.state.curves.push(markedCurve);
        this.state.selectedIds.add(id);
        added.push(markedCurve);
      });

      this.state.lastPlottedIds = [];
      this.dom.exportButton.disabled = true;
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
      });
      this.state.lastPlottedIds = valid.map((curve) => curve.id);
      this.dom.exportButton.disabled = false;
      this.renderSummary(valid.length, skipped);
      if (!opts.quiet) {
        this.setStatus(`Compared ${valid.length} marked curve${valid.length === 1 ? "" : "s"}.`);
      }
      if (skipped > 0) {
        this.showError(`Skipped ${skipped} selected curve${skipped === 1 ? "" : "s"} with invalid data.`);
      }
    }

    removeCurves(ids) {
      const idSet = new Set(ids.filter((id) => Number.isFinite(id)));
      if (!idSet.size) {
        this.showError("Select at least one marked curve to remove.");
        return;
      }

      this.state.curves = this.state.curves.filter((curve) => !idSet.has(curve.id));
      idSet.forEach((id) => this.state.selectedIds.delete(id));
      this.state.lastPlottedIds = [];
      this.dom.exportButton.disabled = true;
      this.charts.clearPlot(this.dom.canvas);
      this.render();
      this.setStatus("Removed selected compare curve entries.");
    }

    clearAll() {
      this.state.curves = [];
      this.state.selectedIds.clear();
      this.state.lastPlottedIds = [];
      this.dom.exportButton.disabled = true;
      this.charts.clearPlot(this.dom.canvas);
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

    renderSummary(plottedCount, skippedCount) {
      const marked = this.state.curves.length;
      const selected = this.state.selectedIds.size;
      const plotted = typeof plottedCount === "number" ? plottedCount : this.state.lastPlottedIds.length;
      const skipped = skippedCount || 0;
      this.dom.summary.innerHTML = `
        <div class="metric-card"><span>Marked</span><strong>${marked}</strong></div>
        <div class="metric-card"><span>Selected</span><strong>${selected}</strong></div>
        <div class="metric-card"><span>Plotted</span><strong>${plotted}</strong></div>
        <div class="metric-card"><span>Skipped</span><strong>${skipped}</strong></div>
      `;
    }

    render() {
      this.dom.emptyState.hidden = this.state.curves.length > 0;
      this.dom.tableBody.innerHTML = "";

      this.state.curves.forEach((curve) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>
            <input
              type="checkbox"
              data-compare-select-id="${curve.id}"
              ${this.state.selectedIds.has(curve.id) ? "checked" : ""}
              aria-label="Select compare curve #${curve.displayIndex}"
            />
          </td>
          <td>#${curve.displayIndex}</td>
          <td><span class="table-file">[${escapeHtml(curve.sourceFileName)}]</span></td>
          <td>${escapeHtml(curve.experimentRange || "—")}</td>
          <td>${escapeHtml(curve.selection || "—")}</td>
          <td>${escapeHtml(curve.dataType || "raw")}</td>
          <td>${escapeHtml(formatTrendDetails(curve) || "—")}</td>
          <td>${curve.points || 0}</td>
          <td>
            <button class="ghost-button compact-button" type="button" data-compare-remove-id="${curve.id}">
              Remove
            </button>
          </td>
        `;
        this.dom.tableBody.appendChild(tr);
      });

      this.renderSummary();
    }
  }

  window.SurfaceLabCompareModule = {
    createController(options) {
      return new CompareModuleController(options);
    },
  };
})();
