(function () {
  const PAPER_COLOR = "#ffffff";
  const GRID_COLOR = "#d9d9d9";
  const FONT_FAMILY = "Arial, Helvetica, sans-serif";
  const TEXT_COLOR = "#1f1f1f";
  const PALETTE = ["#2f5d8a", "#8a4f2f", "#3c7a5b", "#7a3c68", "#6a6a2f", "#2f6e73"];

  function baseLayout(options) {
    return {
      title: { text: options.title, font: { size: 18, family: FONT_FAMILY, color: TEXT_COLOR } },
      paper_bgcolor: PAPER_COLOR,
      plot_bgcolor: PAPER_COLOR,
      margin: { l: 64, r: 24, t: 56, b: 64 },
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

  function buildRawTrace(series, index) {
    return {
      type: "scatter",
      mode: "lines",
      name: series.name,
      x: series.x,
      y: series.y,
      line: { width: 1.8, color: PALETTE[index % PALETTE.length] },
    };
  }

  function buildTrendTrace(series, index) {
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
    };
  }

  async function renderTimeSeriesPlot(target, rawPayload, options) {
    const opts = options || {};
    const trendPayload = opts.trendPayload || null;
    const showRaw = typeof opts.showRaw === "boolean" ? opts.showRaw : true;
    const traces = [];

    if (!trendPayload || showRaw) {
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

    const rangeSeries = trendPayload
      ? rawPayload.series.concat(trendPayload.series)
      : rawPayload.series;
    const yRange = computeYRange(rangeSeries, opts.ySpanPercent || 100);

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

  async function renderCmcPlot(target, payload) {
    const trace = {
      type: "scatter",
      mode: "lines+markers",
      x: payload.points.map((point) => point.x),
      y: payload.points.map((point) => point.y),
      text: payload.points.map(
        (point) =>
          point.filename + "<br>C=" + point.concentration + "<br>Droplets=" + point.dropletCount
      ),
      hovertemplate: "%{text}<br>γ=%{y:.4f}<extra></extra>",
      marker: {
        size: 8,
        color: "#2f5d8a",
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

    await Plotly.react(
      target,
      [trace],
      baseLayout({
        xLabel: payload.xLabel,
        yLabel: "Surface tension γ (mN/m)",
        title: "CMC Curve",
        xScale: "linear",
        yScale: "linear",
      }),
      { responsive: true, displaylogo: false }
    );
  }

  function clearPlot(target) {
    Plotly.react(target, [], baseLayout({ title: "", xLabel: "", yLabel: "", xScale: "linear", yScale: "linear" }), {
      responsive: true,
      displaylogo: false,
    });
  }

  async function exportPlotAsPng(target, filename) {
    await Plotly.downloadImage(target, {
      format: "png",
      width: 1400,
      height: 900,
      filename,
    });
  }

  window.SurfaceLabCharts = {
    clearPlot,
    renderAnalysisPlot,
    renderTimeSeriesPlot,
    renderCmcPlot,
    exportPlotAsPng,
  };
})();
