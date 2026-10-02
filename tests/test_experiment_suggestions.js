const assert = require("assert");
global.window = global;
const nodes = new Map();
global.document = { querySelector(selector) {
  if (!nodes.has(selector)) nodes.set(selector, { textContent: "", hidden: false, open: false, close() { this.open = false; } });
  return nodes.get(selector);
} };
global.SurfaceLabDomUtils = {
  el: (tag, options, children) => ({ tag, ...options, children }),
  replaceChildren: (parent, children) => { parent.children = children; },
};
global.SurfaceLabSettings = { get: () => ({ suggestValidPercent: 95, suggestDurationPercent: 90, suggestNoiseThreshold: 0.5 }) };
require("../assets/js/time-series-module.js");
let ready = false;
const jobs = [];
const cleaned = [];
const controller = SurfaceLabTimeSeriesModule.createController({
  config: {}, isRuntimeReady: () => ready, normalizeUiError: (error) => error.message,
  pyodideClient: {
    stageBrowserFile: async (file) => ({ fsPath: file.name }),
    callBridge: (method, path, rules) => new Promise((resolve, reject) => jobs.push({ method, path, rules, resolve, reject })),
    removeFsFile: (path) => cleaned.push(path),
  },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
(async () => {
  controller.state.file = { name: "first.csv" };
  await controller.refreshSuggestion();
  assert.strictEqual(controller.state.suggestionStatus, "waiting");
  assert.strictEqual(jobs.length, 0);
  ready = true;
  controller.onRuntimeReady();
  await tick();
  assert.strictEqual(jobs[0].method, "suggest_plot_experiments");
  assert.strictEqual(jobs[0].rules.noiseThreshold, 0.5);
  controller.state.file = { name: "second.csv" };
  const second = controller.refreshSuggestion();
  await tick();
  jobs[1].resolve({ recommendedRange: "1,3-4", rules: { validPercent: 95, durationPercent: 90, noiseThreshold: 0.5 }, experiments: [] });
  await second;
  jobs[0].resolve({ recommendedRange: "2", experiments: [] });
  await tick();
  assert.strictEqual(controller.dom.suggestRange.textContent, "1,3-4", "an older file must not replace the new file's suggestion");
  assert.deepStrictEqual(cleaned.sort(), ["first.csv", "second.csv"]);
  assert.strictEqual(nodes.get("#plot-exp-range").textContent, "", "suggestions must not change the selected range");
  const retry = controller.refreshSuggestion();
  await tick();
  jobs[2].reject(Error("Unsupported file"));
  await retry;
  assert.strictEqual(controller.state.suggestionStatus, "error");
  assert.strictEqual(controller.dom.suggestDetails.children[0].text, "Unsupported file");
  controller.state.file = null;
  await controller.refreshSuggestion();
  assert.strictEqual(controller.dom.suggest.hidden, true);
  console.log("experiment suggestion lifecycle tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
