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
  error_x: { array: [100, 200], arrayminus: [50, 75] },
};
helpers.scaleTraceTime(trace, 0.001);
assert.deepStrictEqual(trace.x, [0, 1, null, "not-a-number"]);
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

console.log("publication plot tests passed");
