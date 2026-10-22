"""Apparent Langmuir kinetics with a linear tension/coverage approximation.

At constant bulk concentration, coverage relaxes exponentially. Mapping that
relaxation directly onto tension additionally assumes a locally linear equation
of state. This fit cannot establish equilibrium or separate adsorption and
desorption rate constants. See https://pmc.ncbi.nlm.nih.gov/articles/PMC5068272/.
"""
import math

import numpy as np
import pandas as pd

from DataProcessor.services.errors import DataProcessingError
from DataProcessor.services.experiment_screening import time_scale_seconds


MODEL = "gamma(t) = gamma_inf + amplitude * exp(-(t - t0) / tau)"
ASSUMPTIONS = (
    "Apparent single-exponential Langmuir relaxation: constant bulk concentration "
    "and approximately linear surface-tension/coverage response. Unweighted least "
    "squares on unsmoothed observations. gamma_inf is an extrapolated asymptote, "
    "not a measured equilibrium value. A fit does not establish the adsorption "
    "mechanism; k_obs cannot separate adsorption and desorption rates."
)


def _optional_number(options, key):
    value = options.get(key)
    if value is None or str(value).strip() == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise DataProcessingError(f"{key} must be a finite number.") from exc
    if not math.isfinite(number):
        raise DataProcessingError(f"{key} must be a finite number.")
    return number


def _fit_one(x, y, seconds_per_unit):
    warnings = []
    finite = np.isfinite(x) & np.isfinite(y)
    if not finite.all():
        warnings.append(f"Omitted {int((~finite).sum())} non-finite time/tension pairs.")
    x, y = x[finite], y[finite]
    if len(x) < 6 or len(np.unique(x)) < 6:
        raise DataProcessingError("At least 6 finite observations at distinct times are required.")
    if np.any(y <= 0):
        raise DataProcessingError("Surface tension must be positive (mN/m).")
    if np.any(np.diff(x) <= 0):
        warnings.append("Times were sorted; duplicate timestamps retain equal observation weights.")
    order = np.argsort(x, kind="stable")
    x, y = x[order], y[order]
    # Work in dimensionless time to avoid numerical dependence on ms/s/min.
    duration = float(x[-1] - x[0])
    u = (x - x[0]) / duration
    total_ss = float(np.sum((y - np.mean(y)) ** 2))
    if np.ptp(y) < max(1e-10, abs(float(np.mean(y))) * 1e-10):
        raise DataProcessingError("The signal is constant; a relaxation time is not identifiable.")

    def profile(log_tau):
        basis = np.exp(-u / np.exp(log_tau))
        centered = basis - np.mean(basis)
        variance = float(centered @ centered)
        if variance <= 1e-24:
            return math.inf, None
        amplitude = float(centered @ (y - np.mean(y)) / variance)
        asymptote = float(np.mean(y) - amplitude * np.mean(basis))
        if amplitude <= 0 or asymptote <= 0:
            return math.inf, None
        predicted = asymptote + amplitude * basis
        return float(np.sum((y - predicted) ** 2)), (asymptote, amplitude, predicted)

    # Profile out the two linear parameters, then refine the best log(tau)
    # interval. No scipy download is needed in the browser.
    spacing = float(np.min(np.diff(np.unique(u))))
    lower = math.log(max(spacing / 20, 1e-12))
    upper = math.log(1e4)
    grid = np.linspace(lower, upper, 241)
    scores = [profile(value)[0] for value in grid]
    best = int(np.argmin(scores))
    if not math.isfinite(scores[best]):
        raise DataProcessingError("No positive, decreasing exponential fit was found. Check the selected window.")
    left, right = grid[max(0, best - 1)], grid[min(len(grid) - 1, best + 1)]
    ratio = (math.sqrt(5) - 1) / 2
    a, b = right - ratio * (right - left), left + ratio * (right - left)
    fa, fb = profile(a)[0], profile(b)[0]
    for _ in range(70):
        if fa < fb:
            right, b, fb = b, a, fa
            a = right - ratio * (right - left)
            fa = profile(a)[0]
        else:
            left, a, fa = a, b, fb
            b = left + ratio * (right - left)
            fb = profile(b)[0]
    log_tau = float(min([grid[best], a, b], key=lambda value: profile(value)[0]))
    sse, (asymptote, amplitude, predicted) = profile(log_tau)
    tau_axis = math.exp(log_tau) * duration
    tau_seconds = tau_axis * seconds_per_unit
    r_squared = 1 - sse / total_ss
    if best in (0, len(grid) - 1) or log_tau - lower < 0.01 or upper - log_tau < 0.01:
        warnings.append("Relaxation time reached the search boundary; parameters are poorly constrained.")
    if duration / tau_axis < 3:
        warnings.append("The window covers less than 3 tau; the asymptote is weakly constrained.")
    if tau_axis < float(np.median(np.diff(np.unique(x)))):
        warnings.append("tau is shorter than the typical sampling interval; early relaxation is unresolved.")
    if r_squared < 0.8:
        warnings.append("R² < 0.8; inspect residuals and model suitability.")
    if asymptote < 1e-6:
        warnings.append("The asymptote is near the positivity boundary; parameters may be unreliable.")
    curve_x = np.linspace(x[0], x[-1], 300)
    return {
        "status": "ok", "n": len(x), "t0": float(x[0]), "timeEnd": float(x[-1]),
        "gammaStart": asymptote + amplitude, "gammaInf": asymptote,
        "amplitude": amplitude, "tauSeconds": tau_seconds,
        "kObsPerSecond": 1 / tau_seconds, "halfTimeSeconds": tau_seconds * math.log(2),
        "rSquared": r_squared, "rmse": math.sqrt(sse / len(x)), "warnings": warnings,
        "observed": {"x": x.tolist(), "y": y.tolist()},
        "curve": {"x": curve_x.tolist(), "y": (asymptote + amplitude * np.exp(-(curve_x - x[0]) / tau_axis)).tolist()},
        "residuals": {"x": x.tolist(), "y": (y - predicted).tolist()},
    }


def fit_langmuir_kinetics(*, x_label, x_values, y_values, options=None):
    options = options or {}
    unit = options.get("timeUnit", "auto")
    scale = time_scale_seconds(x_label) if unit == "auto" else {"ms": 0.001, "s": 1.0, "min": 60.0}.get(unit)
    if scale is None:
        raise DataProcessingError("Time unit is unknown. Choose ms, s, or min in Langmuir Fit.")
    lower, upper = _optional_number(options, "timeMin"), _optional_number(options, "timeMax")
    if lower is not None and upper is not None and lower >= upper:
        raise DataProcessingError("Fit Time Min must be smaller than Fit Time Max.")
    x = pd.to_numeric(pd.Series(x_values), errors="coerce").to_numpy(dtype=float)
    mask = np.ones(len(x), dtype=bool)
    if lower is not None:
        mask &= x >= lower
    if upper is not None:
        mask &= x <= upper
    results = []
    for name in y_values.columns:
        y = pd.to_numeric(y_values[name], errors="coerce").to_numpy(dtype=float)
        try:
            result = _fit_one(x[mask], y[mask], scale)
        except DataProcessingError as exc:
            result = {"status": "error", "message": str(exc), "warnings": []}
        results.append({"name": str(name), **result})
    return {
        "model": MODEL, "assumptions": ASSUMPTIONS,
        "xLabel": x_label if unit == "auto" else f"Time ({unit})",
        "options": {"timeUnit": unit, "timeMin": lower, "timeMax": upper},
        "secondsPerAxisUnit": scale,
        "summary": {"fitted": sum(row["status"] == "ok" for row in results), "total": len(results)},
        "results": results,
    }
