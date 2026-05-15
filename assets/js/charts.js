(function () {
  const domUtils = window.SurfaceLabDomUtils;
  const PAPER_COLOR = "#ffffff";
  const GRID_COLOR = "#d9d9d9";
  const FONT_FAMILY = "Arial, Helvetica, sans-serif";
  const TEXT_COLOR = "#1f1f1f";
  const PALETTE = ["#2f5d8a", "#8a4f2f", "#3c7a5b", "#7a3c68", "#6a6a2f", "#2f6e73"];

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
    const rangeSeries = trendPayload
      ? rawPayload.series.concat(trendPayload.series)
      : rawPayload.series;
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
      line: { width: 1.8, color: PALETTE[index % PALETTE.length] },
      legendgroup,
    };
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
        color: PALETTE[index % PALETTE.length],
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
        color: PALETTE[colorIndex % PALETTE.length],
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

    if (showRaw) {
      rawPayload.series.forEach((series, index) => {
        const trace = buildRawTrace(series, index);
        if (trendPayload) {
          trace.line.width = 1.4;
          trace.opacity = 0.55;
          trace.name = series.name + " raw";
        }
        traces.push(trace);
      });
    }

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
      line: { width: 2, color: PALETTE[index % PALETTE.length] },
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
      return {
        type: "scatter",
        mode: "lines",
        name: label,
        x: curve.x,
        y: curve.y,
        yaxis,
        line: {
          width: isVolume ? 1.4 : 2,
          color: PALETTE[index % PALETTE.length],
          dash: isVolume ? "dot" : curve.dataType === "trend" ? "dash" : "solid",
        },
        opacity: isVolume ? 0.68 : undefined,
        hovertemplate: hoverLabel + "<br>" + hoverSelection + "<br>%{x}, %{y:.4f}<extra></extra>",
      };
    });

    await Plotly.react(
      target,
      traces,
      baseLayout({
        xLabel: opts.xLabel || "Time",
        yLabel: hasPrimaryCurves ? opts.yLabel || "I.T. (mN/m)" : opts.secondaryYLabel || "Droplet volume, V (μL)",
        title: "Compare",
        xScale: "linear",
        yScale: "linear",
        yRange: resolveSeriesYRange(primaryRangeCurves, opts),
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
        color: payload.points.map((point) => Number(point.warningCount) > 0 ? "#b56a2a" : "#2f5d8a"),
        symbol: payload.points.map((point) => Number(point.warningCount) > 0 ? "diamond" : "circle"),
        line: { width: 1, color: "#ffffff" },
      },
      line: { width: 2.2, color: "#8a4f2f" },
      error_y: {
        type: "data",
        array: payload.points.map((point) => point.error || 0),
        visible: true,
        color: "#2f5d8a",
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
            color: PALETTE[(index + 2) % PALETTE.length],
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
          color: "#3c7a5b",
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
            color: "#3c7a5b",
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
    resolveTimeSeriesYRange,
  };
})();
