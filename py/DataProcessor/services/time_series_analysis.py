from dataclasses import dataclass
import re
from typing import Any, Mapping

import numpy as np
import pandas as pd

from DataProcessor.services.errors import DataProcessingError


TREND_METHOD_LABELS = {
    "moving_average": "Moving Average / Rolling Mean",
    "median_filter": "Median Filter",
    "savitzky_golay": "Savitzky-Golay Filter",
}

NOISE_METHOD_LABELS = {
    "residual_std": "Residual Standard Deviation",
    "adjacent_difference": "Adjacent Difference Statistics",
    "rolling_std": "Rolling Standard Deviation",
    "allan_deviation": "Allan Deviation",
    "psd": "Power Spectral Density (PSD)",
}

PSD_PROCESSING_LABELS = {
    "none": "None",
    "remove_mean_only": "Remove mean only",
    "linear_detrend": "Linear detrend",
    "subtract_extracted_trend": "Subtract extracted trend",
}


@dataclass
class TrendAnalysisResult:
    method_key: str
    method_label: str
    parameters: dict[str, Any]
    trend_values: pd.DataFrame
    summary_text: str


@dataclass
class NoiseAnalysisResult:
    method_key: str
    method_label: str
    parameters: dict[str, Any]
    summary_text: str
    summary_columns: list[str]
    summary_rows: list[dict[str, Any]]
    plot_payload: dict[str, Any] | None = None


def _json_number(value: Any) -> float | int | None:
    if value is None:
        return None
    if isinstance(value, (int, np.integer)):
        return int(value)
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if np.isfinite(numeric) else None


def _append_quality_warning(
    warnings: list[dict[str, Any]],
    suggested_actions: list[str],
    *,
    code: str,
    severity: str,
    message: str,
    action: str,
) -> None:
    warnings.append({"code": code, "severity": severity, "message": message})
    if action not in suggested_actions:
        suggested_actions.append(action)


def _robust_outlier_count(values: np.ndarray) -> int:
    finite = values[np.isfinite(values)]
    if finite.size < 5:
        return 0

    median = float(np.median(finite))
    mad = float(np.median(np.abs(finite - median)))
    if mad > 0:
        robust_z = np.abs(finite - median) / (1.4826 * mad)
        return int((robust_z > 6).sum())

    median_deviation = np.abs(finite - median)
    fallback_threshold = max(abs(median) * 0.5, 1e-9)
    if median_deviation.max(initial=0) > fallback_threshold:
        return int((median_deviation > fallback_threshold).sum())

    std = float(np.std(finite))
    if std <= 0:
        return 0
    z_score = np.abs(finite - float(np.mean(finite))) / std
    return int((z_score > 6).sum())


def _signal_quality_metrics(series_name: str, values: np.ndarray) -> dict[str, Any]:
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return {
            "series": series_name,
            "validCount": 0,
            "missingCount": int(values.size),
            "min": None,
            "max": None,
            "mean": None,
            "median": None,
            "std": None,
            "range": None,
            "outlierCount": 0,
            "nearConstant": False,
        }

    min_value = float(np.min(finite))
    max_value = float(np.max(finite))
    median = float(np.median(finite))
    std = float(np.std(finite))
    spread = max_value - min_value
    near_constant_threshold = max(abs(median) * 1e-6, 1e-9)

    return {
        "series": series_name,
        "validCount": int(finite.size),
        "missingCount": int(values.size - finite.size),
        "min": _json_number(min_value),
        "max": _json_number(max_value),
        "mean": _json_number(np.mean(finite)),
        "median": _json_number(median),
        "std": _json_number(std),
        "range": _json_number(spread),
        "outlierCount": _robust_outlier_count(values),
        "nearConstant": bool(finite.size >= 3 and spread <= near_constant_threshold),
    }


def analyze_time_series_quality(
    *,
    x_label: str,
    x_values: pd.Series,
    y_values: pd.DataFrame,
    row_range: tuple[int, int] | None = None,
    selection_label: str | None = None,
) -> dict[str, Any]:
    """Inspect selected time-series data for common quality issues."""
    x_numeric = pd.to_numeric(x_values, errors="coerce").to_numpy(dtype=float)
    y_numeric = y_values.apply(lambda series: pd.to_numeric(series, errors="coerce"))
    y_array = y_numeric.to_numpy(dtype=float)

    warnings: list[dict[str, Any]] = []
    suggested_actions: list[str] = []
    row_count = int(len(x_numeric))
    series_count = int(len(y_numeric.columns))

    if row_count == 0 or series_count == 0:
        raise DataProcessingError("No valid data is selected for diagnostics.")

    finite_time = np.isfinite(x_numeric)
    finite_signal_any = np.isfinite(y_array).any(axis=1)
    valid_rows = finite_time & finite_signal_any
    valid_row_count = int(valid_rows.sum())

    missing_time_count = int(row_count - finite_time.sum())
    missing_signal_count = int(np.size(y_array) - np.isfinite(y_array).sum())
    if missing_time_count or missing_signal_count:
        _append_quality_warning(
            warnings,
            suggested_actions,
            code="missing-or-nonnumeric-values",
            severity="warning",
            message=(
                f"Found {missing_time_count} missing/non-numeric time value(s) and "
                f"{missing_signal_count} missing/non-numeric signal value(s)."
            ),
            action="Review missing values, headers, and numeric formatting before running deeper analysis.",
        )

    if valid_row_count < 5:
        _append_quality_warning(
            warnings,
            suggested_actions,
            code="too-few-points",
            severity="error",
            message=f"Only {valid_row_count} row(s) contain both time and signal values.",
            action="Select a wider row range or provide a dataset with at least five valid points.",
        )

    x_finite = x_numeric[finite_time]
    duplicate_time_count = 0
    negative_interval_count = 0
    zero_interval_count = 0
    irregular_interval_count = 0
    large_gap_count = 0
    interval_metrics = {
        "count": 0,
        "median": None,
        "min": None,
        "max": None,
        "irregularCount": 0,
        "largeGapCount": 0,
    }

    if x_finite.size >= 2:
        _, duplicate_counts = np.unique(x_finite, return_counts=True)
        duplicate_time_count = int(np.clip(duplicate_counts - 1, 0, None).sum())
        diffs = np.diff(x_finite)
        negative_interval_count = int((diffs < 0).sum())
        zero_interval_count = int(np.isclose(diffs, 0.0, rtol=1e-12, atol=1e-12).sum())
        positive_diffs = diffs[diffs > 0]

        if positive_diffs.size:
            median_interval = float(np.median(positive_diffs))
            min_interval = float(np.min(positive_diffs))
            max_interval = float(np.max(positive_diffs))
            if median_interval > 0:
                relative_deviation = np.abs(positive_diffs - median_interval) / median_interval
                irregular_interval_count = int((relative_deviation > 0.2).sum())
                large_gap_count = int((positive_diffs > median_interval * 3).sum())
            interval_metrics = {
                "count": int(positive_diffs.size),
                "median": _json_number(median_interval),
                "min": _json_number(min_interval),
                "max": _json_number(max_interval),
                "irregularCount": irregular_interval_count,
                "largeGapCount": large_gap_count,
            }

    if negative_interval_count:
        _append_quality_warning(
            warnings,
            suggested_actions,
            code="non-monotonic-time-axis",
            severity="warning",
            message=f"Found {negative_interval_count} decreasing time interval(s).",
            action="Sort rows by time or split separate runs before trend/noise analysis.",
        )

    if duplicate_time_count:
        _append_quality_warning(
            warnings,
            suggested_actions,
            code="duplicate-time-values",
            severity="warning",
            message=f"Found {duplicate_time_count} duplicate time value(s).",
            action="Remove duplicate timestamps or average repeated measurements intentionally.",
        )

    if irregular_interval_count:
        _append_quality_warning(
            warnings,
            suggested_actions,
            code="irregular-sampling-interval",
            severity="info",
            message=f"Found {irregular_interval_count} interval(s) that differ from the median by more than 20%.",
            action="Use methods that tolerate irregular sampling or resample to a regular grid.",
        )

    if large_gap_count:
        _append_quality_warning(
            warnings,
            suggested_actions,
            code="large-time-gaps",
            severity="warning",
            message=f"Found {large_gap_count} gap(s) larger than three times the median interval.",
            action="Inspect large gaps and consider analyzing continuous segments separately.",
        )

    signal_metrics = [
        _signal_quality_metrics(str(column), y_numeric[column].to_numpy(dtype=float))
        for column in y_numeric.columns
    ]

    constant_series = [item["series"] for item in signal_metrics if item["nearConstant"]]
    if constant_series:
        _append_quality_warning(
            warnings,
            suggested_actions,
            code="near-constant-signal",
            severity="warning",
            message="Near-constant signal detected in: " + ", ".join(constant_series),
            action="Confirm the selected signal column and row range are correct.",
        )

    outlier_series = [item for item in signal_metrics if item["outlierCount"] > 0]
    if outlier_series:
        total_outliers = sum(int(item["outlierCount"]) for item in outlier_series)
        _append_quality_warning(
            warnings,
            suggested_actions,
            code="extreme-outliers-or-spikes",
            severity="warning",
            message=f"Found {total_outliers} extreme outlier/spike candidate(s) across selected series.",
            action="Inspect spikes in the raw data before smoothing, trend extraction, or PSD analysis.",
        )

    if not suggested_actions:
        suggested_actions.append("No immediate cleanup is suggested for this selection.")

    metrics = {
        "rowCount": row_count,
        "validRowCount": valid_row_count,
        "seriesCount": series_count,
        "missingTimeCount": missing_time_count,
        "missingSignalValueCount": missing_signal_count,
        "duplicateTimeCount": duplicate_time_count,
        "nonMonotonicIntervalCount": negative_interval_count,
        "zeroIntervalCount": zero_interval_count,
        "samplingInterval": interval_metrics,
        "signals": signal_metrics,
    }

    summary = {
        "status": "warnings" if warnings else "clean",
        "message": (
            f"Data quality diagnostics found {len(warnings)} issue(s)."
            if warnings
            else "Data quality diagnostics found no obvious issues."
        ),
        "xLabel": x_label,
        "rowRange": list(row_range) if row_range is not None else None,
        "selection": selection_label,
        "rowCount": row_count,
        "validRowCount": valid_row_count,
        "seriesCount": series_count,
    }

    return {
        "summary": summary,
        "warnings": warnings,
        "metrics": metrics,
        "suggestedActions": suggested_actions,
    }


def _coerce_numeric_series(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def _parse_bool(params: Mapping[str, Any], key: str, default: bool = False) -> bool:
    value = params.get(key, default)
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _parse_positive_int(
    params: Mapping[str, Any],
    key: str,
    label: str,
    min_value: int = 1,
) -> int:
    raw = str(params.get(key, "")).strip()
    if not raw:
        raise DataProcessingError(f"{label} is required.")

    try:
        value = int(raw)
    except ValueError as exc:
        raise DataProcessingError(f"{label} must be an integer.") from exc

    if value < min_value:
        raise DataProcessingError(f"{label} must be at least {min_value}.")

    return value


def _parse_optional_positive_float(
    params: Mapping[str, Any],
    key: str,
    label: str,
) -> float | None:
    raw = str(params.get(key, "")).strip()
    if not raw:
        return None

    try:
        value = float(raw)
    except ValueError as exc:
        raise DataProcessingError(f"{label} must be numeric.") from exc

    if value <= 0:
        raise DataProcessingError(f"{label} must be greater than 0.")

    return value


def _parse_choice(
    params: Mapping[str, Any],
    key: str,
    choices: set[str],
    default: str,
) -> str:
    value = str(params.get(key, default)).strip() or default
    if value not in choices:
        raise DataProcessingError(f"Unsupported option '{value}' for {key}.")
    return value


def _estimate_sampling_interval(x_values: pd.Series) -> float:
    x_numeric = pd.to_numeric(x_values, errors="coerce").to_numpy(dtype=float)
    finite = x_numeric[np.isfinite(x_numeric)]
    positive_diffs = np.diff(finite)
    positive_diffs = positive_diffs[positive_diffs > 0]

    if positive_diffs.size == 0:
        raise DataProcessingError("Could not estimate the sampling interval from the time axis.")

    return float(np.median(positive_diffs))


def _axis_seconds_per_unit(x_label: str) -> float:
    lowered = (x_label or "").strip().lower()
    if "ms" in lowered:
        return 0.001
    if re.search(r"(^|[^a-z])s($|[^a-z])", lowered) or "sec" in lowered:
        return 1.0
    raise DataProcessingError(
        "Time-based window units require a time axis labeled in seconds or milliseconds."
    )


def _resolve_time_window_points(
    x_values: pd.Series,
    x_label: str,
    params: Mapping[str, Any],
    size_key: str,
    label: str,
    *,
    allow_time_units: bool,
    require_odd: bool,
    min_points: int,
) -> tuple[int, dict[str, Any]]:
    if allow_time_units:
        unit = _parse_choice(
            params,
            "windowUnit",
            {"points", "milliseconds", "seconds"},
            "points",
        )
    else:
        unit = "points"

    if unit == "points":
        points = _parse_positive_int(params, size_key, label, min_value=min_points)
        normalized = {size_key: points, "windowUnit": unit, "resolvedPoints": points}
    else:
        size_value = _parse_optional_positive_float(params, size_key, label)
        if size_value is None:
            raise DataProcessingError(f"{label} is required.")
        dt = _estimate_sampling_interval(x_values)
        seconds_per_unit = _axis_seconds_per_unit(x_label)
        span_seconds = size_value if unit == "seconds" else size_value / 1000.0
        span_axis_units = span_seconds / seconds_per_unit
        points = int(round(span_axis_units / dt))
        normalized = {
            size_key: size_value,
            "windowUnit": unit,
            "resolvedPoints": points,
            "estimatedDt": dt,
        }

    if points < min_points:
        raise DataProcessingError(
            f"{label} is too small for the current data resolution."
        )

    if require_odd and points % 2 == 0:
        raise DataProcessingError(f"{label} must be an odd number of points.")

    return points, normalized


def _prepare_filter_input(values: pd.Series, series_name: str) -> tuple[np.ndarray, np.ndarray]:
    numeric = pd.to_numeric(values, errors="coerce").to_numpy(dtype=float)
    valid_mask = np.isfinite(numeric)
    if valid_mask.sum() < 3:
        raise DataProcessingError(
            f"Series '{series_name}' does not have enough valid points for this analysis."
        )

    filled = (
        pd.Series(numeric, dtype=float)
        .interpolate(limit_direction="both")
        .to_numpy(dtype=float)
    )
    return filled, valid_mask


def _rolling_apply(
    y_values: pd.DataFrame,
    *,
    window_points: int,
    reducer: str,
) -> pd.DataFrame:
    frame = pd.DataFrame(index=y_values.index)
    for col in y_values.columns:
        numeric = _coerce_numeric_series(y_values[col])
        rolling = numeric.rolling(window_points, center=True, min_periods=1)
        if reducer == "mean":
            frame[col] = rolling.mean()
        elif reducer == "median":
            frame[col] = rolling.median()
        else:
            raise DataProcessingError(f"Unsupported rolling reducer '{reducer}'.")
    return frame


def _savgol_coefficients(window_length: int, polyorder: int) -> np.ndarray:
    # Solve the local polynomial least-squares system once and reuse the
    # smoothing coefficients for every centered window.
    half = window_length // 2
    x = np.arange(-half, half + 1, dtype=float)
    design = np.vander(x, N=polyorder + 1, increasing=True)
    return np.linalg.pinv(design)[0]


def _apply_savgol_to_frame(
    y_values: pd.DataFrame,
    *,
    window_length: int,
    polyorder: int,
) -> pd.DataFrame:
    coeffs = _savgol_coefficients(window_length, polyorder)
    half = window_length // 2
    frame = pd.DataFrame(index=y_values.index)

    for col in y_values.columns:
        filled, valid_mask = _prepare_filter_input(y_values[col], str(col))
        if valid_mask.sum() < window_length:
            raise DataProcessingError(
                f"Series '{col}' is too short for Savitzky-Golay window length {window_length}."
            )

        padded = np.pad(filled, (half, half), mode="edge")
        smoothed = np.correlate(padded, coeffs, mode="valid")
        smoothed[~valid_mask] = np.nan
        frame[col] = smoothed

    return frame


def extract_trend_analysis(
    *,
    x_label: str,
    x_values: pd.Series,
    y_values: pd.DataFrame,
    method_key: str,
    parameters: Mapping[str, Any],
) -> TrendAnalysisResult:
    if method_key == "moving_average":
        window_points, normalized = _resolve_time_window_points(
            x_values,
            x_label,
            parameters,
            "windowSize",
            "Window size",
            allow_time_units=True,
            require_odd=False,
            min_points=2,
        )
        trend_values = _rolling_apply(y_values, window_points=window_points, reducer="mean")
        summary_text = f"Rolling mean trend with window {window_points} points."
    elif method_key == "median_filter":
        window_points, normalized = _resolve_time_window_points(
            x_values,
            x_label,
            parameters,
            "windowSize",
            "Window size",
            allow_time_units=False,
            require_odd=True,
            min_points=3,
        )
        trend_values = _rolling_apply(y_values, window_points=window_points, reducer="median")
        summary_text = f"Median filter trend with window {window_points} points."
    elif method_key == "savitzky_golay":
        window_length, normalized = _resolve_time_window_points(
            x_values,
            x_label,
            parameters,
            "windowLength",
            "Window length",
            allow_time_units=False,
            require_odd=True,
            min_points=3,
        )
        polyorder = _parse_positive_int(parameters, "polyOrder", "Polynomial order", min_value=1)
        if polyorder >= window_length:
            raise DataProcessingError(
                "Polynomial order must be smaller than the Savitzky-Golay window length."
            )
        normalized["polyOrder"] = polyorder
        trend_values = _apply_savgol_to_frame(
            y_values,
            window_length=window_length,
            polyorder=polyorder,
        )
        summary_text = (
            f"Savitzky-Golay trend with window {window_length} points and order {polyorder}."
        )
    else:
        raise DataProcessingError(f"Unsupported trend extraction method '{method_key}'.")

    return TrendAnalysisResult(
        method_key=method_key,
        method_label=TREND_METHOD_LABELS[method_key],
        parameters=normalized,
        trend_values=trend_values,
        summary_text=summary_text,
    )


def _residual_series(
    raw: pd.Series,
    *,
    trend: pd.Series | None,
    use_trend: bool,
    series_name: str,
) -> np.ndarray:
    raw_numeric = pd.to_numeric(raw, errors="coerce").to_numpy(dtype=float)
    if use_trend:
        if trend is None:
            raise DataProcessingError(
                "Residual Standard Deviation requires an extracted trend. Apply a trend first or disable trend-based residuals."
            )
        trend_numeric = pd.to_numeric(trend, errors="coerce").to_numpy(dtype=float)
        residual = raw_numeric - trend_numeric
    else:
        mean_value = np.nanmean(raw_numeric)
        if not np.isfinite(mean_value):
            raise DataProcessingError(f"Series '{series_name}' has no valid values.")
        residual = raw_numeric - mean_value
    return residual


def _compute_residual_std(
    y_values: pd.DataFrame,
    *,
    trend_values: pd.DataFrame | None,
    parameters: Mapping[str, Any],
) -> NoiseAnalysisResult:
    use_trend = _parse_bool(parameters, "useTrend", default=True)
    rows: list[dict[str, Any]] = []
    std_values: list[float] = []

    for col in y_values.columns:
        residual = _residual_series(
            y_values[col],
            trend=None if trend_values is None else trend_values[col],
            use_trend=use_trend,
            series_name=str(col),
        )
        finite = residual[np.isfinite(residual)]
        if finite.size < 2:
            raise DataProcessingError(
                f"Series '{col}' does not have enough residual points for standard deviation."
            )

        std_value = float(np.std(finite, ddof=1))
        std_values.append(std_value)
        rows.append(
            {
                "Series": str(col),
                "Residual Std": std_value,
                "Points": int(finite.size),
                "Basis": "Trend residual" if use_trend else "Series mean",
            }
        )

    mean_std = float(np.mean(std_values)) if std_values else 0.0
    return NoiseAnalysisResult(
        method_key="residual_std",
        method_label=NOISE_METHOD_LABELS["residual_std"],
        parameters={"useTrend": use_trend},
        summary_text=f"Residual standard deviation computed. Mean std across series: {mean_std:.6g}.",
        summary_columns=["Series", "Residual Std", "Points", "Basis"],
        summary_rows=rows,
    )


def _compute_adjacent_difference(y_values: pd.DataFrame) -> NoiseAnalysisResult:
    rows: list[dict[str, Any]] = []

    for col in y_values.columns:
        numeric = pd.to_numeric(y_values[col], errors="coerce").to_numpy(dtype=float)
        finite = numeric[np.isfinite(numeric)]
        if finite.size < 2:
            raise DataProcessingError(
                f"Series '{col}' does not have enough points for adjacent differences."
            )

        diffs = np.diff(finite)
        abs_diffs = np.abs(diffs)
        rows.append(
            {
                "Series": str(col),
                "Mean |Δ|": float(np.mean(abs_diffs)),
                "Median |Δ|": float(np.median(abs_diffs)),
                "RMS Δ": float(np.sqrt(np.mean(diffs**2))),
                "Max |Δ|": float(np.max(abs_diffs)),
                "Pairs": int(diffs.size),
            }
        )

    return NoiseAnalysisResult(
        method_key="adjacent_difference",
        method_label=NOISE_METHOD_LABELS["adjacent_difference"],
        parameters={},
        summary_text="Adjacent point difference statistics computed for each series.",
        summary_columns=["Series", "Mean |Δ|", "Median |Δ|", "RMS Δ", "Max |Δ|", "Pairs"],
        summary_rows=rows,
    )


def _compute_rolling_std(
    x_values: pd.Series,
    y_values: pd.DataFrame,
    *,
    parameters: Mapping[str, Any],
) -> NoiseAnalysisResult:
    window_points = _parse_positive_int(parameters, "windowSize", "Window size", min_value=2)
    frame = pd.DataFrame(index=y_values.index)
    rows: list[dict[str, Any]] = []

    for col in y_values.columns:
        numeric = _coerce_numeric_series(y_values[col])
        rolling = numeric.rolling(window_points, center=True, min_periods=2).std(ddof=1)
        frame[col] = rolling
        finite = rolling.to_numpy(dtype=float)
        finite = finite[np.isfinite(finite)]
        if finite.size == 0:
            raise DataProcessingError(
                f"Series '{col}' is too short for rolling standard deviation window {window_points}."
            )
        rows.append(
            {
                "Series": str(col),
                "Mean Rolling Std": float(np.mean(finite)),
                "Median Rolling Std": float(np.median(finite)),
                "Max Rolling Std": float(np.max(finite)),
            }
        )

    plot_payload = {
        "title": "Rolling Standard Deviation",
        "xLabel": "Time",
        "yLabel": "Rolling Std",
        "xScale": "linear",
        "yScale": "linear",
        "series": [
            {
                "name": str(col),
                "x": pd.to_numeric(x_values, errors="coerce").tolist(),
                "y": pd.to_numeric(frame[col], errors="coerce").tolist(),
            }
            for col in frame.columns
        ],
    }

    return NoiseAnalysisResult(
        method_key="rolling_std",
        method_label=NOISE_METHOD_LABELS["rolling_std"],
        parameters={"windowSize": window_points},
        summary_text=f"Rolling standard deviation computed with window {window_points} points.",
        summary_columns=["Series", "Mean Rolling Std", "Median Rolling Std", "Max Rolling Std"],
        summary_rows=rows,
        plot_payload=plot_payload,
    )


def _resolve_sampling_interval(
    x_values: pd.Series,
    parameters: Mapping[str, Any],
) -> float:
    manual = _parse_optional_positive_float(
        parameters,
        "samplingInterval",
        "Sampling interval",
    )
    if manual is not None:
        return manual
    return _estimate_sampling_interval(x_values)


def _interpolate_numeric_series(values: pd.Series) -> np.ndarray:
    return (
        pd.to_numeric(values, errors="coerce")
        .interpolate(limit_direction="both")
        .to_numpy(dtype=float)
    )


def _linear_detrend(signal: np.ndarray) -> np.ndarray:
    sample_index = np.arange(signal.size, dtype=float)
    slope, intercept = np.polyfit(sample_index, signal, deg=1)
    return signal - (slope * sample_index + intercept)


def _prepare_psd_signal(
    raw_values: pd.Series,
    *,
    trend_values: pd.Series | None,
    processing_mode: str,
    series_name: str,
) -> np.ndarray:
    filled, _ = _prepare_filter_input(raw_values, series_name)

    if processing_mode == "none":
        return filled
    if processing_mode == "remove_mean_only":
        return filled - np.mean(filled)
    if processing_mode == "linear_detrend":
        # Remove the best-fit line so the PSD reflects oscillatory content
        # rather than slow monotonic drift.
        return _linear_detrend(filled)
    if processing_mode == "subtract_extracted_trend":
        if trend_values is None:
            raise DataProcessingError(
                "PSD with 'Subtract extracted trend' requires an extracted trend. Apply a trend first."
            )

        trend_filled = _interpolate_numeric_series(trend_values)
        if not np.isfinite(trend_filled).any():
            raise DataProcessingError(
                f"Trend for series '{series_name}' does not contain usable values."
            )
        return filled - trend_filled

    raise DataProcessingError(f"Unsupported PSD processing mode '{processing_mode}'.")


def _compute_allan_deviation(
    x_values: pd.Series,
    y_values: pd.DataFrame,
    *,
    parameters: Mapping[str, Any],
) -> NoiseAnalysisResult:
    dt = _resolve_sampling_interval(x_values, parameters)
    tau_count = _parse_positive_int(parameters, "tauCount", "Tau count", min_value=3)
    rows: list[dict[str, Any]] = []
    plot_series: list[dict[str, Any]] = []

    for col in y_values.columns:
        numeric = pd.to_numeric(y_values[col], errors="coerce").to_numpy(dtype=float)
        finite = numeric[np.isfinite(numeric)]
        if finite.size < 4:
            raise DataProcessingError(
                f"Series '{col}' is too short for Allan deviation."
            )

        max_m = max(1, finite.size // 4)
        m_values = np.unique(
            np.clip(
                np.round(np.logspace(0, np.log10(max_m), num=tau_count)).astype(int),
                1,
                max_m,
            )
        )

        tau_values: list[float] = []
        adev_values: list[float] = []

        # Allan deviation compares adjacent block averages at multiple
        # averaging times to reveal noise that changes with scale.
        for m in m_values:
            block_count = finite.size // m
            if block_count < 2:
                continue

            trimmed = finite[: block_count * m]
            block_means = trimmed.reshape(block_count, m).mean(axis=1)
            if block_means.size < 2:
                continue

            adev = float(np.sqrt(0.5 * np.mean(np.diff(block_means) ** 2)))
            tau_values.append(float(m * dt))
            adev_values.append(adev)

        if len(tau_values) < 2:
            raise DataProcessingError(
                f"Series '{col}' does not have enough samples for Allan deviation."
            )

        min_idx = int(np.argmin(adev_values))
        rows.append(
            {
                "Series": str(col),
                "Min Allan Dev": float(adev_values[min_idx]),
                "Tau @ Min": float(tau_values[min_idx]),
                "Largest Tau": float(tau_values[-1]),
            }
        )
        plot_series.append({"name": str(col), "x": tau_values, "y": adev_values})

    return NoiseAnalysisResult(
        method_key="allan_deviation",
        method_label=NOISE_METHOD_LABELS["allan_deviation"],
        parameters={"samplingInterval": dt, "tauCount": tau_count},
        summary_text="Allan deviation computed across automatically spaced averaging times.",
        summary_columns=["Series", "Min Allan Dev", "Tau @ Min", "Largest Tau"],
        summary_rows=rows,
        plot_payload={
            "title": "Allan Deviation",
            "xLabel": "Tau",
            "yLabel": "Allan Deviation",
            "xScale": "log",
            "yScale": "log",
            "series": plot_series,
        },
    )


def _compute_psd(
    x_values: pd.Series,
    y_values: pd.DataFrame,
    *,
    parameters: Mapping[str, Any],
    trend_values: pd.DataFrame | None,
) -> NoiseAnalysisResult:
    dt = _resolve_sampling_interval(x_values, parameters)
    processing_mode = _parse_choice(
        parameters,
        "processingMode",
        set(PSD_PROCESSING_LABELS.keys()),
        "remove_mean_only",
    )
    processing_label = PSD_PROCESSING_LABELS[processing_mode]
    rows: list[dict[str, Any]] = []
    plot_series: list[dict[str, Any]] = []

    for col in y_values.columns:
        signal = _prepare_psd_signal(
            y_values[col],
            trend_values=None if trend_values is None else trend_values[col],
            processing_mode=processing_mode,
            series_name=str(col),
        )
        if signal.size < 4:
            raise DataProcessingError(f"Series '{col}' is too short for PSD.")

        freq = np.fft.rfftfreq(signal.size, d=dt)
        fft = np.fft.rfft(signal)
        psd = (np.abs(fft) ** 2) * dt / signal.size

        valid = (freq > 0) & np.isfinite(psd) & (psd > 0)
        if valid.sum() == 0:
            raise DataProcessingError(f"Series '{col}' does not have valid PSD output.")

        freq = freq[valid]
        psd = psd[valid]
        dominant_idx = int(np.argmax(psd))
        dominant_freq = float(freq[dominant_idx])
        rows.append(
            {
                "Series": str(col),
                "Processing": processing_label,
                "Dominant Freq": dominant_freq,
                "Dominant Period": float(1.0 / dominant_freq) if dominant_freq > 0 else None,
                "Peak PSD": float(psd[dominant_idx]),
            }
        )
        plot_series.append({"name": str(col), "x": freq.tolist(), "y": psd.tolist()})

    return NoiseAnalysisResult(
        method_key="psd",
        method_label=NOISE_METHOD_LABELS["psd"],
        parameters={"samplingInterval": dt, "processingMode": processing_mode},
        summary_text=f"Power spectral density computed using {processing_label.lower()} preprocessing.",
        summary_columns=["Series", "Processing", "Dominant Freq", "Dominant Period", "Peak PSD"],
        summary_rows=rows,
        plot_payload={
            "title": "Power Spectral Density",
            "xLabel": "Frequency",
            "yLabel": "PSD",
            "xScale": "linear",
            "yScale": "log",
            "series": plot_series,
        },
    )


def analyze_noise(
    *,
    x_values: pd.Series,
    y_values: pd.DataFrame,
    method_key: str,
    parameters: Mapping[str, Any],
    trend_values: pd.DataFrame | None = None,
) -> NoiseAnalysisResult:
    if method_key == "residual_std":
        return _compute_residual_std(
            y_values,
            trend_values=trend_values,
            parameters=parameters,
        )
    if method_key == "adjacent_difference":
        return _compute_adjacent_difference(y_values)
    if method_key == "rolling_std":
        return _compute_rolling_std(x_values, y_values, parameters=parameters)
    if method_key == "allan_deviation":
        return _compute_allan_deviation(x_values, y_values, parameters=parameters)
    if method_key == "psd":
        return _compute_psd(
            x_values,
            y_values,
            parameters=parameters,
            trend_values=trend_values,
        )

    raise DataProcessingError(f"Unsupported noise analysis method '{method_key}'.")
