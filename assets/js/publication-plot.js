(function () {
  const DEFAULT_WIDTH = 1400;
  const DEFAULT_HEIGHT = 900;
  const DEFAULT_FONT_SIZE = 14;
  const DEFAULT_TICK_FONT_SIZE = 12;
  const DEFAULT_LEGEND_FONT_SIZE = 12;
  const DEFAULT_AXIS_LINE_WIDTH = 1;
  const FALLBACK_TRACE_COLOR = "#2f5d8a";
  const LINE_DASHES = ["solid", "dash", "dot", "dashdot"];

  function deepCopy(value) {
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(value);
      } catch (error) {
        // Plotly figures are usually plain data, but JSON copy is a safe
        // fallback when browser-provided objects appear in the layout.
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getTitleText(title) {
    if (!title) {
      return "";
    }
    return typeof title === "string" ? title : String(title.text || "");
  }

  function getAxisTitle(axis) {
    if (!axis || !axis.title) {
      return "";
    }
    return typeof axis.title === "string" ? axis.title : String(axis.title.text || "");
  }

  function toFiniteNumber(value, fallback) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
  }

  function hexColor(value, fallback) {
    const text = String(value || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) {
      return text;
    }
    if (/^#[0-9a-f]{3}$/i.test(text)) {
      return "#" + text.slice(1).split("").map((part) => part + part).join("");
    }
    const rgb = text.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (rgb) {
      return (
        "#" +
        rgb
          .slice(1, 4)
          .map((part) => Number(part).toString(16).padStart(2, "0"))
          .join("")
      );
    }
    return fallback;
  }

  function setNested(target, path, value) {
    const parts = path.split(".");
    let cursor = target;
    parts.slice(0, -1).forEach((part) => {
      if (!cursor[part] || typeof cursor[part] !== "object") {
        cursor[part] = {};
      }
      cursor = cursor[part];
    });
    cursor[parts[parts.length - 1]] = value;
  }

  function deleteNested(target, path) {
    const parts = path.split(".");
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
      cursor = cursor ? cursor[parts[index]] : null;
      if (!cursor) {
        return;
      }
    }
    delete cursor[parts[parts.length - 1]];
  }

  function legendPresetToLayout(preset) {
    const presets = {
      "top-right": { x: 1, y: 1, xanchor: "right", yanchor: "top" },
      "top-left": { x: 0, y: 1, xanchor: "left", yanchor: "top" },
      "bottom-right": { x: 1, y: 0, xanchor: "right", yanchor: "bottom" },
      "bottom-left": { x: 0, y: 0, xanchor: "left", yanchor: "bottom" },
      "outside-right": { x: 1.02, y: 1, xanchor: "left", yanchor: "top" },
    };
    return presets[preset] || null;
  }

  function inferLegendPreset(legend) {
    if (!legend) {
      return "top-right";
    }
    const x = Number(legend.x);
    const y = Number(legend.y);
    const xanchor = legend.xanchor || "";
    const yanchor = legend.yanchor || "";
    const close = (a, b) => Math.abs(a - b) < 0.03;

    if (close(x, 1.02) && close(y, 1) && xanchor === "left") {
      return "outside-right";
    }
    if (close(x, 0) && close(y, 1) && xanchor === "left" && yanchor === "top") {
      return "top-left";
    }
    if (close(x, 1) && close(y, 1) && xanchor === "right" && yanchor === "top") {
      return "top-right";
    }
    if (close(x, 0) && close(y, 0) && xanchor === "left" && yanchor === "bottom") {
      return "bottom-left";
    }
    if (close(x, 1) && close(y, 0) && xanchor === "right" && yanchor === "bottom") {
      return "bottom-right";
    }
    return "custom";
  }

  function hasMarkerControls(trace) {
    const mode = String(trace.mode || "");
    return trace.type === "scatter" || Boolean(trace.marker) || mode.includes("markers");
  }

  class PublicationPlotController {
    constructor(options) {
      this.charts = options.charts;
      this.activateTab = options.activateTab;
      this.setStatus = options.setStatus || function () {};
      this.state = {
        sourceType: "unknown",
        sourceTitle: "",
        filenameBase: "publication-plot",
        data: [],
        layout: {},
        config: { responsive: true, displaylogo: false, editable: false },
        exportSettings: {
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
        },
      };

      this.dom = {
        canvas: document.querySelector("#publication-canvas"),
        status: document.querySelector("[data-publication-status]"),
        title: document.querySelector("#publication-title"),
        width: document.querySelector("#publication-width"),
        height: document.querySelector("#publication-height"),
        fontSize: document.querySelector("#publication-font-size"),
        xTitle: document.querySelector("#publication-x-title"),
        yTitle: document.querySelector("#publication-y-title"),
        tickFontSize: document.querySelector("#publication-tick-font-size"),
        axisLineWidth: document.querySelector("#publication-axis-line-width"),
        xMin: document.querySelector("#publication-x-min"),
        xMax: document.querySelector("#publication-x-max"),
        yMin: document.querySelector("#publication-y-min"),
        yMax: document.querySelector("#publication-y-max"),
        resetAxes: document.querySelector("#publication-reset-axes"),
        showLegend: document.querySelector("#publication-show-legend"),
        legendFontSize: document.querySelector("#publication-legend-font-size"),
        legendPosition: document.querySelector("#publication-legend-position"),
        legendX: document.querySelector("#publication-legend-x"),
        legendY: document.querySelector("#publication-legend-y"),
        traceList: document.querySelector("[data-publication-traces]"),
        exportPng: document.querySelector("#publication-export-png"),
        exportSvg: document.querySelector("#publication-export-svg"),
      };
    }

    bind() {
      this.bindLayoutControls();
      this.bindTraceControls();
      this.dom.resetAxes.addEventListener("click", () => this.resetAxisAutorange());
      this.dom.exportPng.addEventListener("click", () => this.exportFigure("png"));
      this.dom.exportSvg.addEventListener("click", () => this.exportFigure("svg"));
      this.syncEnabledState();
    }

    hasFigure() {
      return Array.isArray(this.state.data) && this.state.data.length > 0;
    }

    syncEnabledState() {
      const enabled = this.hasFigure();
      this.dom.exportPng.disabled = !enabled;
      this.dom.exportSvg.disabled = !enabled;
    }

    setPublicationStatus(message) {
      this.dom.status.textContent = message;
    }

    async copyFromPlot(plotElementOrId, metadata) {
      const source = typeof plotElementOrId === "string"
        ? document.getElementById(plotElementOrId)
        : plotElementOrId;
      const data = Array.from((source && source.data) || []);
      if (!source || !data.length) {
        this.setPublicationStatus("No figure loaded yet. Send a chart from an analysis tab.");
        return false;
      }

      const meta = metadata || {};
      const layout = deepCopy(source.layout || {});
      const copiedData = deepCopy(data);
      const copiedConfig = deepCopy(meta.config || { responsive: true, displaylogo: false, editable: false });
      const sourceRect = source.getBoundingClientRect ? source.getBoundingClientRect() : null;
      const width = toFiniteNumber(layout.width, Math.round(sourceRect && sourceRect.width ? sourceRect.width : DEFAULT_WIDTH));
      const height = toFiniteNumber(layout.height, Math.round(sourceRect && sourceRect.height ? sourceRect.height : DEFAULT_HEIGHT));

      this.state = {
        sourceType: meta.sourceType || "unknown",
        sourceTitle: meta.sourceTitle || getTitleText(layout.title) || "Plot",
        filenameBase: meta.filenameBase || "publication-plot",
        data: copiedData,
        layout: {
          ...layout,
          width,
          height,
          autosize: false,
        },
        config: {
          ...copiedConfig,
          responsive: true,
          displaylogo: false,
          editable: false,
        },
        exportSettings: { width, height },
      };

      this.activateTab("publication");
      this.syncControlsFromFigure();
      this.renderTraceControls();
      await this.render();
      this.syncEnabledState();
      this.setPublicationStatus(`Figure copied from ${this.state.sourceTitle}.`);
      this.setStatus(`Figure copied from ${this.state.sourceTitle}.`);
      return true;
    }

    syncControlsFromFigure() {
      const layout = this.state.layout || {};
      const xaxis = layout.xaxis || {};
      const yaxis = layout.yaxis || {};
      const legend = layout.legend || {};

      this.dom.title.value = getTitleText(layout.title);
      this.dom.width.value = this.state.exportSettings.width;
      this.dom.height.value = this.state.exportSettings.height;
      this.dom.fontSize.value = toFiniteNumber(layout.font && layout.font.size, DEFAULT_FONT_SIZE);
      this.dom.xTitle.value = getAxisTitle(xaxis);
      this.dom.yTitle.value = getAxisTitle(yaxis);
      this.dom.tickFontSize.value = toFiniteNumber(
        (xaxis.tickfont && xaxis.tickfont.size) || (yaxis.tickfont && yaxis.tickfont.size),
        DEFAULT_TICK_FONT_SIZE
      );
      this.dom.axisLineWidth.value = toFiniteNumber(xaxis.linewidth || yaxis.linewidth, DEFAULT_AXIS_LINE_WIDTH);
      this.dom.xMin.value = Array.isArray(xaxis.range) ? xaxis.range[0] : "";
      this.dom.xMax.value = Array.isArray(xaxis.range) ? xaxis.range[1] : "";
      this.dom.yMin.value = Array.isArray(yaxis.range) ? yaxis.range[0] : "";
      this.dom.yMax.value = Array.isArray(yaxis.range) ? yaxis.range[1] : "";
      this.dom.showLegend.checked = layout.showlegend !== false;
      this.dom.legendFontSize.value = toFiniteNumber(legend.font && legend.font.size, DEFAULT_LEGEND_FONT_SIZE);
      this.dom.legendPosition.value = inferLegendPreset(legend);
      this.dom.legendX.value = Number.isFinite(Number(legend.x)) ? legend.x : 1;
      this.dom.legendY.value = Number.isFinite(Number(legend.y)) ? legend.y : 1;
    }

    bindLayoutControls() {
      [
        this.dom.title,
        this.dom.width,
        this.dom.height,
        this.dom.fontSize,
        this.dom.xTitle,
        this.dom.yTitle,
        this.dom.tickFontSize,
        this.dom.axisLineWidth,
        this.dom.xMin,
        this.dom.xMax,
        this.dom.yMin,
        this.dom.yMax,
        this.dom.showLegend,
        this.dom.legendFontSize,
        this.dom.legendPosition,
        this.dom.legendX,
        this.dom.legendY,
      ].forEach((element) => {
        element.addEventListener("input", (event) => {
          if (event.target === this.dom.legendX || event.target === this.dom.legendY) {
            this.dom.legendPosition.value = "custom";
          }
          this.applyLayoutControls();
        });
        element.addEventListener("change", (event) => {
          if (event.target === this.dom.legendX || event.target === this.dom.legendY) {
            this.dom.legendPosition.value = "custom";
          }
          this.applyLayoutControls();
        });
      });
    }

    buildLayoutUpdate() {
      const width = Math.max(320, toFiniteNumber(this.dom.width.value, DEFAULT_WIDTH));
      const height = Math.max(240, toFiniteNumber(this.dom.height.value, DEFAULT_HEIGHT));
      const fontSize = Math.max(6, toFiniteNumber(this.dom.fontSize.value, DEFAULT_FONT_SIZE));
      const tickFontSize = Math.max(6, toFiniteNumber(this.dom.tickFontSize.value, DEFAULT_TICK_FONT_SIZE));
      const axisLineWidth = Math.max(0, toFiniteNumber(this.dom.axisLineWidth.value, DEFAULT_AXIS_LINE_WIDTH));
      const legendFontSize = Math.max(6, toFiniteNumber(this.dom.legendFontSize.value, DEFAULT_LEGEND_FONT_SIZE));
      const legendPreset = legendPresetToLayout(this.dom.legendPosition.value);
      const legendX = legendPreset ? legendPreset.x : toFiniteNumber(this.dom.legendX.value, 1);
      const legendY = legendPreset ? legendPreset.y : toFiniteNumber(this.dom.legendY.value, 1);
      const legendXAnchor = legendPreset ? legendPreset.xanchor : (this.state.layout.legend && this.state.layout.legend.xanchor) || "left";
      const legendYAnchor = legendPreset ? legendPreset.yanchor : (this.state.layout.legend && this.state.layout.legend.yanchor) || "top";

      if (legendPreset) {
        this.dom.legendX.value = legendPreset.x;
        this.dom.legendY.value = legendPreset.y;
      }

      const update = {
        "title.text": this.dom.title.value,
        width,
        height,
        autosize: false,
        "font.size": fontSize,
        "xaxis.title.text": this.dom.xTitle.value,
        "yaxis.title.text": this.dom.yTitle.value,
        "xaxis.tickfont.size": tickFontSize,
        "yaxis.tickfont.size": tickFontSize,
        "xaxis.linewidth": axisLineWidth,
        "yaxis.linewidth": axisLineWidth,
        "xaxis.showline": axisLineWidth > 0,
        "yaxis.showline": axisLineWidth > 0,
        showlegend: this.dom.showLegend.checked,
        "legend.font.size": legendFontSize,
        "legend.x": legendX,
        "legend.y": legendY,
        "legend.xanchor": legendXAnchor,
        "legend.yanchor": legendYAnchor,
      };

      this.applyRangeUpdate(update, "xaxis", this.dom.xMin.value, this.dom.xMax.value);
      this.applyRangeUpdate(update, "yaxis", this.dom.yMin.value, this.dom.yMax.value);
      this.state.exportSettings = { width, height };
      return update;
    }

    applyRangeUpdate(update, axisName, minValue, maxValue) {
      const minText = String(minValue || "").trim();
      const maxText = String(maxValue || "").trim();
      if (!minText && !maxText) {
        return;
      }

      const minNumber = Number(minText);
      const maxNumber = Number(maxText);
      if (!Number.isFinite(minNumber) || !Number.isFinite(maxNumber) || maxNumber <= minNumber) {
        return;
      }

      update[`${axisName}.range`] = [minNumber, maxNumber];
      update[`${axisName}.autorange`] = false;
    }

    async applyLayoutControls() {
      if (!this.hasFigure()) {
        return;
      }
      const update = this.buildLayoutUpdate();
      Object.keys(update).forEach((path) => setNested(this.state.layout, path, update[path]));
      await Plotly.relayout(this.dom.canvas, update);
      this.setPublicationStatus("Publication plot updated.");
    }

    async resetAxisAutorange() {
      if (!this.hasFigure()) {
        return;
      }
      this.dom.xMin.value = "";
      this.dom.xMax.value = "";
      this.dom.yMin.value = "";
      this.dom.yMax.value = "";
      deleteNested(this.state.layout, "xaxis.range");
      deleteNested(this.state.layout, "yaxis.range");
      setNested(this.state.layout, "xaxis.autorange", true);
      setNested(this.state.layout, "yaxis.autorange", true);
      await Plotly.relayout(this.dom.canvas, {
        "xaxis.autorange": true,
        "yaxis.autorange": true,
      });
      this.setPublicationStatus("Axis autorange restored.");
    }

    renderTraceControls() {
      if (!this.hasFigure()) {
        this.dom.traceList.innerHTML = '<div class="empty-state">No traces loaded.</div>';
        return;
      }

      this.dom.traceList.innerHTML = this.state.data
        .map((trace, index) => {
          const traceColor = hexColor(
            (trace.line && trace.line.color) || (trace.marker && trace.marker.color),
            FALLBACK_TRACE_COLOR
          );
          const lineWidth = toFiniteNumber(trace.line && trace.line.width, 2);
          const lineDash = LINE_DASHES.includes(trace.line && trace.line.dash)
            ? trace.line.dash
            : "solid";
          const markerSize = toFiniteNumber(trace.marker && trace.marker.size, 6);
          const markerControls = hasMarkerControls(trace)
            ? `
              <div class="field">
                <label for="publication-trace-marker-${index}">Marker Size</label>
                <input id="publication-trace-marker-${index}" type="number" min="0" max="40" step="0.5" value="${markerSize}" data-trace-index="${index}" data-trace-field="marker-size" />
              </div>
            `
            : "";
          const dashOptions = LINE_DASHES
            .map((dash) => `<option value="${dash}" ${dash === lineDash ? "selected" : ""}>${dash}</option>`)
            .join("");

          return `
            <div class="trace-editor-card">
              <div class="trace-editor-title">
                <span>Trace ${index + 1}</span>
                <label class="checkbox-row checkbox-row-compact">
                  <input type="checkbox" ${trace.visible === false || trace.visible === "legendonly" ? "" : "checked"} data-trace-index="${index}" data-trace-field="visible" />
                  Visible
                </label>
              </div>
              <div class="field-grid">
                <div class="field">
                  <label for="publication-trace-name-${index}">Trace Display Name</label>
                  <input id="publication-trace-name-${index}" type="text" value="${escapeHtml(trace.name || "")}" data-trace-index="${index}" data-trace-field="name" />
                </div>
                <div class="trace-style-grid">
                  <div class="field">
                    <label for="publication-trace-color-${index}">Line Color</label>
                    <input id="publication-trace-color-${index}" type="color" value="${traceColor}" data-trace-index="${index}" data-trace-field="color" />
                  </div>
                  <div class="field">
                    <label for="publication-trace-width-${index}">Line Width</label>
                    <input id="publication-trace-width-${index}" type="number" min="0" max="20" step="0.2" value="${lineWidth}" data-trace-index="${index}" data-trace-field="line-width" />
                  </div>
                  <div class="field">
                    <label for="publication-trace-dash-${index}">Line Dash</label>
                    <select id="publication-trace-dash-${index}" data-trace-index="${index}" data-trace-field="line-dash">${dashOptions}</select>
                  </div>
                  ${markerControls}
                </div>
              </div>
            </div>
          `;
        })
        .join("");
    }

    bindTraceControls() {
      this.dom.traceList.addEventListener("input", (event) => this.handleTraceInput(event));
      this.dom.traceList.addEventListener("change", (event) => this.handleTraceInput(event));
    }

    async handleTraceInput(event) {
      const input = event.target.closest("[data-trace-index][data-trace-field]");
      if (!input || !this.hasFigure()) {
        return;
      }

      const index = Number(input.dataset.traceIndex);
      const trace = this.state.data[index];
      if (!Number.isInteger(index) || !trace) {
        return;
      }

      const update = {};
      const field = input.dataset.traceField;
      if (field === "name") {
        trace.name = input.value;
        update.name = input.value;
      } else if (field === "visible") {
        trace.visible = input.checked;
        update.visible = input.checked;
      } else if (field === "color") {
        if (!trace.line) {
          trace.line = {};
        }
        trace.line.color = input.value;
        update["line.color"] = input.value;
      } else if (field === "line-width") {
        if (!trace.line) {
          trace.line = {};
        }
        trace.line.width = Math.max(0, toFiniteNumber(input.value, 2));
        update["line.width"] = trace.line.width;
      } else if (field === "line-dash") {
        if (!trace.line) {
          trace.line = {};
        }
        trace.line.dash = input.value;
        update["line.dash"] = input.value;
      } else if (field === "marker-size") {
        if (!trace.marker) {
          trace.marker = {};
        }
        trace.marker.size = Math.max(0, toFiniteNumber(input.value, 6));
        update["marker.size"] = trace.marker.size;
      }

      await Plotly.restyle(this.dom.canvas, update, [index]);
      this.setPublicationStatus("Publication plot updated.");
    }

    async render() {
      await Plotly.react(this.dom.canvas, this.state.data, this.state.layout, this.state.config);
    }

    async exportFigure(format) {
      if (!this.hasFigure()) {
        return;
      }
      await this.charts.exportPlotImage(this.dom.canvas, this.state.filenameBase || "publication-plot", {
        format,
        width: this.state.exportSettings.width,
        height: this.state.exportSettings.height,
      });
    }
  }

  window.SurfaceLabPublicationPlot = {
    createController(options) {
      return new PublicationPlotController(options);
    },
  };
})();
