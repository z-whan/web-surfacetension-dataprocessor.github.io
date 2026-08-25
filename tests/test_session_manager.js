const assert = require("assert");

require("../assets/js/session-manager.js");

const manager = globalThis.SurfaceLabSessionManager;

assert(manager, "SurfaceLabSessionManager should attach to globalThis");

const session = manager.createSession({
  timeSeries: {
    file: { name: "sample.csv", size: 42, type: "text/csv", lastModified: 123 },
    selection: {
      startText: "2",
      endText: "10",
      expRangeText: "1-2",
      avgOnly: true,
      showOriginalWithAvg: true,
    },
    trend: {
      methodKey: "moving_average",
      parameters: { windowSize: "3", windowUnit: "points" },
      showRaw: false,
      applied: true,
    },
    noise: {
      methodKey: "rolling_std",
      parameters: { windowSize: "5" },
    },
    yAxis: {
      spanPercent: 120,
      manualRange: [10, 20],
      yMinText: "10",
      yMaxText: "20",
    },
  },
  compare: {
    curves: [
      {
        sourceFileName: "sample.csv",
        displayIndex: 1,
        displayLabel: "#1",
        selection: "I.T.(mN/m).1",
        x: [0, 1, 2],
        y: [10, 11, 12],
      },
    ],
    selectedDisplayIndexes: [1],
  },
  publication: {
    sourceType: "time-series",
    sourceTitle: "Time-series plot",
    filenameBase: "figure",
    data: [{ name: "trace", x: [0, 1], y: [2, 3] }],
    layout: { title: { text: "Figure" } },
    config: { responsive: true },
    exportSettings: { width: 1000, height: 700 },
    scientificStyleEnabled: true,
    timeUnitState: { eligible: true, current: "s", titles: { ms: "Time (ms)", s: "Time (s)" } },
    panelAnnotation: { enabled: true, text: "(a)", position: "top-left" },
  },
  cmc: {
    shouldNotAppear: true,
  },
});

assert.strictEqual(session.schema, "surface-lab-session");
assert.strictEqual(session.schemaVersion, 1);
assert.strictEqual(session.cmc, undefined);
assert.strictEqual(session.timeSeries.selection.expRangeText, "1-2");
assert.strictEqual(session.compare.curves.length, 1);
assert.strictEqual(session.publication.layout.title.text, "Figure");
assert.strictEqual(session.publication.scientificStyleEnabled, true);
assert.strictEqual(session.publication.timeUnitState.current, "s");
assert.strictEqual(session.publication.panelAnnotation.text, "(a)");

const validation = manager.parseAndValidateSession(JSON.stringify(session));
assert.strictEqual(validation.ok, true);
assert.strictEqual(validation.session.compare.curves[0].x.length, 3);

const malformed = manager.parseAndValidateSession("{nope");
assert.strictEqual(malformed.ok, false);
assert(malformed.warnings[0].includes("valid JSON"));

const wrongVersion = manager.validateSession({
  schema: "surface-lab-session",
  schemaVersion: 999,
});
assert.strictEqual(wrongVersion.ok, false);
assert(wrongVersion.warnings[0].includes("Unsupported session schema version"));

console.log("session manager tests passed");
