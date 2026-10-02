(function () {
  const STORAGE_KEY = "surface-lab-settings-v1";
  const DEFAULTS = Object.freeze({
    newFileBehavior: "preserve",
    defaultPlotStyle: "raw",
    avgOnly: false,
    showOriginalWithAvg: false,
    showVolumeOverlay: false,
    ySpanPercent: 100,
    publicationTimeSeconds: false,
    suggestValidPercent: 95,
    suggestDurationPercent: 90,
    suggestNoiseThreshold: 0.5,
  });

  function sanitize(input) {
    const value = input && typeof input === "object" ? input : {};
    const span = Number(value.ySpanPercent);
    const bounded = (key, fallback, min, max) => {
      const number = Number(value[key]);
      return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
    };
    return {
      newFileBehavior: value.newFileBehavior === "reset" ? "reset" : "preserve",
      defaultPlotStyle: ["raw", "error-bars", "band"].includes(value.defaultPlotStyle)
        ? value.defaultPlotStyle : "raw",
      avgOnly: value.avgOnly === true,
      showOriginalWithAvg: value.showOriginalWithAvg === true,
      showVolumeOverlay: value.showVolumeOverlay === true,
      ySpanPercent: Number.isFinite(span) && span >= 40 && span <= 400 ? span : 100,
      publicationTimeSeconds: value.publicationTimeSeconds === true,
      suggestValidPercent: bounded("suggestValidPercent", 95, 50, 100),
      suggestDurationPercent: bounded("suggestDurationPercent", 90, 50, 100),
      suggestNoiseThreshold: bounded("suggestNoiseThreshold", 0.5, 0.01, 10),
    };
  }

  let settings = { ...DEFAULTS };
  try {
    settings = sanitize(JSON.parse(window.localStorage.getItem(STORAGE_KEY)));
  } catch (_) {
    // Blocked storage or invalid old preferences must never prevent startup.
  }

  function save(input) {
    settings = sanitize(input);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      return true;
    } catch (_) {
      return false;
    }
  }

  function bind() {
    const dialog = document.querySelector("#settings-dialog");
    const form = document.querySelector("#settings-form");
    const feedback = document.querySelector("#settings-feedback");
    const fields = Object.fromEntries(Object.keys(DEFAULTS).map((key) =>
      [key, document.querySelector(`[data-setting="${key}"]`)]
    ));
    function populate(value) {
      Object.entries(fields).forEach(([key, field]) => {
        if (field.type === "checkbox") field.checked = value[key];
        else field.value = String(value[key]);
      });
    }
    document.querySelector("#settings-open").addEventListener("click", () => {
      populate(settings);
      feedback.textContent = "";
      dialog.showModal();
    });
    document.querySelector("#settings-close").addEventListener("click", () => dialog.close());
    document.querySelector("#settings-reset").addEventListener("click", () => {
      populate(DEFAULTS);
      feedback.textContent = "Default values restored in this form. Save to keep them.";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = Object.fromEntries(Object.entries(fields).map(([key, field]) =>
        [key, field.type === "checkbox" ? field.checked : field.value]
      ));
      const persisted = save(input);
      window.dispatchEvent(new CustomEvent("surface-lab-settings-changed"));
      feedback.textContent = persisted
        ? "Saved on this browser. Defaults apply on reopening, Reset Inputs, or a new file in reset mode."
        : "Applied for this visit. Browser storage is unavailable, so these settings cannot survive reopening.";
    });
  }

  window.SurfaceLabSettings = { get: () => ({ ...settings }), save, sanitize, bind, DEFAULTS };
})();
