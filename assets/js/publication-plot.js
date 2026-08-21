(function () {
  const domUtils = window.SurfaceLabDomUtils;
  const DEFAULT_WIDTH = 1400;
  const DEFAULT_HEIGHT = 900;
  const DEFAULT_FONT_SIZE = 14;
  const DEFAULT_TICK_FONT_SIZE = 12;
  const DEFAULT_LEGEND_FONT_SIZE = 12;
  const DEFAULT_AXIS_LINE_WIDTH = 1;
  const DEFAULT_LEGEND_POSITION = "outside-top";
  const DEFAULT_LEGEND_ORIENTATION = "h";
  const FALLBACK_TRACE_COLOR = "#0072B2";
  const LINE_DASHES = ["solid", "dash", "dot", "dashdot"];
  const FIGURE_PRESETS = {
    "single-column": {
      label: "Single Column",
      width: 720,
      height: 520,
      fontSize: 13,
      tickFontSize: 11,
      axisLineWidth: 1,
      showLegend: true,
      legendFontSize: 10,
      legendPosition: DEFAULT_LEGEND_POSITION,
      legendOrientation: DEFAULT_LEGEND_ORIENTATION,
    },
    "double-column": {
      label: "Double Column",
      width: 1400,
      height: 900,
      fontSize: 14,
      tickFontSize: 12,
      axisLineWidth: 1,
      showLegend: true,
      legendFontSize: 12,
      legendPosition: "outside-right",
      legendOrientation: "v",
    },
    presentation: {
      label: "Presentation",
      width: 1600,
      height: 900,
      fontSize: 22,
      tickFontSize: 18,
      axisLineWidth: 2,
      showLegend: true,
      legendFontSize: 18,
      legendPosition: DEFAULT_LEGEND_POSITION,
      legendOrientation: DEFAULT_LEGEND_ORIENTATION,
    },
    square: {
      label: "Square",
      width: 900,
      height: 900,
      fontSize: 15,
      tickFontSize: 13,
      axisLineWidth: 1.2,
      showLegend: true,
      legendFontSize: 12,
      legendPosition: DEFAULT_LEGEND_POSITION,
      legendOrientation: DEFAULT_LEGEND_ORIENTATION,
    },
    wide: {
      label: "Wide",
      width: 1800,
      height: 720,
      fontSize: 15,
      tickFontSize: 12,
      axisLineWidth: 1,
      showLegend: true,
      legendFontSize: 12,
      legendPosition: "outside-right",
      legendOrientation: "v",
    },
  };
  const STYLE_TEMPLATES = {
    clean: {
      label: "Clean",
      controls: {
        fontSize: 14,
        tickFontSize: 12,
        axisLineWidth: 1,
        showLegend: true,
        legendFontSize: 12,
        legendPosition: DEFAULT_LEGEND_POSITION,
        legendOrientation: DEFAULT_LEGEND_ORIENTATION,
      },
      layout: {
        "paper_bgcolor": "#ffffff",
        "plot_bgcolor": "#ffffff",
        "margin.l": 80,
        "margin.r": 40,
        "margin.t": 70,
        "margin.b": 70,
        "xaxis.showgrid": false,
        "yaxis.showgrid": true,
        "xaxis.zeroline": false,
        "yaxis.zeroline": false,
      },
      traces: {
        lineWidth: 2,
        markerSize: 6,
        opacity: 1,
      },
    },
    dense: {
      label: "Dense Data",
      controls: {
        fontSize: 12,
        tickFontSize: 10,
        axisLineWidth: 0.8,
        showLegend: true,
        legendFontSize: 10,
        legendPosition: "outside-right",
        legendOrientation: "v",
      },
      layout: {
        "paper_bgcolor": "#ffffff",
        "plot_bgcolor": "#ffffff",
        "margin.l": 72,
        "margin.r": 120,
        "margin.t": 52,
        "margin.b": 62,
        "xaxis.showgrid": true,
        "yaxis.showgrid": true,
        "xaxis.gridcolor": "#e5e7eb",
        "yaxis.gridcolor": "#e5e7eb",
        "xaxis.zeroline": false,
        "yaxis.zeroline": false,
      },
      traces: {
        lineWidth: 1.2,
        markerSize: 4,
        opacity: 0.78,
      },
    },
    "large-font": {
      label: "Large Font",
      controls: {
        fontSize: 20,
        tickFontSize: 17,
        axisLineWidth: 1.8,
        showLegend: true,
        legendFontSize: 17,
        legendPosition: DEFAULT_LEGEND_POSITION,
        legendOrientation: DEFAULT_LEGEND_ORIENTATION,
      },
      layout: {
        "paper_bgcolor": "#ffffff",
        "plot_bgcolor": "#ffffff",
        "margin.l": 100,
        "margin.r": 60,
        "margin.t": 92,
        "margin.b": 92,
        "xaxis.showgrid": false,
        "yaxis.showgrid": true,
        "xaxis.zeroline": false,
        "yaxis.zeroline": false,
      },
      traces: {
        lineWidth: 3,
        markerSize: 9,
        opacity: 1,
      },
    },
    minimal: {
      label: "Minimal",
      controls: {
        fontSize: 13,
        tickFontSize: 11,
        axisLineWidth: 0,
        showLegend: false,
        legendFontSize: 11,
        legendPosition: DEFAULT_LEGEND_POSITION,
        legendOrientation: DEFAULT_LEGEND_ORIENTATION,
      },
      layout: {
        "paper_bgcolor": "#ffffff",
        "plot_bgcolor": "#ffffff",
        "margin.l": 64,
        "margin.r": 28,
        "margin.t": 48,
        "margin.b": 56,
        "xaxis.showgrid": false,
        "yaxis.showgrid": false,
        "xaxis.zeroline": false,
        "yaxis.zeroline": false,
      },
      traces: {
        lineWidth: 2,
        markerSize: 5,
        opacity: 0.9,
      },
    },
  };

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
      "outside-top": { x: 0.5, y: 1.14, xanchor: "center", yanchor: "bottom", margin: { t: 96 } },
      "outside-bottom": { x: 0.5, y: -0.34, xanchor: "center", yanchor: "top", margin: { b: 130 } },
    };
    return presets[preset] || null;
  }

  function inferLegendPreset(legend) {
    if (!legend) {
      return DEFAULT_LEGEND_POSITION;
    }
    const x = Number(legend.x);
    const y = Number(legend.y);
    const xanchor = legend.xanchor || "";
    const yanchor = legend.yanchor || "";
    const close = (a, b) => Math.abs(a - b) < 0.03;

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return DEFAULT_LEGEND_POSITION;
    }

    if (close(x, 0.5) && close(y, 1.14) && xanchor === "center" && yanchor === "bottom") {
      return "outside-top";
    }
    if (close(x, 0.5) && close(y, -0.34) && xanchor === "center" && yanchor === "top") {
      return "outside-bottom";
    }
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

  function createEmptyFigurePayload() {
    return {
      data: [],
      layout: {},
      config: { responsive: true, displaylogo: false, editable: false },
    };
  }

  function createStyleMeta(input) {
    return {
      currentPreset: input && typeof input.currentPreset === "string" ? input.currentPreset : "",
      currentTemplate: input && typeof input.currentTemplate === "string" ? input.currentTemplate : "",
      manualLayoutEdited: Boolean(input && input.manualLayoutEdited),
      presetModified: Boolean(input && input.presetModified),
      templateModified: Boolean(input && input.templateModified),
    };
  }

  function hasObjectEntries(value) {
    return value && typeof value === "object" && Object.keys(value).length > 0;
  }

  function cloneTraceStyles(data) {
    return (Array.isArray(data) ? data : []).map((trace) => ({
      line: deepCopy(trace && trace.line ? trace.line : null),
      marker: deepCopy(trace && trace.marker ? trace.marker : null),
      opacity: trace && Object.prototype.hasOwnProperty.call(trace, "opacity") ? trace.opacity : null,
    }));
  }

  function restoreTraceStyles(trace, style) {
    if (!trace || !style) {
      return;
    }
    if (style.line) {
      trace.line = deepCopy(style.line);
    } else {
      delete trace.line;
    }
    if (style.marker) {
      trace.marker = deepCopy(style.marker);
    } else {
      delete trace.marker;
    }
    if (style.opacity === null || typeof style.opacity === "undefined") {
      delete trace.opacity;
    } else {
      trace.opacity = style.opacity;
    }
  }

  function createDefaultLayoutFromPayload(figurePayload, exportSettings) {
    const layout = deepCopy((figurePayload && figurePayload.layout) || {});
    const width = toFiniteNumber(exportSettings && exportSettings.width, toFiniteNumber(layout.width, DEFAULT_WIDTH));
    const height = toFiniteNumber(exportSettings && exportSettings.height, toFiniteNumber(layout.height, DEFAULT_HEIGHT));
    return {
      ...layout,
      width,
      height,
      autosize: false,
    };
  }

  function buildTraceInputField(index, labelText, fieldName, inputType, value, attrs) {
    const inputId = `publication-trace-${fieldName}-${index}`;
    const input = domUtils.el("input", {
      attrs: {
        id: inputId,
        type: inputType,
        "data-trace-index": index,
        "data-trace-field": fieldName,
        ...(attrs || {}),
      },
      props: { value },
    });

    return domUtils.el("div", { className: "field" }, [
      domUtils.el("label", { text: labelText, attrs: { for: inputId } }),
      input,
    ]);
  }

  function buildTraceDashField(index, selectedDash) {
    const selectId = `publication-trace-dash-${index}`;
    const select = domUtils.el("select", {
      attrs: {
        id: selectId,
        "data-trace-index": index,
        "data-trace-field": "line-dash",
      },
    });
    domUtils.populateSelect(
      select,
      LINE_DASHES.map((dash) => ({
        value: dash,
        label: dash,
        selected: dash === selectedDash,
      }))
    );

    return domUtils.el("div", { className: "field" }, [
      domUtils.el("label", { text: "Line Dash", attrs: { for: selectId } }),
      select,
    ]);
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
        figurePayload: createEmptyFigurePayload(),
        data: [],
        layout: {},
        config: { responsive: true, displaylogo: false, editable: false },
        exportSettings: {
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
        },
        defaultLayout: {},
        defaultExportSettings: {
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
        },
        defaultTraceStyles: [],
        scientificStyleEnabled: false,
        styleMeta: createStyleMeta(),
      };
      this.styleHistory = [];

      this.dom = {
        canvas: document.querySelector("#publication-canvas"),
        status: document.querySelector("[data-publication-status]"),
        figurePreset: document.querySelector("#publication-figure-preset"),
        styleTemplate: document.querySelector("#publication-style-template"),
        activeStyle: document.querySelector("[data-publication-active-style]"),
        styleWarning: document.querySelector("[data-publication-style-warning]"),
        scientificStyle: document.querySelector("#publication-scientific-style"),
        undoStyle: document.querySelector("#publication-undo-style"),
        title: document.querySelector("#publication-title"),
        titleClear: document.querySelector("#publication-title-clear"),
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
        legendOrientation: document.querySelector("#publication-legend-orientation"),
        legendX: document.querySelector("#publication-legend-x"),
        legendY: document.querySelector("#publication-legend-y"),
        traceList: document.querySelector("[data-publication-traces]"),
        batchLineWidth: document.querySelector("#publication-batch-line-width"),
        applyLineWidth: document.querySelector("#publication-apply-line-width"),
        batchMarkerSize: document.querySelector("#publication-batch-marker-size"),
        applyMarkerSize: document.querySelector("#publication-apply-marker-size"),
        batchOpacity: document.querySelector("#publication-batch-opacity"),
        applyOpacity: document.querySelector("#publication-apply-opacity"),
        resetTraceStyles: document.querySelector("#publication-reset-trace-styles"),
        exportPng: document.querySelector("#publication-export-png"),
        exportSvg: document.querySelector("#publication-export-svg"),
      };
    }

    bind() {
      this.bindLayoutControls();
      this.bindPresetControls();
      this.bindTraceControls();
      this.dom.scientificStyle.addEventListener("change", () => this.applyScientificStyle());
      this.dom.resetAxes.addEventListener("click", () => this.resetAxisAutorange());
      this.dom.exportPng.addEventListener("click", () => this.exportFigure("png"));
      this.dom.exportSvg.addEventListener("click", () => this.exportFigure("svg"));
      this.syncEnabledState();
    }

    hasFigure() {
      return Array.isArray(this.state.data) && this.state.data.length > 0;
    }

    hasScientificSurfaceTensionTraces() {
      return this.hasFigure() && this.state.data.some((trace) =>
        this.charts.isScientificSurfaceTensionTrace(trace)
      );
    }

    syncEnabledState() {
      const enabled = this.hasFigure();
      this.dom.exportPng.disabled = !enabled;
      this.dom.exportSvg.disabled = !enabled;
      this.dom.scientificStyle.disabled = !enabled || !this.hasScientificSurfaceTensionTraces();
      this.dom.scientificStyle.checked = Boolean(this.state.scientificStyleEnabled);
      [
        this.dom.figurePreset,
        this.dom.styleTemplate,
        this.dom.undoStyle,
        this.dom.titleClear,
        this.dom.batchLineWidth,
        this.dom.applyLineWidth,
        this.dom.batchMarkerSize,
        this.dom.applyMarkerSize,
        this.dom.batchOpacity,
        this.dom.applyOpacity,
        this.dom.resetTraceStyles,
      ].forEach((element) => {
        if (element) {
          element.disabled = !enabled || (element === this.dom.undoStyle && !this.styleHistory.length);
        }
      });
    }

    setPublicationStatus(message) {
      this.dom.status.textContent = message;
    }

    setStyleWarning(message) {
      if (!this.dom.styleWarning) {
        return;
      }
      this.dom.styleWarning.textContent = message || "";
      this.dom.styleWarning.hidden = !message;
    }

    updateStyleFeedback() {
      const meta = this.state.styleMeta || createStyleMeta();
      const preset = FIGURE_PRESETS[meta.currentPreset];
      const template = STYLE_TEMPLATES[meta.currentTemplate];
      const presetLabel = meta.currentPreset === "default"
        ? "Preset: Default"
        : preset
          ? `Preset: ${preset.label}${meta.presetModified ? " (modified)" : ""}`
          : "Preset: none";
      const templateLabel = meta.currentTemplate === "default"
        ? "Template: Default"
        : template
          ? `Template: ${template.label}${meta.templateModified ? " (modified)" : ""}`
          : "Template: none";

      if (this.dom.figurePreset) {
        this.dom.figurePreset.value = meta.currentPreset || "";
      }
      if (this.dom.styleTemplate) {
        this.dom.styleTemplate.value = meta.currentTemplate || "";
      }
      if (this.dom.activeStyle) {
        this.dom.activeStyle.textContent = `${presetLabel}. ${templateLabel}.`;
      }
      this.syncEnabledState();
    }

    pushStyleSnapshot(label) {
      if (!this.hasFigure()) {
        return;
      }
      this.styleHistory.push({
        label,
        data: deepCopy(this.state.data),
        layout: deepCopy(this.state.layout),
        exportSettings: deepCopy(this.state.exportSettings),
        styleMeta: deepCopy(this.state.styleMeta),
        scientificStyleEnabled: Boolean(this.state.scientificStyleEnabled),
      });
      if (this.styleHistory.length > 8) {
        this.styleHistory.shift();
      }
      this.syncEnabledState();
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
      const copiedConfig = deepCopy(meta.config || { responsive: true, displaylogo: false, editable: false });
      const figurePayload = {
        data: deepCopy(data),
        layout: deepCopy(source.layout || {}),
        config: deepCopy(copiedConfig),
      };
      const copiedData = deepCopy(figurePayload.data);
      const scientificStyleEnabled = copiedData.some((trace) => {
        const surfaceLab = trace && trace.meta && trace.meta.surfaceLab;
        return Boolean(surfaceLab && surfaceLab.scientificStyleEnabled);
      });
      const sourceRect = source.getBoundingClientRect ? source.getBoundingClientRect() : null;
      const width = toFiniteNumber(layout.width, Math.round(sourceRect && sourceRect.width ? sourceRect.width : DEFAULT_WIDTH));
      const height = toFiniteNumber(layout.height, Math.round(sourceRect && sourceRect.height ? sourceRect.height : DEFAULT_HEIGHT));
      const publicationLayout = {
        ...layout,
        width,
        height,
        autosize: false,
      };
      const exportSettings = { width, height };

      this.state = {
        sourceType: meta.sourceType || "unknown",
        sourceTitle: meta.sourceTitle || getTitleText(layout.title) || "Plot",
        filenameBase: meta.filenameBase || "publication-plot",
        figurePayload,
        data: copiedData,
        layout: publicationLayout,
        config: {
          ...copiedConfig,
          responsive: true,
          displaylogo: false,
          editable: false,
        },
        exportSettings,
        defaultLayout: deepCopy(publicationLayout),
        defaultExportSettings: deepCopy(exportSettings),
        defaultTraceStyles: cloneTraceStyles(copiedData),
        scientificStyleEnabled,
        styleMeta: createStyleMeta(),
      };
      this.styleHistory = [];

      this.activateTab("publication");
      this.syncControlsFromFigure();
      this.renderTraceControls();
      await this.render();
      this.syncEnabledState();
      this.setStyleWarning("");
      this.updateStyleFeedback();
      this.setPublicationStatus(`Figure copied from ${this.state.sourceTitle}.`);
      this.setStatus(`Figure copied from ${this.state.sourceTitle}.`);
      return true;
    }

    async applyScientificStyle() {
      if (!this.hasScientificSurfaceTensionTraces()) {
        this.dom.scientificStyle.checked = false;
        this.state.scientificStyleEnabled = false;
        this.setPublicationStatus("This figure has no eligible raw surface-tension traces.");
        return;
      }

      const enabled = Boolean(this.dom.scientificStyle.checked);
      this.state.data.forEach((trace) => {
        if (this.charts.isScientificSurfaceTensionTrace(trace)) {
          this.charts.applyScientificTraceStyle(trace, enabled);
        }
      });
      this.state.scientificStyleEnabled = enabled;
      this.renderTraceControls();
      await this.render();
      this.syncEnabledState();
      this.setPublicationStatus(
        enabled
          ? "Scientific style applied to raw surface-tension traces (moving average ± local SD)."
          : "Point-to-point style restored for raw surface-tension traces."
      );
    }

    reapplyScientificStyleState() {
      this.state.data.forEach((trace) => {
        if (this.charts.isScientificSurfaceTensionTrace(trace)) {
          this.charts.applyScientificTraceStyle(trace, this.state.scientificStyleEnabled);
        }
      });
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
      const inferredLegendPosition = inferLegendPreset(legend);
      const inferredLegendPreset = legendPresetToLayout(inferredLegendPosition);
      this.dom.legendPosition.value = inferredLegendPosition;
      this.dom.legendOrientation.value = legend.orientation === "v" ? "v" : DEFAULT_LEGEND_ORIENTATION;
      this.dom.legendX.value = Number.isFinite(Number(legend.x))
        ? legend.x
        : (inferredLegendPreset && inferredLegendPreset.x) || 1;
      this.dom.legendY.value = Number.isFinite(Number(legend.y))
        ? legend.y
        : (inferredLegendPreset && inferredLegendPreset.y) || 1;
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
        this.dom.legendOrientation,
        this.dom.legendX,
        this.dom.legendY,
      ].forEach((element) => {
        element.addEventListener("input", (event) => {
          if (event.target === this.dom.legendX || event.target === this.dom.legendY) {
            this.dom.legendPosition.value = "custom";
          }
          this.applyLayoutControls({ userInitiated: true });
        });
        element.addEventListener("change", (event) => {
          if (event.target === this.dom.legendX || event.target === this.dom.legendY) {
            this.dom.legendPosition.value = "custom";
          }
          this.applyLayoutControls({ userInitiated: true });
        });
      });

      if (this.dom.titleClear) {
        this.dom.titleClear.addEventListener("click", () => {
          if (!this.hasFigure()) {
            return;
          }
          this.dom.title.value = "";
          this.applyLayoutControls({ userInitiated: true });
          this.dom.title.focus();
        });
      }
    }

    bindPresetControls() {
      if (this.dom.figurePreset) {
        this.dom.figurePreset.addEventListener("change", () => this.applyFigurePreset(this.dom.figurePreset.value));
      }
      if (this.dom.styleTemplate) {
        this.dom.styleTemplate.addEventListener("change", () => this.applyStyleTemplate(this.dom.styleTemplate.value));
      }
      if (this.dom.undoStyle) {
        this.dom.undoStyle.addEventListener("click", () => this.undoStyleChange());
      }
      if (this.dom.applyLineWidth) {
        this.dom.applyLineWidth.addEventListener("click", () => this.applyBatchTraceStyle("line-width"));
      }
      if (this.dom.applyMarkerSize) {
        this.dom.applyMarkerSize.addEventListener("click", () => this.applyBatchTraceStyle("marker-size"));
      }
      if (this.dom.applyOpacity) {
        this.dom.applyOpacity.addEventListener("click", () => this.applyBatchTraceStyle("opacity"));
      }
      if (this.dom.resetTraceStyles) {
        this.dom.resetTraceStyles.addEventListener("click", () => this.resetAllTraceStyles());
      }
    }

    buildLayoutUpdate() {
      const width = Math.max(320, toFiniteNumber(this.dom.width.value, DEFAULT_WIDTH));
      const height = Math.max(240, toFiniteNumber(this.dom.height.value, DEFAULT_HEIGHT));
      const fontSize = Math.max(6, toFiniteNumber(this.dom.fontSize.value, DEFAULT_FONT_SIZE));
      const tickFontSize = Math.max(6, toFiniteNumber(this.dom.tickFontSize.value, DEFAULT_TICK_FONT_SIZE));
      const axisLineWidth = Math.max(0, toFiniteNumber(this.dom.axisLineWidth.value, DEFAULT_AXIS_LINE_WIDTH));
      const legendFontSize = Math.max(6, toFiniteNumber(this.dom.legendFontSize.value, DEFAULT_LEGEND_FONT_SIZE));
      const legendPreset = legendPresetToLayout(this.dom.legendPosition.value);
      const legendOrientation = this.dom.legendOrientation.value === "v" ? "v" : DEFAULT_LEGEND_ORIENTATION;
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
        "legend.orientation": legendOrientation,
        "legend.x": legendX,
        "legend.y": legendY,
        "legend.xanchor": legendXAnchor,
        "legend.yanchor": legendYAnchor,
      };

      if (legendPreset && legendPreset.margin) {
        Object.keys(legendPreset.margin).forEach((key) => {
          const path = `margin.${key}`;
          const existing = this.state.layout.margin && Number(this.state.layout.margin[key]);
          update[path] = Math.max(Number.isFinite(existing) ? existing : 0, legendPreset.margin[key]);
        });
      }

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

    async applyLayoutControls(options) {
      if (!this.hasFigure()) {
        return;
      }
      const update = this.buildLayoutUpdate();
      Object.keys(update).forEach((path) => setNested(this.state.layout, path, update[path]));
      await Plotly.relayout(this.dom.canvas, update);
      if (!options || options.userInitiated !== false) {
        this.state.styleMeta.manualLayoutEdited = true;
        this.state.styleMeta.presetModified = Boolean(this.state.styleMeta.currentPreset);
        this.state.styleMeta.templateModified = Boolean(this.state.styleMeta.currentTemplate);
        this.setStyleWarning("");
        this.updateStyleFeedback();
      }
      this.setPublicationStatus("Publication plot updated.");
    }

    applyStyleControlValues(values) {
      if (!values) {
        return;
      }
      if (Object.prototype.hasOwnProperty.call(values, "width")) {
        this.dom.width.value = values.width;
      }
      if (Object.prototype.hasOwnProperty.call(values, "height")) {
        this.dom.height.value = values.height;
      }
      if (Object.prototype.hasOwnProperty.call(values, "fontSize")) {
        this.dom.fontSize.value = values.fontSize;
      }
      if (Object.prototype.hasOwnProperty.call(values, "tickFontSize")) {
        this.dom.tickFontSize.value = values.tickFontSize;
      }
      if (Object.prototype.hasOwnProperty.call(values, "axisLineWidth")) {
        this.dom.axisLineWidth.value = values.axisLineWidth;
      }
      if (Object.prototype.hasOwnProperty.call(values, "showLegend")) {
        this.dom.showLegend.checked = values.showLegend;
      }
      if (Object.prototype.hasOwnProperty.call(values, "legendFontSize")) {
        this.dom.legendFontSize.value = values.legendFontSize;
      }
      if (values.legendPosition) {
        this.dom.legendPosition.value = values.legendPosition;
        const legendPreset = legendPresetToLayout(values.legendPosition);
        if (legendPreset) {
          this.dom.legendX.value = legendPreset.x;
          this.dom.legendY.value = legendPreset.y;
        }
      }
      if (values.legendOrientation) {
        this.dom.legendOrientation.value = values.legendOrientation === "v" ? "v" : DEFAULT_LEGEND_ORIENTATION;
      }
    }

    getDefaultLayoutSnapshot() {
      const fallbackExportSettings = hasObjectEntries(this.state.defaultExportSettings)
        ? this.state.defaultExportSettings
        : this.state.exportSettings;
      const layout = hasObjectEntries(this.state.defaultLayout)
        ? deepCopy(this.state.defaultLayout)
        : createDefaultLayoutFromPayload(this.state.figurePayload, fallbackExportSettings);
      const exportSettings = hasObjectEntries(this.state.defaultExportSettings)
        ? deepCopy(this.state.defaultExportSettings)
        : {
            width: toFiniteNumber(layout.width, DEFAULT_WIDTH),
            height: toFiniteNumber(layout.height, DEFAULT_HEIGHT),
          };
      layout.width = exportSettings.width;
      layout.height = exportSettings.height;
      layout.autosize = false;
      return { layout, exportSettings };
    }

    async applyDefaultFigurePreset() {
      if (!this.hasFigure()) {
        return;
      }
      this.pushStyleSnapshot("default figure preset");
      const defaults = this.getDefaultLayoutSnapshot();
      this.state.layout = defaults.layout;
      this.state.exportSettings = defaults.exportSettings;
      this.state.styleMeta.currentPreset = "default";
      this.state.styleMeta.manualLayoutEdited = false;
      this.state.styleMeta.presetModified = false;
      this.state.styleMeta.templateModified = Boolean(this.state.styleMeta.currentTemplate);
      this.syncControlsFromFigure();
      await this.render();
      this.setStyleWarning("");
      this.updateStyleFeedback();
      this.setPublicationStatus("Default figure preset restored.");
    }

    async applyFigurePreset(presetKey) {
      if (presetKey === "default") {
        await this.applyDefaultFigurePreset();
        return;
      }
      const preset = FIGURE_PRESETS[presetKey];
      if (!preset || !this.hasFigure()) {
        this.updateStyleFeedback();
        return;
      }

      const overwritesManualValues = this.state.styleMeta.manualLayoutEdited || this.state.styleMeta.presetModified;
      this.pushStyleSnapshot("figure preset");
      this.applyStyleControlValues(preset);
      await this.applyLayoutControls({ userInitiated: false });
      this.state.styleMeta.currentPreset = presetKey;
      this.state.styleMeta.manualLayoutEdited = false;
      this.state.styleMeta.presetModified = false;
      this.state.styleMeta.templateModified = Boolean(this.state.styleMeta.currentTemplate);
      this.setStyleWarning(overwritesManualValues ? "Preset overwrote manual size/font/layout values." : "");
      this.updateStyleFeedback();
      this.setPublicationStatus(`${preset.label} preset applied.`);
    }

    applyTemplateTraceDefaults(traceDefaults) {
      if (!traceDefaults) {
        return;
      }
      this.state.data.forEach((trace) => {
        if (Number.isFinite(Number(traceDefaults.lineWidth))) {
          if (!trace.line) {
            trace.line = {};
          }
          trace.line.width = Math.max(0, Number(traceDefaults.lineWidth));
        }
        if (Number.isFinite(Number(traceDefaults.markerSize)) && hasMarkerControls(trace)) {
          if (!trace.marker) {
            trace.marker = {};
          }
          trace.marker.size = Math.max(0, Number(traceDefaults.markerSize));
        }
        if (Number.isFinite(Number(traceDefaults.opacity))) {
          trace.opacity = Math.min(1, Math.max(0, Number(traceDefaults.opacity)));
        }
      });
    }

    async applyDefaultStyleTemplate() {
      if (!this.hasFigure()) {
        return;
      }
      this.pushStyleSnapshot("default style template");
      const defaults = this.getDefaultLayoutSnapshot();
      this.state.layout = defaults.layout;
      this.state.exportSettings = defaults.exportSettings;
      this.state.data.forEach((trace, index) => restoreTraceStyles(trace, this.state.defaultTraceStyles[index]));
      this.reapplyScientificStyleState();
      this.state.styleMeta.currentPreset = "default";
      this.state.styleMeta.currentTemplate = "default";
      this.state.styleMeta.manualLayoutEdited = false;
      this.state.styleMeta.presetModified = false;
      this.state.styleMeta.templateModified = false;
      this.syncControlsFromFigure();
      this.renderTraceControls();
      await this.render();
      this.setStyleWarning("");
      this.updateStyleFeedback();
      this.setPublicationStatus("Default style template restored.");
    }

    async applyStyleTemplate(templateKey) {
      if (templateKey === "default") {
        await this.applyDefaultStyleTemplate();
        return;
      }
      const template = STYLE_TEMPLATES[templateKey];
      if (!template || !this.hasFigure()) {
        this.updateStyleFeedback();
        return;
      }

      this.pushStyleSnapshot("style template");
      this.applyStyleControlValues(template.controls);
      const controlUpdate = this.buildLayoutUpdate();
      Object.keys(controlUpdate).forEach((path) => setNested(this.state.layout, path, controlUpdate[path]));
      Object.keys(template.layout || {}).forEach((path) => setNested(this.state.layout, path, template.layout[path]));
      this.applyTemplateTraceDefaults(template.traces);
      this.state.styleMeta.presetModified = Boolean(this.state.styleMeta.currentPreset);
      this.state.styleMeta.currentTemplate = templateKey;
      this.state.styleMeta.templateModified = false;
      this.renderTraceControls();
      await this.render();
      this.setStyleWarning("");
      this.updateStyleFeedback();
      this.setPublicationStatus(`${template.label} style template applied.`);
    }

    async undoStyleChange() {
      if (!this.styleHistory.length) {
        return;
      }
      const snapshot = this.styleHistory.pop();
      this.state.data = deepCopy(snapshot.data);
      this.state.layout = deepCopy(snapshot.layout);
      this.state.exportSettings = deepCopy(snapshot.exportSettings);
      this.state.styleMeta = createStyleMeta(snapshot.styleMeta);
      this.state.scientificStyleEnabled = Boolean(snapshot.scientificStyleEnabled);
      this.syncControlsFromFigure();
      this.renderTraceControls();
      await this.render();
      this.setStyleWarning("");
      this.updateStyleFeedback();
      this.setPublicationStatus("Previous publication style restored.");
    }

    async applyBatchTraceStyle(kind) {
      if (!this.hasFigure()) {
        return;
      }

      let input = null;
      if (kind === "line-width") {
        input = this.dom.batchLineWidth;
      } else if (kind === "marker-size") {
        input = this.dom.batchMarkerSize;
      } else if (kind === "opacity") {
        input = this.dom.batchOpacity;
      }
      const value = input ? Number(input.value) : NaN;
      if (!Number.isFinite(value)) {
        this.setStyleWarning("Enter a valid trace style value.");
        return;
      }

      this.pushStyleSnapshot("trace batch style");
      if (kind === "line-width") {
        this.state.data.forEach((trace) => {
          if (!trace.line) {
            trace.line = {};
          }
          trace.line.width = Math.max(0, value);
        });
        this.setPublicationStatus("Line width applied to all traces.");
      } else if (kind === "marker-size") {
        this.state.data.forEach((trace) => {
          if (hasMarkerControls(trace)) {
            if (!trace.marker) {
              trace.marker = {};
            }
            trace.marker.size = Math.max(0, value);
          }
        });
        this.setPublicationStatus("Marker size applied to traces with markers.");
      } else if (kind === "opacity") {
        const opacity = Math.min(1, Math.max(0, value));
        this.state.data.forEach((trace) => {
          trace.opacity = opacity;
        });
        if (input) {
          input.value = opacity;
        }
        this.setPublicationStatus("Opacity applied to all traces.");
      }
      this.state.styleMeta.templateModified = Boolean(this.state.styleMeta.currentTemplate);
      this.setStyleWarning("");
      this.renderTraceControls();
      await this.render();
      this.updateStyleFeedback();
    }

    async resetAllTraceStyles() {
      if (!this.hasFigure()) {
        return;
      }
      this.pushStyleSnapshot("trace style reset");
      this.state.data.forEach((trace, index) => restoreTraceStyles(trace, this.state.defaultTraceStyles[index]));
      this.reapplyScientificStyleState();
      this.state.styleMeta.templateModified = Boolean(this.state.styleMeta.currentTemplate);
      this.setStyleWarning("");
      this.renderTraceControls();
      await this.render();
      this.updateStyleFeedback();
      this.setPublicationStatus("Trace styles reset to imported defaults.");
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
      this.state.styleMeta.manualLayoutEdited = true;
      this.state.styleMeta.presetModified = Boolean(this.state.styleMeta.currentPreset);
      this.state.styleMeta.templateModified = Boolean(this.state.styleMeta.currentTemplate);
      this.updateStyleFeedback();
      this.setPublicationStatus("Axis autorange restored.");
    }

    renderTraceControls() {
      domUtils.clear(this.dom.traceList);

      if (!this.hasFigure()) {
        this.dom.traceList.appendChild(domUtils.el("div", {
          className: "empty-state",
          text: "No traces loaded.",
        }));
        return;
      }

      this.state.data.forEach((trace, index) => {
        const traceColor = hexColor(
          (trace.line && trace.line.color) || (trace.marker && trace.marker.color),
          FALLBACK_TRACE_COLOR
        );
        const lineWidth = toFiniteNumber(trace.line && trace.line.width, 2);
        const lineDash = LINE_DASHES.includes(trace.line && trace.line.dash)
          ? trace.line.dash
          : "solid";
        const markerSize = toFiniteNumber(trace.marker && trace.marker.size, 6);

        const visibleInput = domUtils.el("input", {
          attrs: {
            type: "checkbox",
            "data-trace-index": index,
            "data-trace-field": "visible",
          },
          props: { checked: !(trace.visible === false || trace.visible === "legendonly") },
        });
        const title = domUtils.el("div", { className: "trace-editor-title" }, [
          domUtils.el("span", { text: "Trace " + (index + 1) }),
          domUtils.el("label", { className: "checkbox-row checkbox-row-compact" }, [
            visibleInput,
            "Visible",
          ]),
        ]);

        const traceStyleGrid = domUtils.el("div", { className: "trace-style-grid" }, [
          buildTraceInputField(index, "Line Color", "color", "color", traceColor),
          buildTraceInputField(index, "Line Width", "line-width", "number", lineWidth, {
            min: "0",
            max: "20",
            step: "0.2",
          }),
          buildTraceDashField(index, lineDash),
        ]);

        if (hasMarkerControls(trace)) {
          traceStyleGrid.appendChild(
            buildTraceInputField(index, "Marker Size", "marker-size", "number", markerSize, {
              min: "0",
              max: "40",
              step: "0.5",
            })
          );
        }

        this.dom.traceList.appendChild(domUtils.el("div", { className: "trace-editor-card" }, [
          title,
          domUtils.el("div", { className: "field-grid" }, [
            buildTraceInputField(index, "Trace Display Name", "name", "text", trace.name || ""),
            traceStyleGrid,
          ]),
        ]));
      });
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
        if (trace.error_y && this.state.scientificStyleEnabled && this.charts.isScientificSurfaceTensionTrace(trace)) {
          trace.error_y.color = input.value;
          update["error_y.color"] = input.value;
        }
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

      this.state.styleMeta.templateModified = Boolean(this.state.styleMeta.currentTemplate);
      await Plotly.restyle(this.dom.canvas, update, [index]);
      this.updateStyleFeedback();
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

    getSessionState() {
      return deepCopy(this.state);
    }

    async restoreSessionState(sessionState) {
      const warnings = [];
      const input = sessionState && typeof sessionState === "object" ? sessionState : {};
      const data = Array.isArray(input.data) ? deepCopy(input.data) : [];
      const layout = input.layout && typeof input.layout === "object" ? deepCopy(input.layout) : {};
      const config = input.config && typeof input.config === "object"
        ? deepCopy(input.config)
        : { responsive: true, displaylogo: false, editable: false };
      const figurePayload = input.figurePayload && typeof input.figurePayload === "object"
        ? {
            data: Array.isArray(input.figurePayload.data) ? deepCopy(input.figurePayload.data) : deepCopy(data),
            layout: input.figurePayload.layout && typeof input.figurePayload.layout === "object"
              ? deepCopy(input.figurePayload.layout)
              : deepCopy(layout),
            config: input.figurePayload.config && typeof input.figurePayload.config === "object"
              ? deepCopy(input.figurePayload.config)
              : deepCopy(config),
          }
        : {
            data: deepCopy(data),
            layout: deepCopy(layout),
            config: deepCopy(config),
          };
      const exportSettings = input.exportSettings && typeof input.exportSettings === "object"
        ? deepCopy(input.exportSettings)
        : {};
      const defaultTraceStyles = Array.isArray(input.defaultTraceStyles)
        ? deepCopy(input.defaultTraceStyles)
        : cloneTraceStyles(figurePayload.data);
      const defaultExportSettings = hasObjectEntries(input.defaultExportSettings)
        ? deepCopy(input.defaultExportSettings)
        : {
            width: toFiniteNumber(exportSettings.width || figurePayload.layout.width || layout.width, DEFAULT_WIDTH),
            height: toFiniteNumber(exportSettings.height || figurePayload.layout.height || layout.height, DEFAULT_HEIGHT),
          };
      const defaultLayout = hasObjectEntries(input.defaultLayout)
        ? deepCopy(input.defaultLayout)
        : createDefaultLayoutFromPayload(figurePayload, defaultExportSettings);

      this.state = {
        sourceType: typeof input.sourceType === "string" ? input.sourceType : "imported-session",
        sourceTitle: typeof input.sourceTitle === "string" ? input.sourceTitle : "Imported session",
        filenameBase: typeof input.filenameBase === "string" ? input.filenameBase : "publication-plot",
        figurePayload,
        data,
        layout,
        config: {
          ...config,
          responsive: true,
          displaylogo: false,
          editable: false,
        },
        exportSettings: {
          width: toFiniteNumber(exportSettings.width || layout.width, DEFAULT_WIDTH),
          height: toFiniteNumber(exportSettings.height || layout.height, DEFAULT_HEIGHT),
        },
        defaultLayout,
        defaultExportSettings,
        defaultTraceStyles,
        scientificStyleEnabled: typeof input.scientificStyleEnabled === "boolean"
          ? input.scientificStyleEnabled
          : data.some((trace) => Boolean(
              trace && trace.meta && trace.meta.surfaceLab && trace.meta.surfaceLab.scientificStyleEnabled
            )),
        styleMeta: createStyleMeta(input.styleMeta),
      };
      this.styleHistory = [];

      if (!this.hasFigure()) {
        warnings.push("Publication Plot did not contain trace data to restore.");
        this.renderTraceControls();
        this.syncEnabledState();
        this.updateStyleFeedback();
        this.setPublicationStatus("No publication figure was restored from the session.");
        await this.render();
        return warnings;
      }

      this.state.layout.width = this.state.exportSettings.width;
      this.state.layout.height = this.state.exportSettings.height;
      this.state.layout.autosize = false;
      this.syncControlsFromFigure();
      this.renderTraceControls();
      await this.render();
      this.syncEnabledState();
      this.setStyleWarning("");
      this.updateStyleFeedback();
      this.setPublicationStatus("Publication Plot restored from imported session.");
      return warnings;
    }
  }

  window.SurfaceLabPublicationPlot = {
    createController(options) {
      return new PublicationPlotController(options);
    },
  };
})();
