(function () {
  const ui = window.SurfaceLabDomUtils;
  const settingsKeys = ["timeMin", "timeMax", "timeUnit", "model"];

  class LangmuirController {
    constructor(parent) {
      this.parent = parent;
      this.payload = null;
      this.request = 0;
      const selectors = {
        model: "#plot-langmuir-model", formula: "[data-langmuir-formula]", modelHint: "[data-langmuir-model-hint]",
        timeMin: "#plot-langmuir-min", timeMax: "#plot-langmuir-max", timeUnit: "#plot-langmuir-unit",
        run: "#plot-langmuir-run", clear: "#plot-langmuir-clear", status: "[data-langmuir-status]",
        card: "[data-langmuir-card]", summary: "[data-langmuir-summary]", table: "[data-langmuir-table]",
        warnings: "[data-langmuir-warnings]", canvas: "#plot-langmuir-canvas",
        residualCanvas: "#plot-langmuir-residual-canvas", residualSection: "[data-langmuir-residual-section]",
        png: "#plot-langmuir-export", svg: "#plot-langmuir-export-svg", json: "#plot-langmuir-export-json",
        publication: "#plot-langmuir-send-publication",
      };
      this.dom = Object.fromEntries(Object.entries(selectors).map(([key, selector]) => [key, document.querySelector(selector)]));
    }

    bind() {
      this.dom.run.addEventListener("click", this.parent.withRuntime(() => this.fit()));
      this.dom.clear.addEventListener("click", () => this.invalidate());
      this.updateModelDescription();
      settingsKeys.forEach((key) => this.dom[key].addEventListener(["timeUnit", "model"].includes(key) ? "change" : "input", () => {
        this.invalidate();
        if (key === "model") this.updateModelDescription();
      }));
      ["plotStart", "plotEnd", "plotExpRange", "plotAvgOnly", "plotAvgShowOriginal", "showRawToggle"].forEach((key) => {
        this.parent.dom[key].addEventListener("change", () => this.invalidate());
        if (["plotStart", "plotEnd", "plotExpRange"].includes(key)) {
          this.parent.dom[key].addEventListener("input", () => this.invalidate());
        }
      });
      for (const [key, format] of [["png", "png"], ["svg", "svg"]]) {
        this.dom[key].addEventListener("click", this.parent.withRuntime(async () => {
          if (this.payload && this.payload.summary.fitted) {
            await this.parent.charts.exportPlotImage(this.dom.canvas, this.filenameBase(), { format });
          }
        }));
      }
      this.dom.json.addEventListener("click", () => {
        if (this.payload) window.SurfaceLabDownloads.downloadText(`${this.filenameBase()}.json`, JSON.stringify(this.payload, null, 2), "application/json");
      });
      this.dom.publication.addEventListener("click", () => {
        if (this.payload && this.payload.summary.fitted) this.parent.sendToPublication(this.dom.canvas, {
          sourceType: "langmuir", sourceTitle: this.payload.modelLabel || "Langmuir kinetic fit", filenameBase: `${this.filenameBase()}-publication`,
        });
      });
      this.dom.residualSection.addEventListener("toggle", () => {
        if (this.dom.residualSection.open && this.payload) {
          this.parent.charts.renderLangmuirPlot(this.dom.residualCanvas, this.payload, true);
        }
      });
    }

    getSettings() {
      return Object.fromEntries(settingsKeys.map((key) => [key, this.dom[key].value]));
    }

    filenameBase() {
      return this.payload && this.payload.modelKey === "double" ? "langmuir-double-fit" : "langmuir-fit";
    }

    updateModelDescription() {
      const double = this.dom.model.value === "double";
      this.dom.formula.textContent = double
        ? "γ(t) = γ∞ + A_fast exp[−(t − t₀) / τ_fast] + A_slow exp[−(t − t₀) / τ_slow]"
        : "γ(t) = γ∞ + A exp[−(t − t₀) / τ]";
      this.dom.modelHint.textContent = double
        ? "Empirical two-time-scale extension; τ_fast ≤ τ_slow and A_fast, A_slow ≥ 0. Requires at least 10 distinct finite times. Similar time scales or near-zero components may be poorly identifiable; two components do not establish two adsorption mechanisms."
        : "Apparent single-exponential relaxation. Requires at least 6 distinct finite times.";
    }

    restoreSettings(settings) {
      this.invalidate();
      const values = settings || {};
      this.dom.timeMin.value = typeof values.timeMin === "string" ? values.timeMin : "";
      this.dom.timeMax.value = typeof values.timeMax === "string" ? values.timeMax : "";
      this.dom.timeUnit.value = ["auto", "ms", "s", "min"].includes(values.timeUnit) ? values.timeUnit : "auto";
      this.dom.model.value = values.model === "double" ? "double" : "single";
      this.updateModelDescription();
    }

    invalidate() {
      ++this.request;
      this.payload = null;
      this.dom.run.disabled = false;
      this.dom.card.hidden = true;
      this.dom.status.textContent = "No Langmuir fit for the current selection. Click Fit Langmuir to calculate.";
      ["png", "svg", "json", "publication"].forEach((key) => { this.dom[key].disabled = true; });
    }

    async fit() {
      this.parent.ensureFileSelected();
      this.invalidate();
      const request = this.request;
      const file = this.parent.state.file;
      const args = this.parent.currentSelectionArgs();
      const options = this.getSettings();
      let staged;
      this.dom.run.disabled = true;
      this.dom.status.textContent = "Fitting unsmoothed observations…";
      try {
        await this.parent.ensureFileDependencies(file);
        if (request !== this.request) return;
        staged = await this.parent.pyodideClient.stageBrowserFile(file, "langmuir");
        if (request !== this.request) return;
        const payload = await this.parent.pyodideClient.callBridge("fit_plot_langmuir", staged.fsPath,
          args.startText, args.endText, args.expRangeText, args.avgOnly, options, args.showOriginalWithAvg);
        if (request !== this.request) return;
        this.payload = { ...payload, sourceName: file.name, selection: args };
        await this.render();
        if (request !== this.request) return;
        this.parent.setStatus(`${payload.modelLabel || "Langmuir"} fit: ${payload.summary.fitted}/${payload.summary.total} curves fitted from ${file.name}.`);
      } catch (error) {
        if (request === this.request) {
          this.invalidate();
          this.dom.status.textContent = "Fit failed. Check the inputs and try again.";
          this.parent.showError(this.parent.normalizeUiError(error));
        }
      } finally {
        if (staged) this.parent.pyodideClient.removeFsFile(staged.fsPath);
        if (request === this.request) this.dom.run.disabled = false;
      }
    }

    async render() {
      const payload = this.payload;
      const fitted = payload.summary.fitted > 0;
      const double = payload.modelKey === "double";
      this.dom.card.hidden = false;
      this.dom.canvas.hidden = !fitted;
      this.dom.residualSection.hidden = !fitted;
      this.dom.summary.textContent = `${payload.sourceName} · ${payload.modelLabel || "Single exponential"} · ${payload.summary.fitted}/${payload.summary.total} curves fitted. Markers: observations; dashed lines: fits.`;
      this.dom.status.textContent = fitted ? "Fit complete. Parameters, warnings and residuals are in Langmuir Fit Results." : "No curves could be fitted. Review the per-curve messages in the results.";
      const parameterColumns = double
        ? ["A_fast (mN/m)", "τ_fast (s)", "k_fast (s⁻¹)", "A_slow (mN/m)", "τ_slow (s)", "k_slow (s⁻¹)"]
        : ["A (mN/m)", "τ (s)", "k_obs (s⁻¹)", "t½ (s)"];
      const columns = ["Curve", "N", "γ(t₀) (mN/m)", "γ∞ (mN/m)", ...parameterColumns, "R²", "RMSE (mN/m)", `Fit window (${payload.xLabel || "source time"})`];
      const number = (value) => Number.isFinite(value) ? Number(value).toPrecision(5) : "—";
      const rows = payload.results.map((row) => {
        const parameters = double
          ? (row.components || []).flatMap((component) => [component.amplitude, component.tauSeconds, component.kObsPerSecond])
          : [row.amplitude, row.tauSeconds, row.kObsPerSecond, row.halfTimeSeconds];
        const values = row.status === "ok" ? [row.name, row.n, ...[row.gammaStart, row.gammaInf, ...parameters,
          row.rSquared, row.rmse].map(number), `${number(row.t0)} – ${number(row.timeEnd)}`] : [row.name, "Fit unavailable", ...Array(columns.length - 2).fill("—")];
        return ui.el("tr", {}, values.map((value, index) => ui.el(index ? "td" : "th", { text: String(value), attrs: index ? {} : { scope: "row" } })));
      });
      ui.replaceChildren(this.dom.table, [ui.el("div", { className: "table-scroll" }, [ui.el("table", { attrs: { "aria-label": "Langmuir fit parameters" } }, [
        ui.el("thead", {}, [ui.el("tr", {}, columns.map((text) => ui.el("th", { text, attrs: { scope: "col" } })))]),
        ui.el("tbody", {}, rows),
      ])])]);
      const warnings = payload.results.flatMap((row) => (row.status === "error" ? [row.message] : row.warnings).map((message) => ui.el("li", { text: `${row.name}: ${message}` })));
      ui.replaceChildren(this.dom.warnings, [ui.el("p", { className: "field-hint", text: payload.assumptions }),
        ...(warnings.length ? [ui.el("ul", { className: "field-hint" }, warnings)] : [])]);
      this.dom.json.disabled = false;
      ["png", "svg", "publication"].forEach((key) => { this.dom[key].disabled = !fitted; });
      if (fitted) {
        await this.parent.charts.renderLangmuirPlot(this.dom.canvas, payload);
        if (this.dom.residualSection.open) await this.parent.charts.renderLangmuirPlot(this.dom.residualCanvas, payload, true);
      }
    }
  }

  window.SurfaceLabLangmuirModule = { createController: (parent) => new LangmuirController(parent) };
})();
