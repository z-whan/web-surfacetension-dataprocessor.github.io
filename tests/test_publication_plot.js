const assert = require("assert");

globalThis.window = globalThis;
globalThis.SurfaceLabDomUtils = {};

require("../assets/js/publication-plot.js");

const helpers = globalThis.SurfaceLabPublicationPlot.__test;

assert.strictEqual(
  helpers.normalizeSurfaceTensionLabel("I.T. (mN/m)"),
  "Surface Tension (mN/m)"
);
assert.strictEqual(
  helpers.normalizeSurfaceTensionLabel("Droplet volume, V (μL)"),
  "Droplet volume, V (μL)"
);
assert.strictEqual(helpers.detectTimeUnit("Time (ms)"), "ms");
assert.strictEqual(helpers.detectTimeUnit("Time (s)"), "s");
assert.strictEqual(helpers.convertTimeUnitTitle("$t$ (ms)", "s"), "$t$ (s)");

const trace = {
  x: [0, 1000, null, "not-a-number"],
  meta: { surfaceLab: { originalX: [0, 1000, null, "not-a-number"] } },
  error_x: { array: [100, 200], arrayminus: [50, 75] },
};
helpers.scaleTraceTime(trace, 0.001);
assert.deepStrictEqual(trace.x, [0, 1, null, "not-a-number"]);
assert.deepStrictEqual(trace.meta.surfaceLab.originalX, trace.x, "smoothing coordinates must follow unit conversion");
assert.deepStrictEqual(trace.error_x.array, [0.1, 0.2]);
assert.deepStrictEqual(trace.error_x.arrayminus, [0.05, 0.075]);

const layout = {
  xaxis: { range: [0, 2000], tickvals: [0, 1000, 2000], tick0: 500, dtick: 500 },
  shapes: [{ xref: "x", x0: 500, x1: 1500 }],
  annotations: [
    { xref: "x", x: 1000, axref: "pixel", ax: 40 },
    { xref: "paper", x: 0, name: "surface-lab-panel-label" },
  ],
};
helpers.scaleTimeLayout(layout, 0.001);
assert.deepStrictEqual(layout.xaxis.range, [0, 2]);
assert.deepStrictEqual(layout.xaxis.tickvals, [0, 1, 2]);
assert.strictEqual(layout.xaxis.tick0, 0.5);
assert.strictEqual(layout.xaxis.dtick, 0.5);
assert.deepStrictEqual([layout.shapes[0].x0, layout.shapes[0].x1], [0.5, 1.5]);
assert.strictEqual(layout.annotations[0].x, 1);
assert.strictEqual(layout.annotations[0].ax, 40, "pixel arrow offsets must not be rescaled");
assert.strictEqual(layout.annotations[1].x, 0, "paper coordinates must not be rescaled");

assert.deepStrictEqual(helpers.createPanelAnnotationState(), {
  enabled: false,
  text: "(a)",
  position: "top-left",
  fontSize: 20,
  xOffset: 12,
  yOffset: 12,
});

global.document = { querySelector: () => ({ value: "", checked: false, disabled: false }) };
require("../assets/js/charts.js");
const charts = global.SurfaceLabCharts;
const controller = global.SurfaceLabPublicationPlot.createController({ charts });
controller.renderTraceControls = () => {};
let rendered;
controller.render = async () => { rendered = charts.expandBandTraces(controller.state.data); };
const sample = charts.applyScientificTraceStyle({ x: [0, 1000, 2000, 3000, 4000],
  y: [70, 72, 69, 71, 70], line: { color: "#0072B2" } }, "band");
controller.state.data = [sample];
controller.state.plotStyle = "band";
(async () => {
  controller.dom.scientificStyle.value = "error-bars";
  await controller.applyScientificStyle();
  assert.strictEqual(controller.state.plotStyle, "error-bars", "snapshot sync must not overwrite requested style");
  assert.strictEqual(rendered.length, 1);
  assert.strictEqual(rendered[0].error_y.visible, true);
  controller.dom.scientificStyle.value = "raw";
  await controller.applyScientificStyle();
  assert.deepStrictEqual(rendered[0].y, [70, 72, 69, 71, 70]);
  controller.dom.scientificStyle.value = "band";
  await controller.applyScientificStyle();
  assert.strictEqual(rendered.length, 3);
  assert.strictEqual(controller.getSessionState().data.length, 1, "editor and session contain logical curves only");
  assert.strictEqual(controller.state.plotStyle, "band");
  console.log("publication plot tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
