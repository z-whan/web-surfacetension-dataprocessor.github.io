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
