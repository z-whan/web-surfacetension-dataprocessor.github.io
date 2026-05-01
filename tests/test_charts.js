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

  console.log("charts tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
