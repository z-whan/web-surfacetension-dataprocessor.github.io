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
assert.strictEqual(charts.SERIES_PALETTE.length, 8);
assert.strictEqual(
  new Set(charts.SERIES_PALETTE).size,
  charts.SERIES_PALETTE.length,
  "plot palette colors should all be distinct"
);

const declining = charts.buildScientificSeries(
  [80, 78, 76, 74, 72, 70, 68],
  [0, 1000, 2000, 3000, 4000, 5000, 6000]
);
assert(Math.abs(declining.y[0] - 80) < 1e-9, "boundary fit should preserve a linear initial value");
assert(Math.abs(declining.y[6] - 68) < 1e-9, "boundary fit should preserve a linear final value");
assert(declining.error.every((value) => value === null || Math.abs(value) < 1e-9));
assert.strictEqual(declining.errorKind, "local-residual-sd");

const nonlinearStart = charts.buildScientificSeries(
  [80, 72, 70, 69, 68, 67, 66],
  [0, 1000, 2000, 3000, 4000, 5000, 6000]
);
assert.strictEqual(nonlinearStart.y[0], 80, "the first observation must not be averaged with future times");
assert.strictEqual(nonlinearStart.error[0], null, "single traces must not invent boundary uncertainty");

const replicateUncertainty = charts.buildScientificSeries(
  [70, 69, 68, 67, 66],
  [0, 1, 2, 3, 4],
  [0.4, null, 0.2, 0.3, 0.4]
);
assert.deepStrictEqual(replicateUncertainty.error, [0.4, null, 0.2, 0.3, 0.4]);
assert.strictEqual(replicateUncertainty.errorKind, "replicate-sd");

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
  assert.strictEqual(captured.data[0].line.color, charts.SERIES_PALETTE[0]);
  assert.strictEqual(captured.data[1].line.color, charts.SERIES_PALETTE[0]);
  assert.strictEqual(captured.data[2].line.color, charts.SERIES_PALETTE[0]);
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
        {
          name: "Avg (1-3)",
          x: [1, 2, 3, 4, 5, 6, 7],
          y: [70, 73, 69, 74, 68, 72, 70],
          error: [0.5, 0.4, 0.3, 0.2, 0.3, 0.4, 0.5],
          errorKind: "replicate-sd",
        },
      ],
      volumeOverlay: {
        yLabel: "Droplet volume, V (μL)",
        series: [
          { name: "Exp 1 V", experimentIndex: 1, x: [1, 2, 3, 4, 5, 6, 7], y: [11, 10.9, 10.8, 10.7, 10.6, 10.5, 10.4] },
        ],
      },
    },
    {
      scientificStyle: true,
      showVolumeOverlay: true,
    }
  );

  assert.strictEqual(captured.data[0].line.shape, "spline");
  assert.strictEqual(captured.data[0].error_y.visible, true);
  assert.strictEqual(captured.data[0].meta.surfaceLab.dataType, "surface-tension");
  assert.strictEqual(captured.data[0].meta.surfaceLab.scientificStyleEnabled, true);
  assert.strictEqual(captured.data[0].meta.surfaceLab.errorKind, "replicate-sd");
  assert.strictEqual(captured.data[0].error_y.array[0], 0.5);
  assert.notDeepStrictEqual(captured.data[0].y, captured.data[0].meta.surfaceLab.originalY);
  assert.strictEqual(captured.data[1].error_y, undefined, "volume traces must not receive error bars");
  assert.strictEqual(captured.data[1].line.shape, undefined, "volume traces must not be smoothed");

  const scientificTrace = captured.data[0];
  charts.applyScientificTraceStyle(scientificTrace, false);
  assert.deepStrictEqual(scientificTrace.y, [70, 73, 69, 74, 68, 72, 70]);
  assert.strictEqual(scientificTrace.error_y, undefined);
  assert.strictEqual(scientificTrace.line.shape, undefined);

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

  await charts.renderTimeSeriesPlot(
    {},
    {
      xLabel: "Time (ms)",
      series: [
        { name: "Exp 1 σ", experimentIndex: 1, x: [1000, 2000], y: [70, 71] },
        { name: "Exp 2 σ", experimentIndex: 2, x: [1000, 2000], y: [72, 73] },
        { name: "Avg (1-2)", x: [1000, 2000], y: [71, 72] },
      ],
    },
    {
      showRaw: false,
    }
  );

  assert.strictEqual(captured.data.length, 1);
  assert.strictEqual(captured.data[0].name, "Avg (1-2)");
  assert.strictEqual(captured.data[0].line.dash, undefined);

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
  assert.strictEqual(captured.data[0].line.color, charts.SERIES_PALETTE[0]);
  assert.strictEqual(captured.data[1].line.color, charts.SERIES_PALETTE[1]);
  assert.strictEqual(captured.data[0].line.dash, "solid");
  assert.strictEqual(captured.data[1].yaxis, "y2");
  assert.strictEqual(captured.data[1].line.dash, "dot");
  assert.strictEqual(captured.layout.yaxis.title.text, "I.T. (mN/m)");
  assert.strictEqual(captured.layout.yaxis2.title.text, "Droplet volume, V (μL)");

  await charts.renderComparePlot(
    {},
    [
      {
        displayIndex: 1,
        displayLabel: "surface",
        selection: "Exp 1 σ",
        dataType: "raw",
        x: [1, 2, 3, 4, 5],
        y: [70, 72, 69, 73, 71],
        error: [0.3, 0.2, 0.25, 0.2, 0.3],
        errorKind: "replicate-sd",
      },
      {
        displayIndex: 2,
        displayLabel: "trend",
        selection: "Exp 1 trend",
        dataType: "trend",
        x: [1, 2, 3, 4, 5],
        y: [70, 70.5, 71, 71.5, 72],
      },
    ],
    { scientificStyle: true }
  );
  assert.strictEqual(captured.data[0].line.shape, "spline");
  assert.strictEqual(captured.data[0].error_y.visible, true);
  assert.strictEqual(captured.data[0].meta.surfaceLab.errorKind, "replicate-sd");
  assert.strictEqual(captured.data[0].error_y.array[0], 0.3);
  assert.strictEqual(captured.data[1].line.shape, undefined, "derived trend traces stay unchanged");
  assert.strictEqual(captured.data[1].error_y, undefined, "derived trend traces do not gain error bars");

  await charts.renderComparePlot(
    {},
    [
      {
        displayIndex: 1,
        displayLabel: "volume",
        selection: "Exp 1 V",
        dataType: "volume",
        yAxis: "y2",
        x: [1, 2, 3],
        y: [11, 10.5, 10],
      },
    ],
    { scientificStyle: true }
  );
  assert.strictEqual(captured.data[0].line.shape, undefined);
  assert.strictEqual(captured.data[0].error_y, undefined);
  assert.deepStrictEqual(captured.layout.yaxis.range, [10, 11]);

  await charts.renderCmcPlot(
    {},
    {
      xLabel: "Concentration C (mM)",
      points: [
        { x: 0.01, y: 70, error: 0.2, filename: "a.csv", concentration: 0.01, dropletCount: 3 },
        { x: 0.1, y: 55, error: 0.15, filename: "b.csv", concentration: 0.1, dropletCount: 3, warningCount: 1 },
      ],
    }
  );
  assert.strictEqual(captured.data.length, 1);
  assert.strictEqual(captured.data[0].name, undefined);
  assert.strictEqual(captured.data[0].marker.color[0], charts.SERIES_PALETTE[0]);
  assert.strictEqual(captured.data[0].marker.color[1], charts.SERIES_PALETTE[1]);
  assert.strictEqual(captured.data[0].marker.symbol[1], "diamond");
  assert.strictEqual(captured.layout.yaxis.title.text, "Surface tension σ (mN/m)");
  assert(captured.data[0].hovertemplate.includes("σ=%{y:.4f}"));

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
        fitSegments: [
          { name: "pre-CMC decline", x: [0.01, 0.08], y: [70, 56] },
          { name: "post-CMC plateau", x: [0.08, 0.1], y: [56, 56] },
        ],
        cmcMarker: { x: 0.08, y: 56, label: "CMC" },
      },
    }
  );
  assert.strictEqual(captured.data.length, 4);
  assert.strictEqual(captured.data[1].name, "pre-CMC decline");
  assert.strictEqual(captured.data[1].line.dash, "dash");
  assert.strictEqual(captured.data[2].name, "post-CMC plateau");
  assert.strictEqual(captured.data[3].name, "CMC");
  assert.strictEqual(captured.layout.shapes.length, 1);

  console.log("charts tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
