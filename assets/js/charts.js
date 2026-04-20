(function () {
  const PAPER_COLOR = "rgba(11, 18, 21, 0)";
  const GRID_COLOR = "rgba(46, 82, 78, 0.18)";
  const FONT_FAMILY = "'IBM Plex Sans', sans-serif";
  const TEXT_COLOR = "#123438";
  const PALETTE = ["#145a55", "#c75c2a", "#456fb3", "#7c5f98", "#3f7d5c", "#bb3e6d"];

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
        linecolor: "rgba(18, 52, 56, 0.35)",
        mirror: true,
      },
      yaxis: {
        title: { text: options.yLabel },
        gridcolor: GRID_COLOR,
        zeroline: false,
        linecolor: "rgba(18, 52, 56, 0.35)",
        mirror: true,
      },
      legend: {
        bgcolor: "rgba(255,255,255,0.72)",
        borderwidth: 0,
        orientation: "h",
        yanchor: "bottom",
        y: 1.02,
        xanchor: "left",
        x: 0,
      },
    };
  }

  async function renderTimeSeriesPlot(target, payload) {
    const traces = payload.series.map((series, index) => ({
      type: "scatter",
      mode: "lines",
      name: series.name,
      x: series.x,
      y: series.y,
      line: { width: 2.2, color: PALETTE[index % PALETTE.length] },
    }));

    await Plotly.react(
      target,
      traces,
      baseLayout({
        xLabel: payload.xLabel,
        yLabel: "I.T. (mN/m)",
        title: "Time-series Plot",
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
        size: 10,
        color: "#145a55",
        line: { width: 1.5, color: "#e9f2ef" },
      },
      line: { width: 2.6, color: "#c75c2a" },
      error_y: {
        type: "data",
        array: payload.points.map((point) => point.error || 0),
        visible: true,
        color: "#145a55",
        thickness: 1.4,
        width: 6,
      },
    };

    await Plotly.react(
      target,
      [trace],
      baseLayout({
        xLabel: payload.xLabel,
        yLabel: "Surface tension γ (mN/m)",
        title: "CMC Curve",
      }),
      { responsive: true, displaylogo: false }
    );
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
    renderTimeSeriesPlot,
    renderCmcPlot,
    exportPlotAsPng,
  };
})();
