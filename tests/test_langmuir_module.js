const assert = require("assert");
global.window = global;
const nodes = new Map();
function node() {
  return { value: "", disabled: false, hidden: true, open: false, listeners: {},
    addEventListener(event, handler) { this.listeners[event] = handler; } };
}
global.document = { querySelector(selector) {
  if (!nodes.has(selector)) nodes.set(selector, node());
  return nodes.get(selector);
} };
global.SurfaceLabDomUtils = {
  el: (tag, options, children) => ({ tag, ...options, children }),
  replaceChildren: (parent, children) => { parent.children = children; },
};
require("../assets/js/langmuir-module.js");
const jobs = [], cleaned = [], rendered = [], errors = [];
const parent = {
  state: { file: { name: "first.csv" } },
  dom: Object.fromEntries(["plotStart", "plotEnd", "plotExpRange", "plotAvgOnly", "plotAvgShowOriginal", "showRawToggle"].map(key => [key, node()])),
  withRuntime: handler => handler,
  currentSelectionArgs: () => ({ startText: "3", endText: "50", expRangeText: "1-2", avgOnly: true, showOriginalWithAvg: false }),
  ensureFileSelected() { if (!this.state.file) throw Error("Choose a file"); },
  ensureFileDependencies: async () => {},
  pyodideClient: {
    stageBrowserFile: async file => ({ fsPath: file.name }),
    callBridge: (...args) => new Promise((resolve, reject) => jobs.push({ args, resolve, reject })),
    removeFsFile: filename => cleaned.push(filename),
  },
  charts: { renderLangmuirPlot: async (...args) => rendered.push(args) },
  setStatus() {}, showError: message => errors.push(message), normalizeUiError: error => error.message,
};
const fit = SurfaceLabLangmuirModule.createController(parent);
fit.bind();
fit.restoreSettings({ timeMin: "1000", timeMax: "50000", timeUnit: "ms" });
const tick = () => new Promise(resolve => setImmediate(resolve));
const payload = {
  assumptions: "test model", summary: { fitted: 1, total: 1 },
  results: [{ name: "Avg (1-2)", status: "ok", warnings: [], n: 48, gammaInf: 40, tauSeconds: 20, rSquared: 0.99 }],
};
(async () => {
  const old = fit.fit();
  await tick();
  assert.strictEqual(fit.dom.run.disabled, true);
  assert.strictEqual(jobs[0].args[0], "fit_plot_langmuir");
  assert.deepStrictEqual(jobs[0].args.slice(2), ["3", "50", "1-2", true, { timeMin: "1000", timeMax: "50000", timeUnit: "ms", model: "single" }, false]);
  parent.state.file = { name: "second.csv" };
  fit.invalidate();
  const current = fit.fit();
  await tick();
  jobs[1].resolve(payload);
  await current;
  jobs[0].resolve(payload);
  await old;
  assert.strictEqual(fit.payload.sourceName, "second.csv", "stale results must not replace the current file");
  assert.strictEqual(rendered.length, 1);
  assert.strictEqual(fit.dom.card.hidden, false);
  assert.strictEqual(fit.dom.png.disabled, false);
  assert.strictEqual(fit.dom.json.disabled, false);
  fit.dom.model.value = "double";
  fit.dom.model.listeners.change();
  assert.strictEqual(fit.payload, null, "changing fit models must clear stale results");
  assert(fit.dom.formula.textContent.includes("τ_fast"));
  assert(fit.dom.modelHint.textContent.includes("10 distinct"));
  const doubleFit = fit.fit();
  await tick();
  assert.strictEqual(jobs[2].args[6].model, "double");
  jobs[2].resolve({ ...payload, modelKey: "double", modelLabel: "Double exponential", results: [{ ...payload.results[0],
    components: [{ amplitude: 12, tauSeconds: 20, kObsPerSecond: 0.05 }, { amplitude: 20, tauSeconds: 160, kObsPerSecond: 0.00625 }],
  }] });
  await doubleFit;
  assert.strictEqual(fit.filenameBase(), "langmuir-double-fit");
  const parameters = JSON.stringify(fit.dom.table.children);
  assert(parameters.includes("Fast component") && parameters.includes("Slow component"));
  assert(parameters.includes("160.00") && parameters.includes("0.0062500"), "slow-component parameters must remain visible");
  assert.deepStrictEqual(cleaned.sort(), ["first.csv", "second.csv", "second.csv"]);
  parent.dom.plotExpRange.listeners.input();
  assert.strictEqual(fit.payload, null);
  assert.strictEqual(fit.dom.card.hidden, true);
  assert.strictEqual(fit.dom.png.disabled, true);
  const failed = fit.fit();
  await tick();
  jobs[3].resolve({ ...payload, modelKey: "double", summary: { fitted: 0, total: 1 }, results: [{ name: "constant", status: "error", message: "Not identifiable", warnings: [] }] });
  await failed;
  assert.strictEqual(fit.dom.canvas.hidden, true);
  assert.strictEqual(fit.dom.png.disabled, true);
  assert.strictEqual(fit.dom.json.disabled, false, "failed fits can still export diagnostics");
  assert(JSON.stringify(fit.dom.table.children).includes("Not identifiable"));
  const invalid = fit.fit();
  await tick();
  jobs[4].reject(Error("Unknown time unit"));
  await invalid;
  assert.strictEqual(fit.payload, null);
  assert.strictEqual(fit.dom.run.disabled, false);
  assert.deepStrictEqual(errors, ["Unknown time unit"]);
  fit.restoreSettings({ timeUnit: "bad", timeMin: 1 });
  assert.deepStrictEqual(fit.getSettings(), { timeMin: "", timeMax: "", timeUnit: "auto", model: "single" });
  fit.restoreSettings({ model: "double", timeUnit: "s" });
  assert.strictEqual(fit.getSettings().model, "double");
  console.log("Langmuir module lifecycle tests passed");
})().catch(error => { console.error(error); process.exit(1); });
