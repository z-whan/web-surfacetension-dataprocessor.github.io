const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const source = fs.readFileSync(require.resolve("../assets/js/settings.js"), "utf8");
const saved = new Map();
const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
function reopen(localStorage = storage) {
  const window = { localStorage };
  vm.runInNewContext(source, { window });
  return window.SurfaceLabSettings;
}
const settings = reopen();
assert.strictEqual(settings.get().defaultPlotStyle, "raw");
assert(settings.save({ newFileBehavior: "reset", defaultPlotStyle: "band", avgOnly: true,
  showVolumeOverlay: true, ySpanPercent: 150, publicationTimeSeconds: true }));
const reopened = reopen();
assert.strictEqual(reopened.get().newFileBehavior, "reset");
assert.strictEqual(reopened.get().defaultPlotStyle, "band");
assert.strictEqual(reopened.get().avgOnly, true);
assert.strictEqual(reopened.get().ySpanPercent, 150);
assert.strictEqual(reopened.get().publicationTimeSeconds, true);
assert(settings.save({ suggestValidPercent: 100, suggestDurationPercent: 95, suggestNoiseThreshold: 0.3 }));
assert.strictEqual(reopen().get().suggestValidPercent, 100);
assert.strictEqual(reopen().get().suggestNoiseThreshold, 0.3);
assert.strictEqual(settings.sanitize({ suggestNoiseThreshold: -1 }).suggestNoiseThreshold, 0.5);
assert.strictEqual(settings.sanitize({ suggestValidPercent: 101 }).suggestValidPercent, 95);
const copy = reopened.get();
copy.defaultPlotStyle = "raw";
assert.strictEqual(reopened.get().defaultPlotStyle, "band");
assert.strictEqual(settings.sanitize({ defaultPlotStyle: "invalid", ySpanPercent: -1 }).defaultPlotStyle, "raw");
assert.strictEqual(settings.sanitize({ ySpanPercent: -1 }).ySpanPercent, 100);
const blocked = reopen({ getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } });
assert.strictEqual(blocked.get().defaultPlotStyle, "raw");
assert.strictEqual(blocked.save({ defaultPlotStyle: "band" }), false);
assert.strictEqual(blocked.get().defaultPlotStyle, "band", "unavailable storage still permits current-visit settings");
assert.strictEqual(reopen({ getItem: () => "not JSON" }).get().defaultPlotStyle, "raw");
console.log("settings persistence tests passed");
