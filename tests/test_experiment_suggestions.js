const assert = require("assert");
global.window = global;
const nodes = new Map();
global.document = { querySelector(selector) {
  if (!nodes.has(selector)) nodes.set(selector, { value: "", textContent: "", hidden: false, open: false, focus() { this.focused = true; }, close() { this.open = false; } });
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
  setStatus() {},
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
  jobs[1].resolve({ recommendedRange: "1,3-4", rules: { validPercent: 95, durationPercent: 90, noiseThreshold: 0.5 }, experiments: [1, 2, 3, 4, 9].map((id) => ({
    experimentIndex: id, status: id === 2 || id === 9 ? "exclude" : "suggest",
    validPoints: id === 9 ? 0 : 100, totalPoints: 100, validPercent: id === 9 ? 0 : 100,
    durationCoveragePercent: 100, durationSeconds: 600, noiseSigma: 0.2, residualP95: 0.3,
    evaporationPctPer10Min: id === 2 ? 6 : 4, volumeDurationSeconds: 600,
    volumePoints: 100, volumeSource: "detail", volumeLossPercent: id === 2 ? 6 : 4,
    reasons: [id === 9 ? "No valid data" : id === 2 ? "Evaporation exceeds 5%/10min." : "Meets all screening rules."],
  })) });
  await second;
  jobs[0].resolve({ recommendedRange: "2", experiments: [] });
  await tick();
  assert.strictEqual(controller.dom.suggestRange.textContent, "1,3-4", "an older file must not replace the new file's suggestion");
  assert.deepStrictEqual(cleaned.sort(), ["first.csv", "second.csv"]);
  assert.strictEqual(nodes.get("#plot-exp-range").textContent, "", "suggestions must not change the selected range");
  const output = controller.dom.suggestDetails.children;
  assert.strictEqual(output[2].children[0].tag, "table", "key metrics must precede detailed rules");
  assert.strictEqual(output[2].children[0].children[1].children.length, 4);
  assert(!JSON.stringify(output).includes("Exp 9"), "empty experiments must be absent from both table and details");
  assert.strictEqual(output[4].tag, "details", "full explanations should be collapsible below the table");
  assert.strictEqual(controller.dom.suggestApply.disabled, false);
  controller.dom.plotExpRange.value = "2";
  controller.applySuggestedRange();
  assert.strictEqual(controller.dom.plotExpRange.value, "1,3-4");
  assert.strictEqual(controller.dom.plotExpRange.focused, true);
  const retry = controller.refreshSuggestion();
  await tick();
  assert.strictEqual(controller.dom.suggestApply.disabled, true);
  jobs[2].reject(Error("Unsupported file"));
  await retry;
  assert.strictEqual(controller.state.suggestionStatus, "error");
  assert.strictEqual(controller.dom.suggestDetails.children[0].text, "Unsupported file");
  controller.applySuggestedRange();
  assert.strictEqual(controller.dom.plotExpRange.value, "1,3-4", "an unavailable suggestion must not overwrite the user's range");
  controller.state.file = null;
  await controller.refreshSuggestion();
  assert.strictEqual(controller.dom.suggest.hidden, true);
  console.log("experiment suggestion lifecycle tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
