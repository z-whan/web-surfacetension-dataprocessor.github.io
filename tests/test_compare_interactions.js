const assert = require("assert");
global.window = global;
const nodes = new Map();
function node() {
  return { value: "100", hidden: true, listeners: {}, children: [],
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); },
    setAttribute(key, value) { this[key] = value; },
    appendChild(child) { this.children.push(child); },
    querySelectorAll() { return []; },
  };
}
global.document = {
  querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, node());
    return nodes.get(selector);
  },
  addEventListener() {},
};
global.SurfaceLabDomUtils = {
  el: (tag, options, children) => ({ tag, options, children }),
  clear: (element) => { element.children = []; },
  replaceChildren: (element, children) => { element.children = children; },
  metricCard: (label, value) => ({ label, value }),
};
global.SurfaceLabSettings = { get: () => ({ defaultPlotStyle: "band", ySpanPercent: 100 }) };
let plotted = [];
const charts = {
  clearPlot() {},
  normalizePlotStyle: (value, legacy) => value || (legacy ? "error-bars" : "raw"),
  resolveSeriesYRange: () => [50, 75],
  renderComparePlot: async (_, curves) => { plotted = curves.map((curve) => curve.displayLabel); },
};
require("../assets/js/compare-module.js");
const compare = SurfaceLabCompareModule.createController({ charts, setStatus() {}, showError(message) { throw Error(message); }, clearError() {} });
function click(selector) { nodes.get(selector).listeners.click.forEach((callback) => callback({})); }
(async () => {
  compare.bind();
  const curves = [1, 2, 3].map((index) => ({ displayIndex: index, displayLabel: `curve ${index}`,
    sourceFileName: `test-${index}.csv`, dataType: "raw", x: [0, 1], y: [70, 65], selection: "Avg" }));
  await compare.restoreSessionState({ curves, selectedDisplayIndexes: [1, 3], plotStyle: { mode: "band" } });
  assert.deepStrictEqual(plotted, ["curve 1", "curve 3"]);
  const ids = compare.state.curves.map((curve) => curve.id);
  compare.reorderCurve(ids[2], ids[0], false);
  await Promise.resolve();
  assert.deepStrictEqual(plotted, ["curve 3", "curve 1"]);
  assert.deepStrictEqual(compare.state.curves.map((curve) => curve.displayIndex), [3, 1, 2]);
  assert.deepStrictEqual(compare.getSessionState().curves.map((curve) => curve.displayIndex), [3, 1, 2]);
  assert.strictEqual(compare.state.selectedIds.size, 2, "reordering must keep curve selections");
  click("#compare-clear");
  assert.strictEqual(compare.state.curves.length, 3, "opening Clear must not remove anything");
  assert.strictEqual(compare.dom.clearMenu.hidden, false);
  click("#compare-remove-unselected");
  assert.deepStrictEqual(compare.state.curves.map((curve) => curve.displayIndex), [3, 1]);
  assert.strictEqual(compare.dom.clearMenu.hidden, true);
  click("#compare-clear");
  click("#compare-remove-selected");
  assert.strictEqual(compare.state.curves.length, 0);
  await compare.restoreSessionState({ curves, selectedDisplayIndexes: [], plotStyle: { mode: "band" } });
  assert.strictEqual(compare.state.selectedIds.size, 0, "restoring an empty selection must not select everything");
  click("#compare-clear");
  assert.strictEqual(compare.state.curves.length, 3);
  click("#compare-clear-all");
  assert.strictEqual(compare.state.curves.length, 0);
  console.log("compare interaction tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
