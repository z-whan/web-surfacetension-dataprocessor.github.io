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
        png: "#plot-langmuir-export", svg: "#plot-langmuir-export-svg", json: "#plot-langmuir-export-json", pdf: "#plot-langmuir-export-pdf",
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
      this.dom.pdf.addEventListener("click", this.parent.withRuntime(() => this.exportPdf()));
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

    async exportPdf() {
      const payload = this.payload;
      if (!payload || !payload.summary.fitted) return;
      this.dom.pdf.disabled = true;
      this.parent.setStatus("Preparing PDF export…");
      try {
        await this.parent.pyodideClient.ensureBuiltinPackages(["matplotlib"]);
        if (this.payload !== payload) return;
        const result = await this.parent.pyodideClient.callBridge("export_langmuir_pdf", JSON.stringify(payload));
        if (this.payload !== payload) return;
        const bytes = Uint8Array.from(atob(result.dataBase64), (character) => character.charCodeAt(0));
        window.SurfaceLabDownloads.downloadBytes(`${this.filenameBase()}-report.pdf`, bytes, result.mimeType);
        this.parent.setStatus("PDF export ready.");
      } catch (error) {
        if (this.payload === payload) {
          this.parent.setStatus("PDF export failed.");
          throw error;
        }
      } finally {
        if (this.payload === payload) this.dom.pdf.disabled = false;
      }
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
      ["png", "svg", "json", "pdf", "publication"].forEach((key) => { this.dom[key].disabled = true; });
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
      const number = (value) => Number.isFinite(value) ? Number(value).toPrecision(5) : "—";
      const metrics = (entries) => ui.el("dl", { className: "langmuir-metrics" }, entries.map(([label, value]) =>
        ui.el("div", {}, [ui.el("dt", { text: label }), ui.el("dd", { text: String(value) })])));
      const rows = payload.results.map((row) => {
        const children = [ui.el("h4", { text: `Curve: ${row.name}` })];
        if (row.status !== "ok") {
          children.push(ui.el("p", { className: "field-hint", text: `Fit unavailable: ${row.message}` }));
        } else {
          children.push(metrics([
            ["N", row.n], ["γ(t₀) (mN/m)", number(row.gammaStart)], ["γ∞ (mN/m)", number(row.gammaInf)],
            ["End gap γend − γ∞ (mN/m)", number(row.endpointGap)],
            ["R²", number(row.rSquared)], ["RMSE (mN/m)", number(row.rmse)],
          ]));
          const components = double
            ? (row.components || []).map((component, index) => ({
              title: index === 0 ? "Fast component" : "Slow component",
              entries: [["A (mN/m)", number(component.amplitude)], ["τ (s)", number(component.tauSeconds)], ["k (s⁻¹)", number(component.kObsPerSecond)]],
            }))
            : [{ title: "Relaxation", entries: [
              ["A (mN/m)", number(row.amplitude)], ["τ (s)", number(row.tauSeconds)],
              ["k_obs (s⁻¹)", number(row.kObsPerSecond)], ["t½ (s)", number(row.halfTimeSeconds)],
            ] }];
          children.push(ui.el("div", { className: "langmuir-components" }, components.map((component) =>
            ui.el("section", { className: "langmuir-component" }, [ui.el("h5", { text: component.title }), metrics(component.entries)]))));
          children.push(ui.el("p", { className: "langmuir-fit-window", text: `Fit window (${payload.xLabel || "source time"}): ${number(row.t0)} – ${number(row.timeEnd)}` }));
        }
        return ui.el("section", { className: "langmuir-curve-result", attrs: { "aria-label": `${row.name} fit parameters` } }, children);
      });
      ui.replaceChildren(this.dom.table, [ui.el("div", { className: "langmuir-results" }, rows)]);
      const warnings = payload.results.flatMap((row) => (row.status === "ok" ? row.warnings : []).map((message) => ui.el("li", { text: `${row.name}: ${message}` })));
      ui.replaceChildren(this.dom.warnings, [ui.el("p", { className: "field-hint", text: payload.assumptions }),
        ...(warnings.length ? [ui.el("ul", { className: "field-hint" }, warnings)] : [])]);
      this.dom.json.disabled = false;
      ["png", "svg", "pdf", "publication"].forEach((key) => { this.dom[key].disabled = !fitted; });
      if (fitted) {
        await this.parent.charts.renderLangmuirPlot(this.dom.canvas, payload);
        if (this.dom.residualSection.open) await this.parent.charts.renderLangmuirPlot(this.dom.residualCanvas, payload, true);
      }
    }
  }

  window.SurfaceLabLangmuirModule = { createController: (parent) => new LangmuirController(parent) };
})();
