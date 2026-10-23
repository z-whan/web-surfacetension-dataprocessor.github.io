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
DOUBLE_MODEL = "gamma(t) = gamma_inf + A_fast * exp(-(t - t0) / tau_fast) + A_slow * exp(-(t - t0) / tau_slow)"
ASSUMPTIONS = (
    "Apparent single-exponential Langmuir relaxation: constant bulk concentration "
    "and approximately linear surface-tension/coverage response. Unweighted least "
    "squares on unsmoothed observations. gamma_inf is an extrapolated asymptote, "
    "not a measured equilibrium value. A fit does not establish the adsorption "
    "mechanism; k_obs cannot separate adsorption and desorption rates."
)
DOUBLE_ASSUMPTIONS = (
    "Empirical double-exponential extension of the apparent relaxation model. "
    "Unweighted least squares on unsmoothed observations, with non-negative "
    "amplitudes and tau_fast <= tau_slow. Two fitted time scales do not establish "
    "two adsorption mechanisms. gamma_inf is an extrapolated asymptote, not a "
    "measured equilibrium value. Near-zero components or similar time scales "
    "are poorly identifiable."
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


def _prepare_trace(x, y, minimum_points):
    warnings = []
    finite = np.isfinite(x) & np.isfinite(y)
    if not finite.all():
        warnings.append(f"Omitted {int((~finite).sum())} non-finite time/tension pairs.")
    x, y = x[finite], y[finite]
    if len(x) < minimum_points or len(np.unique(x)) < minimum_points:
        raise DataProcessingError(f"At least {minimum_points} finite observations at distinct times are required.")
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
    return x, y, u, total_ss, warnings


def _fit_one(x, y, seconds_per_unit):
    x, y, u, total_ss, warnings = _prepare_trace(x, y, 6)
    duration = float(x[-1] - x[0])

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


def _positive_linear_fit(design, y, mean_y, centered_y):
    """Solve the three-coefficient non-negative problem by active sets.

    The baseline has a tiny positive floor; either amplitude may reach zero so
    a single-exponential trace can be diagnosed as a degenerate double fit.
    """
    # Closed-form two-predictor regression avoids thousands of tall-matrix
    # SVD calls in WebAssembly. Centering keeps the free baseline stable.
    baseline_floor = 1e-12
    first, second = design[:, 1], design[:, 2]
    mean_first, mean_second = float(np.mean(first)), float(np.mean(second))
    centered_first, centered_second = first - mean_first, second - mean_second
    v1, v2 = float(centered_first @ centered_first), float(centered_second @ centered_second)
    cross = float(centered_first @ centered_second)
    target1, target2 = float(centered_first @ centered_y), float(centered_second @ centered_y)

    def solve_pair(a, b, c, d, e):
        determinant = a * b - c * c
        if determinant <= max(1e-30, 1e-12 * a * b):
            return None
        return (d * b - e * c) / determinant, (e * a - d * c) / determinant

    def result(coefficients):
        coefficients = np.asarray(coefficients)
        # Evaluate residuals directly; subtracting quadratic sums would lose
        # precision near an exact fit and flatten the optimization objective.
        return float(np.sum((y - design @ coefficients) ** 2)), coefficients

    pair = solve_pair(v1, v2, cross, target1, target2)
    if pair is not None:
        baseline = mean_y - pair[0] * mean_first - pair[1] * mean_second
        if baseline >= baseline_floor and min(pair) >= 0:
            return result([baseline, *pair])

    candidates = [[max(baseline_floor, mean_y), 0, 0]]
    for index, variance, target, mean in ((1, v1, target1, mean_first), (2, v2, target2, mean_second)):
        amplitude = target / variance if variance > 1e-30 else -1
        baseline = mean_y - amplitude * mean
        if amplitude >= 0 and baseline >= baseline_floor:
            coefficients = [baseline, 0, 0]
            coefficients[index] = amplitude
            candidates.append(coefficients)
    shifted_y = y - baseline_floor
    raw1, raw2, raw_cross = float(first @ first), float(second @ second), float(first @ second)
    raw_target1, raw_target2 = float(first @ shifted_y), float(second @ shifted_y)
    pair = solve_pair(raw1, raw2, raw_cross, raw_target1, raw_target2)
    if pair is not None and min(pair) >= 0:
        candidates.append([baseline_floor, *pair])
    if raw1 > 1e-30:
        candidates.append([baseline_floor, max(0, raw_target1 / raw1), 0])
    if raw2 > 1e-30:
        candidates.append([baseline_floor, 0, max(0, raw_target2 / raw2)])
    return min((result(coefficients) for coefficients in candidates), key=lambda item: item[0])


def _refine_two_times(profile, initial, step, lower, upper):
    """Bounded two-dimensional Nelder-Mead on profiled log time constants."""
    simplex = np.clip(np.array([initial, initial + [step, 0], initial + [0, step]]), lower, upper)
    scores = np.array([profile(point)[0] for point in simplex])
    for _ in range(300):
        order = np.argsort(scores)
        simplex, scores = simplex[order], scores[order]
        if np.max(np.abs(simplex[1:] - simplex[0])) < 1e-8:
            break
        center = np.mean(simplex[:2], axis=0)
        reflected = np.clip(2 * center - simplex[2], lower, upper)
        reflected_score = profile(reflected)[0]
        if reflected_score < scores[0]:
            expanded = np.clip(center + 2 * (reflected - center), lower, upper)
            expanded_score = profile(expanded)[0]
            simplex[2], scores[2] = (expanded, expanded_score) if expanded_score < reflected_score else (reflected, reflected_score)
        elif reflected_score < scores[1]:
            simplex[2], scores[2] = reflected, reflected_score
        else:
            outside = reflected_score < scores[2]
            contracted = np.clip(center + 0.5 * ((reflected if outside else simplex[2]) - center), lower, upper)
            contracted_score = profile(contracted)[0]
            if contracted_score < (reflected_score if outside else scores[2]):
                simplex[2], scores[2] = contracted, contracted_score
            else:
                simplex[1:] = (simplex[0] + simplex[1:]) / 2
                scores[1:] = [profile(point)[0] for point in simplex[1:]]
    best = int(np.argmin(scores))
    return scores[best], np.sort(simplex[best])


def _fit_double(x, y, seconds_per_unit):
    x, y, u, total_ss, warnings = _prepare_trace(x, y, 10)
    duration = float(x[-1] - x[0])
    spacing = float(np.min(np.diff(np.unique(u))))
    lower, upper = math.log(max(spacing / 20, 1e-12)), math.log(1e4)
    mean_y = float(np.mean(y))
    centered_y = y - mean_y

    def profile(log_times):
        times = np.exp(np.sort(log_times))
        design = np.column_stack((np.ones(len(u)), np.exp(-u / times[0]), np.exp(-u / times[1])))
        return _positive_linear_fit(design, y, mean_y, centered_y)

    # Coarse two-dimensional search followed by several independent local
    # refinements. Every evaluation uses all selected observations.
    grid = np.linspace(lower, upper, 30)
    candidates = sorted((profile([fast, slow])[0], fast, slow)
                        for index, fast in enumerate(grid) for slow in grid[index + 1:])
    starts = []
    for score, fast, slow in candidates:
        point = np.array([fast, slow])
        if all(np.linalg.norm(point - previous) > 0.9 for previous in starts):
            starts.append(point)
        if len(starts) == 6:
            break
    refinements = [_refine_two_times(profile, point, float(grid[1] - grid[0]) / 2, lower, upper) for point in starts]
    _, log_times = min(refinements, key=lambda result: result[0])
    sse, coefficients = profile(log_times)
    if coefficients is None or not math.isfinite(sse) or float(np.sum(coefficients[1:])) <= 1e-10:
        raise DataProcessingError("No positive, decreasing double-exponential fit was found. Check the selected window.")
    asymptote, fast_amplitude, slow_amplitude = coefficients.tolist()
    tau_axis = np.exp(log_times) * duration
    basis = np.exp(-u[:, None] / np.exp(log_times))
    predicted = asymptote + basis @ coefficients[1:]
    r_squared = 1 - sse / total_ss
    if np.any(log_times - lower < 0.01) or np.any(upper - log_times < 0.01):
        warnings.append("A relaxation time reached the search boundary; parameters are poorly constrained.")
    if tau_axis[1] / tau_axis[0] < 2:
        warnings.append("The two time scales differ by less than a factor of 2; components are difficult to distinguish.")
    if min(fast_amplitude, slow_amplitude) < 0.02 * (fast_amplitude + slow_amplitude):
        warnings.append("One component contributes less than 2% of the amplitude; a single exponential may suffice.")
    # Normalized Jacobian condition measures local dependence of the five
    # parameters without mixing the units of amplitude and log time.
    jacobian = np.column_stack((np.ones(len(u)), basis, basis * (u[:, None] / np.exp(log_times)) * coefficients[1:]))
    norms = np.linalg.norm(jacobian, axis=0)
    condition = float(np.linalg.cond(jacobian / np.maximum(norms, 1e-30)))
    if condition > 1e6:
        warnings.append("Double-exponential parameters are poorly identifiable (ill-conditioned fit); inspect the single-exponential alternative.")
    if duration / tau_axis[1] < 3:
        warnings.append("The window covers less than 3 tau_slow; the slow component and asymptote are weakly constrained.")
    if tau_axis[0] < float(np.median(np.diff(np.unique(x)))):
        warnings.append("tau_fast is shorter than the typical sampling interval; fast relaxation is unresolved.")
    if r_squared < 0.8:
        warnings.append("R² < 0.8; inspect residuals and model suitability.")
    if asymptote < 1e-6:
        warnings.append("The asymptote is near the positivity boundary; parameters may be unreliable.")
    components = []
    for label, amplitude, tau in zip(("fast", "slow"), (fast_amplitude, slow_amplitude), tau_axis):
        seconds = float(tau * seconds_per_unit)
        components.append({"label": label, "amplitude": amplitude, "tauSeconds": seconds,
                           "kObsPerSecond": 1 / seconds, "halfTimeSeconds": seconds * math.log(2)})
    curve_x = np.linspace(x[0], x[-1], 300)
    curve_y = asymptote + np.exp(-(curve_x - x[0])[:, None] / tau_axis) @ coefficients[1:]
    return {
        "status": "ok", "n": len(x), "t0": float(x[0]), "timeEnd": float(x[-1]),
        "gammaStart": float(np.sum(coefficients)), "gammaInf": asymptote,
        "components": components, "rSquared": r_squared, "rmse": math.sqrt(sse / len(x)),
        "warnings": warnings,
        "observed": {"x": x.tolist(), "y": y.tolist()},
        "curve": {"x": curve_x.tolist(), "y": curve_y.tolist()},
        "residuals": {"x": x.tolist(), "y": (y - predicted).tolist()},
    }


def fit_langmuir_kinetics(*, x_label, x_values, y_values, options=None):
    options = options or {}
    model = options.get("model", "single")
    if model not in ("single", "double"):
        raise DataProcessingError("Choose a single- or double-exponential fit model.")
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
            fitter = _fit_double if model == "double" else _fit_one
            result = fitter(x[mask], y[mask], scale)
        except DataProcessingError as exc:
            result = {"status": "error", "message": str(exc), "warnings": []}
        results.append({"name": str(name), **result})
    return {
        "model": DOUBLE_MODEL if model == "double" else MODEL,
        "modelKey": model, "modelLabel": "Double exponential" if model == "double" else "Single exponential",
        "assumptions": DOUBLE_ASSUMPTIONS if model == "double" else ASSUMPTIONS,
        "xLabel": x_label if unit == "auto" else f"Time ({unit})",
        "options": {"model": model, "timeUnit": unit, "timeMin": lower, "timeMax": upper},
        "secondsPerAxisUnit": scale,
        "summary": {"fitted": sum(row["status"] == "ok" for row in results), "total": len(results)},
        "results": results,
    }
