"""Data-only, vector PDF reports for fitted relaxation curves."""
import io
import math
import textwrap

import numpy as np

from DataProcessor.services.errors import DataProcessingError


FAST_COLOR = "#0072B2"
SLOW_COLOR = "#D55E00"


def _number(value, digits=5):
    if value is None or not math.isfinite(float(value)):
        return "-"
    return f"{float(value):.{digits}g}"


def decompose_fit(row, seconds_per_unit, double):
    """Compute decreases from the model value at t0, not remaining amplitudes."""
    if not math.isfinite(seconds_per_unit) or seconds_per_unit <= 0:
        raise DataProcessingError("PDF export requires a valid time-unit scale.")
    components = row.get("components", []) if double else [{
        "label": "single", "amplitude": row["amplitude"], "tauSeconds": row["tauSeconds"],
        "kObsPerSecond": row["kObsPerSecond"], "halfTimeSeconds": row["halfTimeSeconds"],
    }]
    if len(components) != (2 if double else 1):
        raise DataProcessingError("Fit components are missing from the PDF input.")
    t0 = float(row["t0"])
    duration = (float(row["timeEnd"]) - t0) * seconds_per_unit
    if not math.isfinite(duration) or duration <= 0:
        raise DataProcessingError("PDF export requires a positive fit duration.")
    elapsed = np.linspace(0, duration, 400)
    amplitudes = np.array([float(item["amplitude"]) for item in components])
    taus = np.array([float(item["tauSeconds"]) for item in components])
    if np.any(~np.isfinite(amplitudes)) or np.any(amplitudes < 0) or np.any(~np.isfinite(taus)) or np.any(taus <= 0):
        raise DataProcessingError("Invalid component parameters in the PDF input.")
    decreases = amplitudes[:, None] * -np.expm1(-elapsed[None, :] / taus[:, None])
    window_drop = decreases[:, -1]
    amplitude_sum, window_sum = float(amplitudes.sum()), float(window_drop.sum())
    if amplitude_sum <= 0 or window_sum <= 0:
        raise DataProcessingError("Component contributions require a positive surface-tension decrease.")
    observed = row["observed"]
    residuals = row["residuals"]
    return {
        "components": components, "elapsedSeconds": elapsed,
        "componentDecreases": decreases, "totalDecrease": decreases.sum(axis=0),
        "windowDecreases": window_drop,
        "windowPercent": 100 * window_drop / window_sum,
        "asymptoticPercent": 100 * amplitudes / amplitude_sum,
        "observedTime": (np.array(observed["x"], dtype=float) - t0) * seconds_per_unit,
        "observedY": np.array(observed["y"], dtype=float),
        "endpointGap": float(observed["y"][-1]) - float(row["gammaInf"]),
        "residualTime": (np.array(residuals["x"], dtype=float) - t0) * seconds_per_unit,
        "residualY": np.array(residuals["y"], dtype=float),
        "fittedY": float(row["gammaStart"]) - decreases.sum(axis=0),
        "durationSeconds": duration,
    }


def _style_axis(ax, title, x_label, y_label):
    ax.set_title(title, loc="left", fontsize=10, fontweight="bold", pad=8)
    ax.set_xlabel(x_label, labelpad=5)
    ax.set_ylabel(y_label, labelpad=5)
    ax.grid(True, linewidth=0.4, color="#dddddd", zorder=0)
    ax.set_axisbelow(True)
    ax.tick_params(labelsize=8, width=0.6, length=3)
    ax.ticklabel_format(axis="both", style="sci", scilimits=(-3, 5), useMathText=True)
    ax.xaxis.get_offset_text().set_fontsize(7)
    ax.yaxis.get_offset_text().set_fontsize(7)
    for spine in ax.spines.values():
        spine.set_color("#777777")
        spine.set_linewidth(0.6)


def _table(fig, bounds, columns, rows, widths=None):
    ax = fig.add_axes(bounds)
    ax.axis("off")
    table = ax.table(cellText=rows, colLabels=columns, cellLoc="center", loc="center", colWidths=widths, bbox=[0, 0, 1, 1])
    table.auto_set_font_size(False)
    table.set_fontsize(8)
    for (row, column), cell in table.get_celld().items():
        cell.set_edgecolor("#d5d5d5")
        cell.set_linewidth(0.5)
        cell.PAD = 0.06
        if row == 0:
            cell.set_facecolor("#f0f2f4")
    return table


def create_langmuir_pdf(payload):
    # Imports stay lazy so normal fitting does not download matplotlib.
    import matplotlib as mpl
    from matplotlib.backends.backend_pdf import PdfPages
    from matplotlib.figure import Figure

    fitted_rows = [row for row in payload.get("results", []) if row.get("status") == "ok"]
    if not fitted_rows:
        raise DataProcessingError("Run a successful fit before exporting a PDF.")
    double = payload.get("modelKey") == "double"
    seconds_per_unit = float(payload["secondsPerAxisUnit"])
    output = io.BytesIO()
    style = {
        "font.family": "DejaVu Sans", "font.size": 8, "mathtext.fontset": "dejavusans",
        "text.usetex": False, "pdf.fonttype": 42, "pdf.compression": 6,
        "axes.labelsize": 8, "legend.fontsize": 7, "axes.unicode_minus": True,
    }
    with mpl.rc_context(style), PdfPages(output, metadata={
        "Title": "Relaxation fit", "Author": "Surface Tension Analysis Tool",
        "Subject": payload.get("sourceName", ""), "CreationDate": None, "ModDate": None,
    }) as pdf:
        for page, row in enumerate(fitted_rows, 1):
            data = decompose_fit(row, seconds_per_unit, double)
            fig = Figure(figsize=(11.69, 8.27), facecolor="white")
            # Identifiers and numeric metadata only; no interpretation paragraphs.
            source = str(payload.get("sourceName", ""))
            curve = str(row.get("name", ""))
            title = f"{source}  |  {curve}"
            fig.text(0.065, 0.965, "\n".join(textwrap.wrap(title, width=120)[:2]), fontsize=10, fontweight="bold", va="top", parse_math=False)
            selection = payload.get("selection", {})
            rows = payload.get("rowRange", [])
            row_text = "-".join(str(value) for value in rows) or "-"
            experiment = selection.get("expRangeText") or payload.get("expTag") or "-"
            t0_seconds, end_seconds = float(row["t0"]) * seconds_per_unit, float(row["timeEnd"]) * seconds_per_unit
            fig.text(0.065, 0.915,
                     f"Rows: {row_text}    Experiments: {experiment}    t0: {_number(t0_seconds)} s    t_end: {_number(end_seconds)} s",
                     fontsize=8, parse_math=False)
            equation = (r"$\gamma(t)=\gamma_\infty+A_{\mathrm{fast}}e^{-(t-t_0)/\tau_{\mathrm{fast}}}+A_{\mathrm{slow}}e^{-(t-t_0)/\tau_{\mathrm{slow}}}$"
                        if double else r"$\gamma(t)=\gamma_\infty+A e^{-(t-t_0)/\tau}$")
            fig.text(0.065, 0.865, equation, fontsize=14)
            _table(fig, [0.065, 0.775, 0.90, 0.065],
                   [r"$\gamma(t_0)$ (mN/m)", r"$\gamma_\infty$ (mN/m)", r"$\gamma_{\mathrm{end}}-\gamma_\infty$ (mN/m)", "N", r"$R^2$", "RMSE (mN/m)", "T (s)"],
                   [[_number(row["gammaStart"]), _number(row["gammaInf"]), _number(data["endpointGap"]), str(row["n"]),
                     _number(row["rSquared"]), _number(row["rmse"]), _number(data["durationSeconds"])]])
            component_rows = []
            labels = ["Fast", "Slow"] if double else ["Single"]
            colors = [FAST_COLOR, SLOW_COLOR] if double else [FAST_COLOR]
            for index, component in enumerate(data["components"]):
                component_rows.append([
                    labels[index], _number(component["amplitude"]), _number(component["tauSeconds"]),
                    _number(component["kObsPerSecond"]), _number(component["halfTimeSeconds"]),
                    _number(data["windowDecreases"][index]),
                    _number(data["windowPercent"][index], 4), _number(data["asymptoticPercent"][index], 4),
                ])
            _table(fig, [0.065, 0.660, 0.90, 0.092 if double else 0.065],
                   ["Component", "A (mN/m)", r"$\tau$ (s)", r"$k$ (s$^{-1}$)", r"$t_{1/2}$ (s)",
                    r"$\Delta\gamma_i(T)$ (mN/m)", r"$\Delta\gamma_i(T)/\Sigma\Delta\gamma_j(T)$ (%)", r"$A_i/\Sigma A_j$ (%)"],
                   component_rows, widths=[0.10, 0.10, 0.10, 0.10, 0.10, 0.14, 0.22, 0.14])
            axes = fig.subplots(2, 2, gridspec_kw={"left": 0.08, "right": 0.96, "bottom": 0.075, "top": 0.60, "wspace": 0.26, "hspace": 0.48})
            time_label = r"$t-t_0$ (s)"
            fit_ax, drop_ax, share_ax, residual_ax = axes.flat
            _style_axis(fit_ax, "Surface tension", time_label, r"$\gamma$ (mN/m)")
            fit_ax.scatter(data["observedTime"], data["observedY"], s=8, c=FAST_COLOR, alpha=0.70, linewidths=0, label="Data", zorder=3)
            fit_ax.plot(data["elapsedSeconds"], data["fittedY"], color="#171717", linewidth=1.2, label="Fit", zorder=2)
            fit_ax.legend(loc="best", frameon=False, ncol=2)
            _style_axis(drop_ax, "Cumulative decrease", time_label, r"$\Delta\gamma$ (mN/m)")
            drop_ax.stackplot(data["elapsedSeconds"], data["componentDecreases"], colors=colors, labels=labels, alpha=0.70)
            drop_ax.plot(data["elapsedSeconds"], data["totalDecrease"], color="#171717", linewidth=1.1, label="Total")
            drop_ax.set_ylim(bottom=0)
            drop_ax.legend(loc="best", frameon=False, ncol=len(labels) + 1)
            share_ax.set_title("Component contribution", loc="left", fontsize=10, fontweight="bold", pad=8)
            left = np.zeros(2)
            for index, (label, color) in enumerate(zip(labels, colors)):
                values = np.array([data["windowPercent"][index], data["asymptoticPercent"][index]])
                share_ax.barh([1, 0], values, left=left, color=color, height=0.45, label=label)
                for position, value, start in zip([1, 0], values, left):
                    if value >= 10:
                        share_ax.text(start + value / 2, position, f"{value:.1f}%", ha="center", va="center", color="white", fontsize=9, fontweight="bold")
                left += values
            share_ax.set_yticks([1, 0], [f"T = {_number(data['durationSeconds'])} s", r"$t\rightarrow\infty$"])
            share_ax.set_xticks([0, 25, 50, 75, 100])
            share_ax.set_xlim(0, 100)
            share_ax.set_ylim(-0.7, 1.7)
            share_ax.set_xlabel("Contribution (%)")
            share_ax.tick_params(labelsize=8, length=0)
            share_ax.legend(loc="upper right", frameon=False, ncol=len(labels))
            for spine in share_ax.spines.values():
                spine.set_visible(False)
            _style_axis(residual_ax, "Residuals", time_label, r"$\gamma_{\mathrm{data}}-\gamma_{\mathrm{fit}}$ (mN/m)")
            residual_ax.axhline(0, color="#171717", linewidth=0.8, linestyle="--")
            residual_ax.scatter(data["residualTime"], data["residualY"], s=7, color=FAST_COLOR, alpha=0.65, linewidths=0)
            fig.text(0.965, 0.025, f"{page} / {len(fitted_rows)}", fontsize=7, ha="right", color="#777777")
            pdf.savefig(fig)
            fig.clear()
    return output.getvalue()
