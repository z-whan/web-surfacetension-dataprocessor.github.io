(function () {
  const domUtils = window.SurfaceLabDomUtils;
  const PAPER_COLOR = "#ffffff";
  const GRID_COLOR = "#d9d9d9";
  const FONT_FAMILY = "Arial, Helvetica, sans-serif";
  const TEXT_COLOR = "#1f1f1f";
  // High-chroma, color-vision-friendly colors based on the Okabe-Ito palette.
  // Keep every plot on this shared sequence so a series stays recognizable
  // when it moves between analysis, comparison, and publication views.
  const SERIES_PALETTE = Object.freeze([
    "#0072B2",
    "#D55E00",
    "#009E73",
    "#CC79A7",
    "#E69F00",
    "#56B4E9",
    "#332288",
    "#AA4499",
  ]);
  const CMC_COLORS = Object.freeze({
    point: SERIES_PALETTE[0],
    warning: SERIES_PALETTE[1],
    curve: SERIES_PALETTE[6],
    marker: SERIES_PALETTE[3],
  });

  function seriesColor(index) {
    return SERIES_PALETTE[index % SERIES_PALETTE.length];
  }

  function finiteNumberOrNull(value) {
    if (value === null || typeof value === "undefined" || value === "") {
      return null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function scientificWindowSize(length) {
    const count = Math.max(0, Number(length) || 0);
    if (count < 3) {
      return 1;
    }
    let windowSize = Math.max(5, Math.min(21, Math.round(count * 0.01)));
    if (windowSize % 2 === 0) {
      windowSize += 1;
    }
    const largestOdd = count % 2 === 0 ? count - 1 : count;
    return Math.max(3, Math.min(windowSize, largestOdd));
  }

  function numericXValues(values, length) {
    const source = Array.isArray(values) ? values : [];
    return Array.from({ length }, (_, index) => {
      const numeric = finiteNumberOrNull(source[index]);
      return numeric === null ? index : numeric;
    });
  }

  function localLinearSmooth(xValues, values, windowSize) {
    const source = Array.isArray(values) ? values : [];
    const x = numericXValues(xValues, source.length);
    const halfWindow = Math.floor(windowSize / 2);

    return source.map((value, index) => {
      const radius = Math.min(halfWindow, index, source.length - 1 - index);
      if (radius === 0) {
        return finiteNumberOrNull(value);
      }
      const start = index - radius;
      const end = index + radius;
      const samples = [];
      for (let sampleIndex = start; sampleIndex <= end; sampleIndex += 1) {
        const numeric = finiteNumberOrNull(source[sampleIndex]);
        if (numeric !== null) {
          samples.push({ dx: x[sampleIndex] - x[index], y: numeric });
        }
      }
      if (!samples.length) {
        return null;
      }
      if (samples.length === 1) {
        return samples[0].y;
      }

      const scale = Math.max(...samples.map((sample) => Math.abs(sample.dx)));
      let sumW = 0;
      let sumWX = 0;
      let sumWXX = 0;
      let sumWY = 0;
      let sumWXY = 0;
      samples.forEach((sample) => {
        const ratio = scale > 0 ? Math.min(0.999999, Math.abs(sample.dx) / scale) : 0;
        const weight = Math.pow(1 - Math.pow(ratio, 3), 3);
        sumW += weight;
        sumWX += weight * sample.dx;
        sumWXX += weight * sample.dx * sample.dx;
        sumWY += weight * sample.y;
        sumWXY += weight * sample.dx * sample.y;
      });

      const denominator = sumW * sumWXX - sumWX * sumWX;
      if (Math.abs(denominator) < 1e-12) {
        const currentValue = finiteNumberOrNull(value);
        return sumW > 0 ? sumWY / sumW : currentValue;
      }
      // The intercept is the fitted value at the current time (dx = 0).
      // Near the boundaries the symmetric window shrinks progressively, so
      // the first and last observations stay unchanged instead of becoming
      // one-sided averages of future or past values.
      return (sumWY * sumWXX - sumWXY * sumWX) / denominator;
    });
  }

  function localResidualErrors(values, smoothed, windowSize) {
    const source = Array.isArray(values) ? values : [];
    const halfWindow = Math.floor(windowSize / 2);
    return source.map((value, index) => {
      const residuals = [];
      const radius = Math.min(halfWindow, index, source.length - 1 - index);
      const start = index - radius;
      const end = index + radius;
      for (let sampleIndex = start; sampleIndex <= end; sampleIndex += 1) {
        const observed = finiteNumberOrNull(source[sampleIndex]);
        const fitted = finiteNumberOrNull(smoothed[sampleIndex]);
        if (observed !== null && fitted !== null) {
          residuals.push(observed - fitted);
        }
      }
      if (residuals.length < 3) {
        return null;
      }
      const mean = residuals.reduce((sum, residual) => sum + residual, 0) / residuals.length;
      const variance = residuals.reduce(
        (sum, residual) => sum + Math.pow(residual - mean, 2),
        0
      ) / (residuals.length - 1);
      return Math.sqrt(variance);
    });
  }

  function buildScientificSeries(values, xValues, suppliedErrors) {
    const source = Array.isArray(values) ? values : [];
    const windowSize = scientificWindowSize(source.length);
    const errorStep = Math.max(1, Math.ceil(source.length / 24));
    const y = localLinearSmooth(xValues, source, windowSize);
    const hasSuppliedErrors = Array.isArray(suppliedErrors) && suppliedErrors.some((value) =>
      finiteNumberOrNull(value) !== null
    );
    const fullError = hasSuppliedErrors
      ? suppliedErrors.map((value) => {
          const numeric = finiteNumberOrNull(value);
          return numeric === null ? null : Math.abs(numeric);
        })
      : localResidualErrors(source, y, windowSize);
    const error = fullError.map((value, index) =>
      index % errorStep === 0 || index === source.length - 1 ? value : null
    );

    return {
      y,
      error,
      windowSize,
      errorKind: hasSuppliedErrors ? "replicate-sd" : "local-residual-sd",
    };
  }

  function surfaceLabMeta(trace) {
    const meta = trace && trace.meta;
    return meta && typeof meta === "object" && !Array.isArray(meta) && meta.surfaceLab
      ? meta.surfaceLab
      : null;
  }

  function isScientificSurfaceTensionTrace(trace) {
    const meta = surfaceLabMeta(trace);
    return Boolean(meta && meta.dataType === "surface-tension" && Array.isArray(meta.originalY));
  }

  function applyScientificTraceStyle(
    trace,
    enabled,
    originalY,
    originalX,
    suppliedErrors,
    suppliedErrorKind
  ) {
    if (!trace || typeof trace !== "object") {
      return trace;
    }
    const existingMeta = trace.meta && typeof trace.meta === "object" && !Array.isArray(trace.meta)
      ? trace.meta
      : {};
    const existingSurfaceLab = existingMeta.surfaceLab && typeof existingMeta.surfaceLab === "object"
      ? existingMeta.surfaceLab
      : {};
    const rawY = Array.isArray(existingSurfaceLab.originalY)
      ? existingSurfaceLab.originalY.slice()
      : (Array.isArray(originalY) ? originalY.slice() : Array.isArray(trace.y) ? trace.y.slice() : []);
    const rawX = Array.isArray(existingSurfaceLab.originalX)
      ? existingSurfaceLab.originalX.slice()
      : (Array.isArray(originalX) ? originalX.slice() : Array.isArray(trace.x) ? trace.x.slice() : []);
    const errorValues = Array.isArray(existingSurfaceLab.errorValues)
      ? existingSurfaceLab.errorValues.slice()
      : (Array.isArray(suppliedErrors) ? suppliedErrors.slice() : null);
    const baseLineShape = Object.prototype.hasOwnProperty.call(existingSurfaceLab, "baseLineShape")
      ? existingSurfaceLab.baseLineShape
      : (trace.line && Object.prototype.hasOwnProperty.call(trace.line, "shape") ? trace.line.shape : null);
    const baseLineSmoothing = Object.prototype.hasOwnProperty.call(existingSurfaceLab, "baseLineSmoothing")
      ? existingSurfaceLab.baseLineSmoothing
      : (trace.line && Object.prototype.hasOwnProperty.call(trace.line, "smoothing") ? trace.line.smoothing : null);
    const originalErrorY = Object.prototype.hasOwnProperty.call(existingSurfaceLab, "originalErrorY")
      ? existingSurfaceLab.originalErrorY
      : (trace.error_y ? JSON.parse(JSON.stringify(trace.error_y)) : null);

    trace.meta = {
      ...existingMeta,
      surfaceLab: {
        ...existingSurfaceLab,
        dataType: "surface-tension",
        originalY: rawY,
        originalX: rawX,
        errorValues,
        errorKind: suppliedErrorKind || existingSurfaceLab.errorKind || (errorValues ? "replicate-sd" : "local-residual-sd"),
        originalErrorY,
        baseLineShape,
        baseLineSmoothing,
        scientificStyleEnabled: Boolean(enabled),
      },
    };
    trace.line = trace.line || {};

    if (enabled) {
      const scientific = buildScientificSeries(rawY, rawX, errorValues);
      trace.y = scientific.y;
      trace.line.shape = "spline";
      trace.line.smoothing = 0.65;
      trace.error_y = {
        type: "data",
        array: scientific.error,
        visible: true,
        color: trace.line.color || TEXT_COLOR,
        thickness: 1.1,
        width: 4,
      };
      trace.meta.surfaceLab.errorKind = scientific.errorKind;
    } else {
      trace.y = rawY;
      if (baseLineShape === null || typeof baseLineShape === "undefined") {
        delete trace.line.shape;
      } else {
        trace.line.shape = baseLineShape;
      }
      if (baseLineSmoothing === null || typeof baseLineSmoothing === "undefined") {
        delete trace.line.smoothing;
      } else {
        trace.line.smoothing = baseLineSmoothing;
      }
      if (originalErrorY) {
        trace.error_y = JSON.parse(JSON.stringify(originalErrorY));
      } else {
        delete trace.error_y;
      }
    }
    return trace;
  }

  function scientificRangeSeries(seriesList) {
    return seriesList.map((series) => {
      const scientific = buildScientificSeries(series.y, series.x, series.error);
      const rangeValues = [];
      scientific.y.forEach((value, index) => {
        const numeric = finiteNumberOrNull(value);
        const deviation = finiteNumberOrNull(scientific.error[index]);
        if (numeric === null) {
          return;
        }
        rangeValues.push(numeric);
        if (deviation !== null) {
          rangeValues.push(numeric - deviation, numeric + deviation);
        }
      });
      return { y: rangeValues };
    });
  }

  function resolveScientificSeriesYRange(seriesList, options) {
    return resolveSeriesYRange(scientificRangeSeries(seriesList), options);
  }

  function baseLayout(options) {
    const layout = {
      title: { text: options.title, font: { size: 18, family: FONT_FAMILY, color: TEXT_COLOR } },
      paper_bgcolor: PAPER_COLOR,
      plot_bgcolor: PAPER_COLOR,
      margin: { l: 64, r: options.secondaryY ? 76 : 24, t: 56, b: 64 },
      font: { family: FONT_FAMILY, color: TEXT_COLOR, size: 13 },
      xaxis: {
        title: { text: options.xLabel },
        gridcolor: GRID_COLOR,
        zeroline: false,
        linecolor: "#999999",
        mirror: true,
        type: options.xScale === "log" ? "log" : "linear",
      },
      yaxis: {
        title: { text: options.yLabel },
        gridcolor: GRID_COLOR,
        zeroline: false,
        linecolor: "#999999",
        mirror: true,
        type: options.yScale === "log" ? "log" : "linear",
        range: options.yRange || undefined,
      },
      legend: {
        bgcolor: "#ffffff",
        bordercolor: "#d9d9d9",
        borderwidth: 1,
        orientation: "h",
        yanchor: "bottom",
        y: 1.02,
        xanchor: "left",
        x: 0,
      },
    };

    if (options.secondaryY) {
      layout.yaxis2 = {
        title: { text: options.secondaryYLabel || "Droplet volume, V (μL)" },
        overlaying: "y",
        side: "right",
        zeroline: false,
        linecolor: "#999999",
        showgrid: false,
      };
    }

    return layout;
  }

  function appendFiniteValues(values, seriesList) {
    seriesList.forEach((series) => {
      series.y.forEach((value) => {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) {
          values.push(numeric);
        }
      });
    });
  }

  function computeYRange(seriesList, spanPercent) {
    const values = [];
    appendFiniteValues(values, seriesList);

    if (!values.length) {
      return null;
    }

    let minValue = values[0];
    let maxValue = values[0];
    values.forEach((value) => {
      if (value < minValue) {
        minValue = value;
      }
      if (value > maxValue) {
        maxValue = value;
      }
    });

    const midpoint = (minValue + maxValue) / 2;
    const baseSpan =
      maxValue > minValue ? maxValue - minValue : Math.max(Math.abs(midpoint) * 0.05, 1);
    const scale = Math.max(0.2, Number(spanPercent) || 1) / 100;
    const halfSpan = (baseSpan * scale) / 2;

    // Keep the slider intuitive by scaling the detected data span around the
    // visible midpoint. Lower values zoom in; higher values zoom out.
    return [midpoint - halfSpan, midpoint + halfSpan];
  }

  function resolveSeriesYRange(seriesList, options) {
    const opts = options || {};
    if (Array.isArray(opts.explicitYRange) && opts.explicitYRange.length === 2) {
      return opts.explicitYRange;
    }
    return computeYRange(seriesList, opts.ySpanPercent || 100);
  }

  function resolveTimeSeriesYRange(rawPayload, options) {
    const opts = options || {};
    const trendPayload = opts.trendPayload || null;
    const rawRangeSeries = opts.scientificStyle
      ? scientificRangeSeries(rawPayload.series)
      : rawPayload.series;
    const rangeSeries = trendPayload
      ? rawRangeSeries.concat(trendPayload.series)
      : rawRangeSeries;
    return resolveSeriesYRange(rangeSeries, opts);
  }

  function buildRawTrace(series, index) {
    const experimentIndex = Number(series.experimentIndex);
    const legendgroup = Number.isInteger(experimentIndex) ? `exp-${experimentIndex}` : undefined;
    return {
      type: "scatter",
      mode: "lines",
      name: series.name,
      x: series.x,
      y: series.y,
      line: { width: 1.8, color: seriesColor(index) },
      legendgroup,
    };
  }

  function isOriginalExperimentSeries(series) {
    return Number.isInteger(Number(series && series.experimentIndex));
  }

  function buildTrendTrace(series, index) {
    const experimentIndex = Number(series.experimentIndex);
    const legendgroup = Number.isInteger(experimentIndex) ? `exp-${experimentIndex}` : undefined;
    return {
      type: "scatter",
      mode: "lines",
      name: series.name + " trend",
      x: series.x,
      y: series.y,
      line: {
        width: 2.4,
        color: seriesColor(index),
        dash: "dash",
      },
      legendgroup,
    };
  }

  function matchingRawSeriesIndex(rawSeries, experimentIndex, fallbackIndex) {
    const target = Number(experimentIndex);
    if (Number.isInteger(target)) {
      const index = rawSeries.findIndex((series) => Number(series.experimentIndex) === target);
      if (index >= 0) {
        return index;
      }
    }
    return fallbackIndex;
  }

  function buildVolumeTrace(series, index, rawSeries) {
    const colorIndex = matchingRawSeriesIndex(rawSeries, series.experimentIndex, index);
    const experimentIndex = Number(series.experimentIndex);
    const legendgroup = Number.isInteger(experimentIndex) ? `exp-${experimentIndex}` : undefined;
    const experimentLabel = Number.isInteger(experimentIndex) ? `Exp ${experimentIndex}` : series.name;
    return {
      type: "scatter",
      mode: "lines",
      name: series.name || `${experimentLabel} V`,
      x: series.x,
      y: series.y,
      yaxis: "y2",
      line: {
        width: 1.2,
        color: seriesColor(colorIndex),
        dash: "dot",
      },
      opacity: 0.58,
      legendgroup,
      hovertemplate:
        `${domUtils.escapeHtml(experimentLabel)}<br>` +
        "Time: %{x}<br>" +
        "V: %{y:.6g} μL<extra></extra>",
    };
  }

  async function renderTimeSeriesPlot(target, rawPayload, options) {
    const opts = options || {};
    const trendPayload = opts.trendPayload || null;
    const showRaw = typeof opts.showRaw === "boolean" ? opts.showRaw : true;
    const showVolumeOverlay = Boolean(opts.showVolumeOverlay);
    const volumeOverlay =
      showVolumeOverlay && rawPayload.volumeOverlay && Array.isArray(rawPayload.volumeOverlay.series)
        ? rawPayload.volumeOverlay
        : null;
    const traces = [];

    rawPayload.series.forEach((series, index) => {
      if (!showRaw && isOriginalExperimentSeries(series)) {
        return;
      }
      const trace = applyScientificTraceStyle(
        buildRawTrace(series, index),
        Boolean(opts.scientificStyle),
        series.y,
        series.x,
        series.error,
        series.errorKind
      );
      if (trendPayload) {
        trace.line.width = 1.4;
        trace.opacity = 0.55;
        trace.name = series.name + " raw";
      }
      traces.push(trace);
    });

    if (trendPayload) {
      trendPayload.series.forEach((series, index) => {
        traces.push(buildTrendTrace(series, index));
      });
    }

    if (volumeOverlay) {
      volumeOverlay.series.forEach((series, index) => {
        traces.push(buildVolumeTrace(series, index, rawPayload.series));
      });
    }

    const yRange = resolveTimeSeriesYRange(rawPayload, opts);
    const hasVolumeTraces = Boolean(volumeOverlay && volumeOverlay.series.length);

    await Plotly.react(
      target,
      traces,
      baseLayout({
        xLabel: rawPayload.xLabel,
        yLabel: "I.T. (mN/m)",
        title: "Time-series Plot",
        xScale: "linear",
        yScale: "linear",
        yRange,
        secondaryY: hasVolumeTraces,
        secondaryYLabel: rawPayload.volumeOverlay && rawPayload.volumeOverlay.yLabel,
      }),
      { responsive: true, displaylogo: false }
    );
  }

  async function renderAnalysisPlot(target, payload) {
    const traces = payload.series.map((series, index) => ({
      type: "scatter",
      mode: "lines",
      name: series.name,
      x: series.x,
      y: series.y,
      line: { width: 2, color: seriesColor(index) },
    }));

    await Plotly.react(
      target,
      traces,
      baseLayout({
        xLabel: payload.xLabel,
        yLabel: payload.yLabel,
        title: payload.title,
        xScale: payload.xScale || "linear",
        yScale: payload.yScale || "linear",
      }),
      { responsive: true, displaylogo: false }
    );
  }

  async function renderComparePlot(target, curves, options) {
    const opts = options || {};
    const hasPrimaryCurves = curves.some((curve) => curve.dataType !== "volume" && curve.yAxis !== "y2");
    const hasVolumeCurves = curves.some((curve) => curve.dataType === "volume" || curve.yAxis === "y2");
    const primaryRangeCurves = hasPrimaryCurves
      ? curves.filter((curve) => curve.dataType !== "volume" && curve.yAxis !== "y2")
      : curves;
    const traces = curves.map((curve, index) => {
      const label = String(curve.displayLabel || "").trim() || "#" + curve.displayIndex;
      const hoverLabel = domUtils.escapeHtml(label);
      const hoverSelection = domUtils.escapeHtml(curve.selection || "");
      const isVolume = curve.dataType === "volume" || curve.yAxis === "y2";
      const yaxis = isVolume && hasPrimaryCurves ? "y2" : undefined;
      const trace = {
        type: "scatter",
        mode: "lines",
        name: label,
        x: curve.x,
        y: curve.y,
        yaxis,
        line: {
          width: isVolume ? 1.4 : 2,
          color: seriesColor(index),
          dash: isVolume ? "dot" : curve.dataType === "trend" ? "dash" : "solid",
        },
        opacity: isVolume ? 0.68 : undefined,
        hovertemplate: hoverLabel + "<br>" + hoverSelection + "<br>%{x}, %{y:.4f}<extra></extra>",
      };
      if (!isVolume && curve.dataType !== "trend") {
        applyScientificTraceStyle(
          trace,
          Boolean(opts.scientificStyle),
          curve.y,
          curve.x,
          curve.error,
          curve.errorKind
        );
      }
      return trace;
    });

    const rangeCurves = opts.scientificStyle && hasPrimaryCurves
      ? scientificRangeSeries(primaryRangeCurves.filter((curve) => curve.dataType !== "trend"))
          .concat(primaryRangeCurves.filter((curve) => curve.dataType === "trend"))
      : primaryRangeCurves;

    await Plotly.react(
      target,
      traces,
      baseLayout({
        xLabel: opts.xLabel || "Time",
        yLabel: hasPrimaryCurves ? opts.yLabel || "I.T. (mN/m)" : opts.secondaryYLabel || "Droplet volume, V (μL)",
        title: "Compare",
        xScale: "linear",
        yScale: "linear",
        yRange: resolveSeriesYRange(rangeCurves, opts),
        secondaryY: hasPrimaryCurves && hasVolumeCurves,
        secondaryYLabel: opts.secondaryYLabel || "Droplet volume, V (μL)",
      }),
      { responsive: true, displaylogo: false }
    );
  }

  async function renderCmcPlot(target, payload) {
    const traces = [];
    const trace = {
      type: "scatter",
      mode: "lines+markers",
      x: payload.points.map((point) => point.x),
      y: payload.points.map((point) => point.y),
      text: payload.points.map(
        (point) =>
          point.filename + "<br>C=" + point.concentration + "<br>Droplets=" + point.dropletCount
      ),
      hovertemplate: "%{text}<br>σ=%{y:.4f}<extra></extra>",
      marker: {
        size: 8,
        color: payload.points.map((point) =>
          Number(point.warningCount) > 0 ? CMC_COLORS.warning : CMC_COLORS.point
        ),
        symbol: payload.points.map((point) => Number(point.warningCount) > 0 ? "diamond" : "circle"),
        line: { width: 1, color: "#ffffff" },
      },
      line: { width: 2.2, color: CMC_COLORS.curve },
      error_y: {
        type: "data",
        array: payload.points.map((point) => point.error || 0),
        visible: true,
        color: CMC_COLORS.point,
        thickness: 1.2,
        width: 5,
      },
    };
    traces.push(trace);

    const fit = payload.fit || null;
    const fitSegments = fit && Array.isArray(fit.fitSegments) && fit.fitSegments.length
      ? fit.fitSegments
      : (fit && Array.isArray(fit.fitSeries) ? fit.fitSeries : []);
    if (fitSegments.length) {
      fitSegments.forEach((series, index) => {
        traces.push({
          type: "scatter",
          mode: "lines",
          name: series.name || "CMC fit",
          x: series.x || [],
          y: series.y || [],
          hovertemplate: "%{x}, σ=%{y:.4f}<extra></extra>",
          line: {
            width: 2,
            color: seriesColor(index + 2),
            dash: "dash",
          },
        });
      });
    }

    if (fit && fit.cmcMarker && Number.isFinite(Number(fit.cmcMarker.x)) && Number.isFinite(Number(fit.cmcMarker.y))) {
      traces.push({
        type: "scatter",
        mode: "markers",
        name: fit.cmcMarker.label || "CMC",
        x: [fit.cmcMarker.x],
        y: [fit.cmcMarker.y],
        hovertemplate:
          (fit.cmcMarker.label || "CMC") +
          "<br>C=" +
          (fit.cmc == null ? "n/a" : Number(fit.cmc).toPrecision(4)) +
          "<br>σ=%{y:.4f}<extra></extra>",
        marker: {
          size: 11,
          color: CMC_COLORS.marker,
          symbol: "diamond",
          line: { width: 1, color: "#ffffff" },
        },
      });
    }

    const layout = baseLayout({
      xLabel: payload.xLabel,
      yLabel: "Surface tension σ (mN/m)",
      title: "CMC Curve",
      xScale: "linear",
      yScale: "linear",
    });

    if (fit && fit.cmcMarker && Number.isFinite(Number(fit.cmcMarker.x))) {
      layout.shapes = [
        {
          type: "line",
          x0: fit.cmcMarker.x,
          x1: fit.cmcMarker.x,
          y0: 0,
          y1: 1,
          xref: "x",
          yref: "paper",
          line: {
            color: CMC_COLORS.marker,
            width: 1.2,
            dash: "dot",
          },
        },
      ];
    }

    await Plotly.react(
      target,
      traces,
      layout,
      { responsive: true, displaylogo: false }
    );
  }

  function clearPlot(target) {
    Plotly.react(target, [], baseLayout({ title: "", xLabel: "", yLabel: "", xScale: "linear", yScale: "linear" }), {
      responsive: true,
      displaylogo: false,
    });
  }

  function resolvePlotTarget(plotElementOrId) {
    if (typeof plotElementOrId === "string") {
      return document.getElementById(plotElementOrId);
    }
    return plotElementOrId;
  }

  function resolvePlotSize(target, options) {
    const opts = options || {};
    const rect = target && typeof target.getBoundingClientRect === "function"
      ? target.getBoundingClientRect()
      : null;

    return {
      width: Number(opts.width) || Math.round(rect && rect.width ? rect.width : 1400),
      height: Number(opts.height) || Math.round(rect && rect.height ? rect.height : 900),
    };
  }

  function sanitizeFilenameBase(value) {
    return String(value || "plot")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "plot";
  }

  async function exportPlotImage(plotElementOrId, filenameBase, options) {
    const target = resolvePlotTarget(plotElementOrId);
    const opts = options || {};
    const format = opts.format === "svg" ? "svg" : "png";
    const size = resolvePlotSize(target, opts);
    const downloadOptions = {
      format,
      width: size.width,
      height: size.height,
      filename: sanitizeFilenameBase(filenameBase),
    };

    if (format === "png" && opts.scale) {
      downloadOptions.scale = Number(opts.scale) || 1;
    }

    await Plotly.downloadImage(target, downloadOptions);
  }

  async function exportPlotAsPng(target, filename) {
    await exportPlotImage(target, filename, {
      format: "png",
      width: 1400,
      height: 900,
    });
  }

  window.SurfaceLabCharts = {
    clearPlot,
    renderAnalysisPlot,
    renderComparePlot,
    renderTimeSeriesPlot,
    renderCmcPlot,
    exportPlotImage,
    exportPlotAsPng,
    resolveSeriesYRange,
    resolveScientificSeriesYRange,
    resolveTimeSeriesYRange,
    buildScientificSeries,
    scientificRangeSeries,
    applyScientificTraceStyle,
    isScientificSurfaceTensionTrace,
    SERIES_PALETTE,
  };
})();
