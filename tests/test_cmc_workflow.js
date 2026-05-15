const assert = require("assert");

globalThis.window = globalThis;

require("../assets/js/cmc-workflow.js");

const workflow = globalThis.SurfaceLabCmcWorkflow;
assert(workflow, "SurfaceLabCmcWorkflow should attach to globalThis");

const fileA = { name: "a.csv", size: 100, lastModified: 1 };
const fileB = { name: "b.csv", size: 200, lastModified: 2 };

let rows = workflow.appendFileRows([], [fileA], (filename) => filename === "a.csv" ? "1" : "");
rows = workflow.appendFileRows(rows, [fileB], () => "2");
assert.strictEqual(rows.length, 2, "file selection should append");
assert.strictEqual(rows[0].filename, "a.csv");
assert.strictEqual(rows[1].filename, "b.csv");

const cancelRows = workflow.appendFileRows(rows, [], () => "");
assert.strictEqual(cancelRows.length, 2, "cancel selection should not clear rows");

const clearedRows = [];
assert.strictEqual(clearedRows.length, 0, "clear files is the explicit empty state");

const reviewOptions = {
  plateauMode: "auto",
  minPlateauWindowMs: "5000",
  plateauSearchStrideMs: 5000,
  maxAbsSlopeMnMPerMin: "0.5",
  maxPlateauSdMnM: "0.5",
  maxVolumeLossPct: "5",
  maxEvaporationRatePctPerMin: "0.5",
};
const keyBefore = workflow.reviewCacheKey(rows, reviewOptions);
const keyAfterPlotOnlyChanges = workflow.reviewCacheKey(rows, {
  ...reviewOptions,
  useLog: true,
  fitModel: "segmented_continuous",
  sampleType: "WSOM",
});
assert.strictEqual(
  keyBefore,
  keyAfterPlotOnlyChanges,
  "log scale, fit model, and sample type must not invalidate review cache"
);

let reviewCalls = 0;
let plotCalls = 0;
function reviewIfDirty(state, key) {
  if (!state.reviewPayload || state.reviewDirty || state.reviewCacheKey !== key) {
    reviewCalls += 1;
    state.reviewPayload = { ok: true };
    state.reviewCacheKey = key;
    state.reviewDirty = false;
  }
}
function rebuildPlot() {
  plotCalls += 1;
}
const cacheState = { reviewPayload: null, reviewDirty: true, reviewCacheKey: null };
reviewIfDirty(cacheState, keyBefore);
rebuildPlot();
rebuildPlot();
reviewIfDirty(cacheState, keyAfterPlotOnlyChanges);
assert.strictEqual(reviewCalls, 1, "cached plot-only changes should not call review again");
assert.strictEqual(plotCalls, 2, "plot-only changes should use lightweight plot rebuild");

const reviewPayload = {
  files: [
    {
      filename: "a.csv",
      droplets: [
        {
          dropletIndex: 1,
          sourceColumn: "I.T.(mN/m).1",
          usedForAggregate: false,
          qc: {
            gammaEq: 70,
            usedForAggregate: false,
            flags: ["HIGH_FINAL_DRIFT"],
            slopeMnMPerMin: 1.2,
            fullVolumeLossPct: 1,
          },
        },
      ],
    },
  ],
};
const dropletId = workflow.dropletKey(rows[0], reviewPayload.files[0].droplets[0]);
const overridden = workflow.applyUsedOverrides(reviewPayload, rows, { [dropletId]: true });
const droplet = overridden.files[0].droplets[0];
assert.strictEqual(droplet.usedForAggregate, true);
assert.strictEqual(droplet.manualOverride, true);
assert.strictEqual(droplet.qc.manualOverride, true);
assert.strictEqual(droplet.qc.flags[0], "HIGH_FINAL_DRIFT");

assert.strictEqual(workflow.flagLabel("HIGH_FINAL_DRIFT"), "DRIFT");
assert.strictEqual(workflow.flagLabel("HIGH_VOLUME_LOSS"), "EVAP");
assert(workflow.flagTitle("HIGH_FINAL_DRIFT", droplet.qc, reviewOptions).includes("threshold"));

console.log("cmc workflow tests passed");
