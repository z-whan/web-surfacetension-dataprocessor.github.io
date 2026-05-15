const assert = require("assert");

let captured = null;

globalThis.window = globalThis;
globalThis.SurfaceLabDomUtils = {
  escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  },
};
globalThis.Plotly = {
  async react(target, data, layout, config) {
    captured = { target, data, layout, config };
  },
};

require("../assets/js/charts.js");

const charts = globalThis.SurfaceLabCharts;
assert(charts, "SurfaceLabCharts should attach to globalThis");

(async () => {
  await charts.renderTimeSeriesPlot(
    {},
    {
      xLabel: "Time (ms)",
      series: [
        { name: "Exp 1 σ", experimentIndex: 1, x: [1000, 2000], y: [70, 71] },
      ],
      volumeOverlay: {
        yLabel: "Droplet volume, V (μL)",
        series: [
          { name: "Exp 1 V", experimentIndex: 1, x: [1000, 2000], y: [11.1, 11.0] },
        ],
      },
    },
    {
      trendPayload: {
        series: [
          { name: "Exp 1", experimentIndex: 1, x: [1000, 2000], y: [70.1, 70.9] },
        ],
      },
      showRaw: true,
      showVolumeOverlay: true,
    }
  );

  assert.strictEqual(captured.data.length, 3);
  assert.strictEqual(captured.data[0].line.dash, undefined, "raw surface tension should remain solid");
  assert.strictEqual(captured.data[1].line.dash, "dash", "trend trace should remain dashed");
  assert.strictEqual(captured.data[2].yaxis, "y2");
  assert.strictEqual(captured.data[2].line.dash, "dot");
  assert.strictEqual(captured.data[2].legendgroup, "exp-1");
  assert.strictEqual(captured.layout.yaxis2.title.text, "Droplet volume, V (μL)");

  await charts.renderTimeSeriesPlot(
    {},
    {
      xLabel: "Time (ms)",
      series: [
        { name: "Exp 1 σ", experimentIndex: 1, x: [1000, 2000], y: [70, 71] },
      ],
      volumeOverlay: {
        yLabel: "Droplet volume, V (μL)",
        series: [
          { name: "Exp 1 V", experimentIndex: 1, x: [1000, 2000], y: [11.1, 11.0] },
        ],
      },
    },
    {
      showRaw: false,
      showVolumeOverlay: true,
    }
  );

  assert.strictEqual(captured.data.length, 1);
  assert.strictEqual(captured.data[0].name, "Exp 1 V");
  assert.strictEqual(captured.data[0].yaxis, "y2");
  assert.strictEqual(captured.data[0].line.dash, "dot");

  await charts.renderComparePlot(
    {},
    [
      {
        displayIndex: 1,
        displayLabel: "#1",
        selection: "Exp 1 σ",
        dataType: "raw",
        x: [1000, 2000],
        y: [70, 71],
      },
      {
        displayIndex: 2,
        displayLabel: "#2",
        selection: "Exp 1 V",
        dataType: "volume",
        yAxis: "y2",
        x: [1000, 2000],
        y: [11.1, 11.0],
      },
    ],
    {
      xLabel: "Time (ms)",
      yLabel: "I.T. (mN/m)",
      secondaryYLabel: "Droplet volume, V (μL)",
    }
  );

  assert.strictEqual(captured.data.length, 2);
  assert.strictEqual(captured.data[0].line.dash, "solid");
  assert.strictEqual(captured.data[1].yaxis, "y2");
  assert.strictEqual(captured.data[1].line.dash, "dot");
  assert.strictEqual(captured.layout.yaxis.title.text, "I.T. (mN/m)");
  assert.strictEqual(captured.layout.yaxis2.title.text, "Droplet volume, V (μL)");

  await charts.renderCmcPlot(
    {},
    {
      xLabel: "Concentration C (mM)",
      points: [
        { x: 0.01, y: 70, error: 0.2, filename: "a.csv", concentration: 0.01, dropletCount: 3 },
        { x: 0.1, y: 55, error: 0.15, filename: "b.csv", concentration: 0.1, dropletCount: 3 },
      ],
    }
  );
  assert.strictEqual(captured.data.length, 1);
  assert.strictEqual(captured.data[0].name, undefined);

  await charts.renderCmcPlot(
    {},
    {
      xLabel: "Concentration C (mM)",
      points: [
        { x: 0.01, y: 70, error: 0.2, filename: "a.csv", concentration: 0.01, dropletCount: 3 },
        { x: 0.1, y: 55, error: 0.15, filename: "b.csv", concentration: 0.1, dropletCount: 3 },
      ],
      fit: {
        cmc: 0.08,
        fitSeries: [{ name: "CMC fit", x: [0.01, 0.1], y: [70, 55] }],
        cmcMarker: { x: 0.08, y: 56, label: "CMC" },
      },
    }
  );
  assert.strictEqual(captured.data.length, 3);
  assert.strictEqual(captured.data[1].name, "CMC fit");
  assert.strictEqual(captured.data[1].line.dash, "dash");
  assert.strictEqual(captured.data[2].name, "CMC");
  assert.strictEqual(captured.layout.shapes.length, 1);

  console.log("charts tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
