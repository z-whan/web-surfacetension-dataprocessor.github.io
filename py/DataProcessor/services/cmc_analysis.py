import os
import re
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np
import pandas as pd

from DataProcessor.services.errors import DataProcessingError

QC_NO_VALID_DATA = "NO_VALID_DATA"
QC_NO_PLATEAU = "NO_PLATEAU"
QC_HIGH_FINAL_DRIFT = "HIGH_FINAL_DRIFT"
QC_HIGH_NOISE = "HIGH_NOISE"
QC_HIGH_VOLUME_LOSS = "HIGH_VOLUME_LOSS"
QC_OUTLIER_WITHIN_CONCENTRATION = "OUTLIER_WITHIN_CONCENTRATION"

DEFAULT_CMC_QC_OPTIONS: dict[str, Any] = {
    "plateauMode": "manual",
    "minPlateauWindowMs": 5000.0,
    "maxAbsSlopeMnMPerMin": 0.5,
    "maxPlateauSdMnM": 0.5,
    "maxVolumeLossPct": 10.0,
    "aggregationMethod": "mean",
    "fitModel": "segmented_continuous",
    "sampleType": "unknown",
    "minPointsPerSegment": 2,
    "nBootstrap": 200,
}

FIT_NOT_ENOUGH_CONCENTRATIONS = "NOT_ENOUGH_CONCENTRATIONS"
FIT_LOG_REQUIRES_POSITIVE = "LOG_REQUIRES_POSITIVE_CONCENTRATIONS"
FIT_BREAKPOINT_AT_BOUNDARY = "BREAKPOINT_AT_BOUNDARY"
FIT_NO_CLEAR_PLATEAU = "NO_CLEAR_PLATEAU"
FIT_HIGH_POST_CMC_SLOPE = "HIGH_POST_CMC_SLOPE"
FIT_NON_MONOTONIC_OR_DIP = "NON_MONOTONIC_OR_DIP"
FIT_HIGH_OUTLIER_INFLUENCE = "HIGH_OUTLIER_INFLUENCE"


@dataclass
class CmcDropletQc:
    gamma_eq: float | None
    gamma_sd: float | None
    gamma_se: float | None
    plateau_start_ms: float | None
    plateau_end_ms: float | None
    slope_mn_m_per_min: float | None
    point_count: int
    volume_start_ul: float | None
    volume_end_ul: float | None
    volume_loss_pct: float | None
    flags: list[str]
    used_for_aggregate: bool
    exclude_reason: str | None

    def to_payload(self) -> dict[str, Any]:
        return {
            "gammaEq": self.gamma_eq,
            "gammaSd": self.gamma_sd,
            "gammaSe": self.gamma_se,
            "plateauStartMs": self.plateau_start_ms,
            "plateauEndMs": self.plateau_end_ms,
            "slopeMnMPerMin": self.slope_mn_m_per_min,
            "pointCount": self.point_count,
            "volumeStartUL": self.volume_start_ul,
            "volumeEndUL": self.volume_end_ul,
            "volumeLossPct": self.volume_loss_pct,
            "flags": list(self.flags),
            "usedForAggregate": self.used_for_aggregate,
            "excludeReason": self.exclude_reason,
        }


@dataclass
class CmcConcentrationAggregate:
    gamma_mean: float | None
    gamma_median: float | None
    gamma_std: float | None
    gamma_se: float | None
    gamma_mad: float | None
    droplet_count: int
    used_droplet_count: int
    aggregation_method: str
    gamma_value: float | None
    error_value: float | None
    error_metric: str | None

    def to_payload(self) -> dict[str, Any]:
        return {
            "gammaMean": self.gamma_mean,
            "gammaMedian": self.gamma_median,
            "gammaStd": self.gamma_std,
            "gammaSe": self.gamma_se,
            "gammaMad": self.gamma_mad,
            "dropletCount": self.droplet_count,
            "usedDropletCount": self.used_droplet_count,
            "aggregationMethod": self.aggregation_method,
            "gammaValue": self.gamma_value,
            "errorValue": self.error_value,
            "errorMetric": self.error_metric,
        }


def normalize_cmc_qc_options(options: dict[str, Any] | None = None) -> dict[str, Any]:
    normalized = dict(DEFAULT_CMC_QC_OPTIONS)
    if options:
        normalized.update({key: value for key, value in options.items() if value is not None})

    mode = str(normalized.get("plateauMode", "manual")).strip().lower()
    normalized["plateauMode"] = mode if mode in ("manual", "auto") else "manual"

    method = str(normalized.get("aggregationMethod", "mean")).strip().lower()
    normalized["aggregationMethod"] = method if method in ("mean", "median") else "mean"

    model_value = normalized.get("model") if options and "model" in options else normalized.get("fitModel", "segmented_continuous")
    model = str(model_value).strip().lower()
    normalized["fitModel"] = model if model in ("none", "segmented_continuous", "segmented_flat_plateau") else "segmented_continuous"

    sample_type = str(normalized.get("sampleType", "unknown")).strip()
    normalized["sampleType"] = sample_type if sample_type in ("single", "mixture", "WSOM", "unknown") else "unknown"
    if sample_type.lower() == "wsom":
        normalized["sampleType"] = "WSOM"

    for key in (
        "minPlateauWindowMs",
        "maxAbsSlopeMnMPerMin",
        "maxPlateauSdMnM",
        "maxVolumeLossPct",
    ):
        try:
            normalized[key] = float(normalized[key])
        except (TypeError, ValueError):
            normalized[key] = DEFAULT_CMC_QC_OPTIONS[key]

    normalized["minPlateauWindowMs"] = max(0.0, float(normalized["minPlateauWindowMs"]))
    normalized["maxAbsSlopeMnMPerMin"] = max(0.0, float(normalized["maxAbsSlopeMnMPerMin"]))
    normalized["maxPlateauSdMnM"] = max(0.0, float(normalized["maxPlateauSdMnM"]))
    normalized["maxVolumeLossPct"] = max(0.0, float(normalized["maxVolumeLossPct"]))

    try:
        normalized["minPointsPerSegment"] = max(1, int(normalized["minPointsPerSegment"]))
    except (TypeError, ValueError):
        normalized["minPointsPerSegment"] = int(DEFAULT_CMC_QC_OPTIONS["minPointsPerSegment"])

    try:
        normalized["nBootstrap"] = max(0, int(normalized["nBootstrap"]))
    except (TypeError, ValueError):
        normalized["nBootstrap"] = int(DEFAULT_CMC_QC_OPTIONS["nBootstrap"])

    return normalized


@dataclass
class CmcDropletTrace:
    droplet_index: int
    source_column: str
    time: np.ndarray
    gamma: np.ndarray
    volume: np.ndarray | None
    density_delta_g_per_cm3: float | int | None = None

    @property
    def point_count(self) -> int:
        return int(self.gamma.size)

    @property
    def time_min(self) -> float | None:
        if self.time.size == 0:
            return None
        return float(np.nanmin(self.time))

    @property
    def time_max(self) -> float | None:
        if self.time.size == 0:
            return None
        return float(np.nanmax(self.time))

    @property
    def has_volume(self) -> bool:
        return self.volume is not None and bool(np.isfinite(self.volume).any())

    def mean_in_window(self, t_min: float, t_max: float) -> float | None:
        mask_t = (self.time >= t_min) & (self.time <= t_max)
        if not mask_t.any():
            return None
        return float(self.gamma[mask_t].mean())

    def to_payload(self) -> dict[str, Any]:
        return {
            "dropletIndex": self.droplet_index,
            "sourceColumn": self.source_column,
            "pointCount": self.point_count,
            "timeMin": self.time_min,
            "timeMax": self.time_max,
            "hasVolume": self.has_volume,
            "densityDeltaGPerCm3": self.density_delta_g_per_cm3,
        }


def infer_concentration_from_filename(filename: str) -> float | None:
    stem, _ = os.path.splitext(filename)
    lowered = stem.lower()

    zero_keywords = ("water", "h2o", "blank", "ultrapure")
    if any(keyword in lowered for keyword in zero_keywords):
        return 0.0

    match = re.search(r"(\d+(\.\d+)?)(\s*(mM|mm|M|uM|µM))?", stem, re.IGNORECASE)
    if not match:
        return None

    try:
        return float(match.group(1))
    except ValueError:
        return None


def guess_time_column(columns: Sequence[object]) -> object | None:
    candidates = (
        "時間(ms)",
        "时间(ms)",
        "Time (ms)",
        "時間 (ms)",
        "时间 (ms)",
        "time (ms)",
        "時間",
        "时间",
        "time",
    )

    for col in columns:
        if col in candidates:
            return col

    for col in columns:
        name = str(col).lower()
        if "time" in name or "時間" in name or "时间" in name:
            return col

    return None


def guess_gamma_column(columns: Sequence[object]) -> object | None:
    candidates = (
        "Avg",
        "Average",
        "Mean",
        "I.T.(mN/m)",
        "I.T. (mN/m)",
        "IT (mN/m)",
        "IT(mN/m)",
        "Surface tension (mN/m)",
        "γ(mN/m)",
        "Gamma (mN/m)",
    )

    for col in columns:
        if col in candidates:
            return col

    for col in columns:
        name = str(col).lower()
        if name in ("avg", "average", "mean"):
            return col
        if "i.t." in name or "mn/m" in name or "surface" in name:
            return col

    return None


def _is_famas_normalized_dataframe(
    df: pd.DataFrame,
    metadata: dict[str, Any] | None = None,
) -> bool:
    source_format = None
    if metadata is not None:
        source_format = metadata.get("sourceFormat")
    if source_format is None:
        source_format = df.attrs.get("sourceFormat")
    return source_format == "famas_multi_experiment_csv"


def _famas_trace_columns(columns: Sequence[object]) -> list[tuple[int, object]]:
    traces: list[tuple[int, object]] = []
    for col in columns:
        match = re.fullmatch(r"I\.T\.\(mN/m\)\.(\d+)", str(col))
        if match:
            traces.append((int(match.group(1)), col))
    return sorted(traces, key=lambda item: item[0])


def _metadata_density_delta(metadata: dict[str, Any] | None) -> float | int | None:
    if metadata is None:
        return None
    value = metadata.get("densityDeltaGPerCm3")
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(numeric):
        return None
    if numeric.is_integer():
        return int(numeric)
    return numeric


def _series_to_numeric_array(series: pd.Series) -> np.ndarray:
    return pd.to_numeric(series, errors="coerce").to_numpy(dtype=float)


def _build_trace(
    *,
    droplet_index: int,
    source_column: object,
    time_series: pd.Series,
    gamma_series: pd.Series,
    volume_series: pd.Series | None = None,
    density_delta_g_per_cm3: float | int | None = None,
) -> CmcDropletTrace | None:
    time_values = _series_to_numeric_array(time_series)
    gamma_values = _series_to_numeric_array(gamma_series)
    valid_mask = np.isfinite(time_values) & np.isfinite(gamma_values)
    if not valid_mask.any():
        return None

    volume_values = None
    if volume_series is not None:
        volume_array = _series_to_numeric_array(volume_series)
        volume_values = volume_array[valid_mask]

    return CmcDropletTrace(
        droplet_index=droplet_index,
        source_column=str(source_column),
        time=time_values[valid_mask],
        gamma=gamma_values[valid_mask],
        volume=volume_values,
        density_delta_g_per_cm3=density_delta_g_per_cm3,
    )


def _extract_famas_droplet_traces(
    df: pd.DataFrame,
    metadata: dict[str, Any] | None = None,
) -> list[CmcDropletTrace]:
    time_col = guess_time_column(df.columns)
    if time_col is None:
        return []

    density_delta = _metadata_density_delta(metadata or df.attrs.get("famasMetadata"))
    traces: list[CmcDropletTrace] = []
    for exp_index, gamma_col in _famas_trace_columns(df.columns):
        gamma_series = df[gamma_col]
        if pd.to_numeric(gamma_series, errors="coerce").notna().sum() == 0:
            continue

        volume_col = f"V(uL).{exp_index}"
        volume_series = df[volume_col] if volume_col in df.columns else None
        trace = _build_trace(
            droplet_index=len(traces) + 1,
            source_column=gamma_col,
            time_series=df[time_col],
            gamma_series=gamma_series,
            volume_series=volume_series,
            density_delta_g_per_cm3=density_delta,
        )
        if trace is not None:
            traces.append(trace)
    return traces


def _extract_time_reset_droplet_traces(
    df: pd.DataFrame,
    metadata: dict[str, Any] | None = None,
) -> list[CmcDropletTrace]:
    time_col = guess_time_column(df.columns)
    gamma_col = guess_gamma_column(df.columns)

    if time_col is None or gamma_col is None:
        raise DataProcessingError(
            "Cannot automatically detect time or surface tension columns."
        )

    time_series = pd.to_numeric(df[time_col], errors="coerce")
    gamma_series = pd.to_numeric(df[gamma_col], errors="coerce")

    valid_mask = time_series.notna() & gamma_series.notna()
    time = time_series[valid_mask].to_numpy(dtype=float)
    gamma = gamma_series[valid_mask].to_numpy(dtype=float)

    if time.size == 0:
        return []

    droplet_ids = np.zeros_like(time, dtype=int)
    current_id = 0
    for idx in range(1, len(time)):
        if time[idx] < time[idx - 1]:
            current_id += 1
        droplet_ids[idx] = current_id

    density_delta = _metadata_density_delta(metadata)
    traces: list[CmcDropletTrace] = []
    for droplet_id in range(current_id + 1):
        mask_d = droplet_ids == droplet_id
        if not mask_d.any():
            continue
        traces.append(
            CmcDropletTrace(
                droplet_index=len(traces) + 1,
                source_column=str(gamma_col),
                time=time[mask_d],
                gamma=gamma[mask_d],
                volume=None,
                density_delta_g_per_cm3=density_delta,
            )
        )

    return traces


def extract_cmc_droplet_traces(
    df: pd.DataFrame,
    metadata: dict[str, Any] | None = None,
) -> list[CmcDropletTrace]:
    if _is_famas_normalized_dataframe(df, metadata):
        traces = _extract_famas_droplet_traces(df, metadata)
        if traces:
            return traces
    return _extract_time_reset_droplet_traces(df, metadata)


def _append_flag(flags: list[str], flag: str) -> None:
    if flag not in flags:
        flags.append(flag)


def _finite_values(values: np.ndarray) -> np.ndarray:
    return values[np.isfinite(values)]


def _window_volume_values(trace: CmcDropletTrace, mask: np.ndarray) -> tuple[float | None, float | None, float | None]:
    if trace.volume is None:
        return None, None, None

    volumes = _finite_values(trace.volume[mask])
    if volumes.size == 0:
        return None, None, None

    start = float(volumes[0])
    end = float(volumes[-1])
    loss_pct = None
    if start > 0:
        loss_pct = float(max(0.0, (start - end) / start * 100.0))
    return start, end, loss_pct


def _fit_window_qc(
    trace: CmcDropletTrace,
    mask: np.ndarray,
    options: dict[str, Any],
) -> CmcDropletQc:
    time = trace.time[mask]
    gamma = trace.gamma[mask]
    point_count = int(gamma.size)

    if point_count == 0:
        return CmcDropletQc(
            gamma_eq=None,
            gamma_sd=None,
            gamma_se=None,
            plateau_start_ms=None,
            plateau_end_ms=None,
            slope_mn_m_per_min=None,
            point_count=0,
            volume_start_ul=None,
            volume_end_ul=None,
            volume_loss_pct=None,
            flags=[QC_NO_VALID_DATA],
            used_for_aggregate=False,
            exclude_reason=QC_NO_VALID_DATA,
        )

    gamma_eq = float(gamma.mean())
    gamma_sd = float(gamma.std(ddof=1)) if point_count > 1 else 0.0
    gamma_se = float(gamma_sd / np.sqrt(point_count)) if point_count > 0 else None

    slope = 0.0
    if point_count > 1 and float(np.nanmax(time) - np.nanmin(time)) > 0:
        time_min = time / 60000.0
        slope = float(np.polyfit(time_min, gamma, 1)[0])

    volume_start, volume_end, volume_loss = _window_volume_values(trace, mask)
    flags: list[str] = []
    if abs(slope) > float(options["maxAbsSlopeMnMPerMin"]):
        _append_flag(flags, QC_HIGH_FINAL_DRIFT)
    if gamma_sd > float(options["maxPlateauSdMnM"]):
        _append_flag(flags, QC_HIGH_NOISE)
    if volume_loss is not None and volume_loss > float(options["maxVolumeLossPct"]):
        _append_flag(flags, QC_HIGH_VOLUME_LOSS)

    return CmcDropletQc(
        gamma_eq=gamma_eq,
        gamma_sd=gamma_sd,
        gamma_se=gamma_se,
        plateau_start_ms=float(np.nanmin(time)),
        plateau_end_ms=float(np.nanmax(time)),
        slope_mn_m_per_min=slope,
        point_count=point_count,
        volume_start_ul=volume_start,
        volume_end_ul=volume_end,
        volume_loss_pct=volume_loss,
        flags=flags,
        used_for_aggregate=True,
        exclude_reason=None,
    )


def compute_droplet_plateau_qc(
    trace: CmcDropletTrace,
    *,
    mode: str = "manual",
    t_min: float | None = None,
    t_max: float | None = None,
    options: dict[str, Any] | None = None,
) -> CmcDropletQc:
    qc_options = normalize_cmc_qc_options(options)
    mode = str(mode or qc_options["plateauMode"]).strip().lower()

    valid_mask = np.isfinite(trace.time) & np.isfinite(trace.gamma)
    if not valid_mask.any():
        return CmcDropletQc(
            gamma_eq=None,
            gamma_sd=None,
            gamma_se=None,
            plateau_start_ms=None,
            plateau_end_ms=None,
            slope_mn_m_per_min=None,
            point_count=0,
            volume_start_ul=None,
            volume_end_ul=None,
            volume_loss_pct=None,
            flags=[QC_NO_VALID_DATA],
            used_for_aggregate=False,
            exclude_reason=QC_NO_VALID_DATA,
        )

    if mode == "manual":
        if t_min is None or t_max is None:
            raise DataProcessingError("Manual plateau mode requires t_min and t_max.")
        mask = valid_mask & (trace.time >= t_min) & (trace.time <= t_max)
        qc = _fit_window_qc(trace, mask, qc_options)
        if qc.point_count == 0:
            qc.flags = [QC_NO_VALID_DATA]
            qc.exclude_reason = QC_NO_VALID_DATA
            qc.used_for_aggregate = False
        return qc

    min_window_ms = float(qc_options["minPlateauWindowMs"])
    valid_indexes = np.flatnonzero(valid_mask)
    candidates: list[tuple[float, float, int, CmcDropletQc]] = []

    for start_pos, start_idx in enumerate(valid_indexes):
        for end_idx in valid_indexes[start_pos + 1 :]:
            duration = float(trace.time[end_idx] - trace.time[start_idx])
            if duration < min_window_ms:
                continue
            mask = np.zeros_like(valid_mask, dtype=bool)
            mask[start_idx : end_idx + 1] = valid_mask[start_idx : end_idx + 1]
            qc = _fit_window_qc(trace, mask, qc_options)
            if qc.point_count < 2:
                continue

            slope_score = abs(qc.slope_mn_m_per_min or 0.0) / max(float(qc_options["maxAbsSlopeMnMPerMin"]), 1e-9)
            noise_score = (qc.gamma_sd or 0.0) / max(float(qc_options["maxPlateauSdMnM"]), 1e-9)
            end_score = -float(qc.plateau_end_ms or 0.0) / 1_000_000.0
            width_score = -duration / 10_000_000.0
            score = slope_score * 2.0 + noise_score + end_score + width_score
            candidates.append((score, -float(qc.plateau_end_ms or 0.0), -qc.point_count, qc))

    if not candidates:
        return CmcDropletQc(
            gamma_eq=None,
            gamma_sd=None,
            gamma_se=None,
            plateau_start_ms=None,
            plateau_end_ms=None,
            slope_mn_m_per_min=None,
            point_count=0,
            volume_start_ul=None,
            volume_end_ul=None,
            volume_loss_pct=None,
            flags=[QC_NO_PLATEAU],
            used_for_aggregate=False,
            exclude_reason=QC_NO_PLATEAU,
        )

    candidates.sort(key=lambda item: (item[0], item[1], item[2]))
    return candidates[0][3]


def mark_outliers_within_concentration(qc_results: Sequence[CmcDropletQc]) -> None:
    used_values = np.asarray(
        [
            qc.gamma_eq
            for qc in qc_results
            if qc.used_for_aggregate and qc.gamma_eq is not None and np.isfinite(qc.gamma_eq)
        ],
        dtype=float,
    )
    if used_values.size < 3:
        return

    median = float(np.median(used_values))
    mad = float(np.median(np.abs(used_values - median)))
    if mad > 0:
        threshold = 3.5 * 1.4826 * mad
    else:
        std = float(used_values.std(ddof=1)) if used_values.size > 1 else 0.0
        threshold = 3.0 * std

    if threshold <= 0:
        return

    for qc in qc_results:
        if qc.gamma_eq is None or not np.isfinite(qc.gamma_eq):
            continue
        if abs(float(qc.gamma_eq) - median) > threshold:
            _append_flag(qc.flags, QC_OUTLIER_WITHIN_CONCENTRATION)


def aggregate_cmc_qc_results(
    qc_results: Sequence[CmcDropletQc],
    *,
    aggregation_method: str = "mean",
) -> CmcConcentrationAggregate:
    values = np.asarray(
        [
            qc.gamma_eq
            for qc in qc_results
            if qc.used_for_aggregate and qc.gamma_eq is not None and np.isfinite(qc.gamma_eq)
        ],
        dtype=float,
    )
    method = aggregation_method if aggregation_method in ("mean", "median") else "mean"
    droplet_count = len(qc_results)
    used_count = int(values.size)
    if used_count == 0:
        raise DataProcessingError("No valid droplet data in the requested time range.")

    gamma_mean = float(values.mean())
    gamma_median = float(np.median(values))
    gamma_std = float(values.std(ddof=1)) if used_count > 1 else 0.0
    gamma_se = float(gamma_std / np.sqrt(used_count)) if used_count > 0 else None
    gamma_mad = float(np.median(np.abs(values - gamma_median)))
    gamma_value = gamma_median if method == "median" else gamma_mean

    error_value = gamma_se if gamma_se is not None else gamma_std
    error_metric = "gammaSe" if gamma_se is not None else "gammaStd"

    return CmcConcentrationAggregate(
        gamma_mean=gamma_mean,
        gamma_median=gamma_median,
        gamma_std=gamma_std,
        gamma_se=gamma_se,
        gamma_mad=gamma_mad,
        droplet_count=droplet_count,
        used_droplet_count=used_count,
        aggregation_method=method,
        gamma_value=gamma_value,
        error_value=error_value,
        error_metric=error_metric,
    )


def _fit_warning_payload(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _sample_transition_label(sample_type: str) -> str:
    if sample_type == "single":
        return "CMC"
    if sample_type == "mixture":
        return "apparent CMC/CAC"
    if sample_type == "WSOM":
        return "apparent CMC/CAC"
    return "transition concentration"


def _model_label(model_key: str) -> str:
    if model_key == "segmented_flat_plateau":
        return "Segmented linear + plateau"
    return "Segmented continuous regression"


def _coerce_point_value(point: dict[str, Any], keys: Sequence[str]) -> float | None:
    for key in keys:
        value = point.get(key)
        if value is None:
            continue
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        if np.isfinite(numeric):
            return numeric
    return None


def _prepare_fit_points(points: Sequence[dict[str, Any]]) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[int], list[dict[str, str]]]:
    x_values: list[float] = []
    y_values: list[float] = []
    errors: list[float] = []
    used_indexes: list[int] = []
    warnings: list[dict[str, str]] = []
    skipped_nonpositive = False

    for idx, point in enumerate(points):
        concentration = _coerce_point_value(point, ("concentration", "C", "c"))
        y_value = _coerce_point_value(point, ("gammaValue", "gammaMean", "y"))
        if concentration is None or y_value is None:
            continue
        if concentration <= 0:
            skipped_nonpositive = True
            continue

        error = _coerce_point_value(point, ("gammaError", "error", "gammaSe", "gammaStd"))
        if error is None or error <= 0:
            error = 1.0

        x_values.append(float(np.log10(concentration)))
        y_values.append(y_value)
        errors.append(error)
        used_indexes.append(idx)

    if skipped_nonpositive:
        warnings.append(_fit_warning_payload(
            FIT_LOG_REQUIRES_POSITIVE,
            "Non-positive concentration points were kept for display but excluded from log10(C) fitting.",
        ))

    return (
        np.asarray(x_values, dtype=float),
        np.asarray(y_values, dtype=float),
        np.asarray(errors, dtype=float),
        used_indexes,
        warnings,
    )


def _safe_weights(errors: np.ndarray) -> np.ndarray:
    finite_positive = errors[np.isfinite(errors) & (errors > 0)]
    floor = float(np.median(finite_positive)) * 0.05 if finite_positive.size else 1.0
    floor = max(floor, 1e-6)
    safe_errors = np.where(np.isfinite(errors) & (errors > floor), errors, floor)
    return 1.0 / np.square(safe_errors)


def _weighted_lstsq(design: np.ndarray, y: np.ndarray, weights: np.ndarray) -> tuple[np.ndarray, float, np.ndarray]:
    sqrt_w = np.sqrt(weights)
    weighted_design = design * sqrt_w[:, None]
    weighted_y = y * sqrt_w
    params, *_ = np.linalg.lstsq(weighted_design, weighted_y, rcond=None)
    y_hat = design @ params
    rss = float(np.sum(weights * np.square(y - y_hat)))
    return params, rss, y_hat


def _candidate_breakpoints(x: np.ndarray, min_points_per_segment: int) -> np.ndarray:
    unique_x = np.unique(np.sort(x))
    if unique_x.size < 2:
        return np.asarray([], dtype=float)

    mids = (unique_x[:-1] + unique_x[1:]) / 2.0
    candidates = [
        float(mid)
        for mid in mids
        if int(np.sum(x <= mid)) >= min_points_per_segment
        and int(np.sum(x > mid)) >= min_points_per_segment
    ]
    return np.asarray(candidates, dtype=float)


def _predict_segmented_continuous(params: np.ndarray, x: np.ndarray, x0: float) -> np.ndarray:
    return params[0] + params[1] * x + params[2] * np.maximum(0.0, x - x0)


def _predict_segmented_flat(params: np.ndarray, x: np.ndarray, x0: float) -> np.ndarray:
    return params[0] + params[1] * np.minimum(x, x0)


def _fit_segmented_model(
    x: np.ndarray,
    y: np.ndarray,
    errors: np.ndarray,
    *,
    model_key: str,
    min_points_per_segment: int,
) -> dict[str, Any] | None:
    order = np.argsort(x)
    x = x[order]
    y = y[order]
    errors = errors[order]
    weights = _safe_weights(errors)
    candidates = _candidate_breakpoints(x, min_points_per_segment)
    if candidates.size == 0:
        return None

    best: dict[str, Any] | None = None
    for x0 in candidates:
        if model_key == "segmented_flat_plateau":
            design = np.column_stack([np.ones_like(x), np.minimum(x, x0)])
            predict = _predict_segmented_flat
        else:
            design = np.column_stack([np.ones_like(x), x, np.maximum(0.0, x - x0)])
            predict = _predict_segmented_continuous

        params, rss, y_hat = _weighted_lstsq(design, y, weights)
        result = {
            "x0": float(x0),
            "params": params,
            "rss": rss,
            "yHat": y_hat,
            "xSorted": x,
            "ySorted": y,
            "errorsSorted": errors,
            "order": order,
            "predict": predict,
            "candidateIndex": int(np.where(candidates == x0)[0][0]),
            "candidateCount": int(candidates.size),
        }
        if best is None or rss < float(best["rss"]):
            best = result

    return best


def _fit_result_for_bootstrap(
    x: np.ndarray,
    y: np.ndarray,
    errors: np.ndarray,
    *,
    model_key: str,
    min_points_per_segment: int,
) -> float | None:
    try:
        result = _fit_segmented_model(
            x,
            y,
            errors,
            model_key=model_key,
            min_points_per_segment=min_points_per_segment,
        )
    except (np.linalg.LinAlgError, ValueError):
        return None
    if result is None:
        return None
    return float(result["x0"])


def _bootstrap_cmc_interval(
    x: np.ndarray,
    y: np.ndarray,
    errors: np.ndarray,
    *,
    model_key: str,
    min_points_per_segment: int,
    n_bootstrap: int,
) -> tuple[float | None, float | None, str | None]:
    if n_bootstrap <= 0:
        return None, None, None
    try:
        rng = np.random.default_rng(1729)
        estimates: list[float] = []
        n = len(x)
        for _ in range(n_bootstrap):
            indexes = rng.integers(0, n, size=n)
            estimate = _fit_result_for_bootstrap(
                x[indexes],
                y[indexes],
                errors[indexes],
                model_key=model_key,
                min_points_per_segment=min_points_per_segment,
            )
            if estimate is not None and np.isfinite(estimate):
                estimates.append(estimate)
        if len(estimates) < max(20, int(n_bootstrap * 0.2)):
            return None, None, "Bootstrap produced too few valid breakpoint estimates."
        arr = np.asarray(estimates, dtype=float)
        return float(10 ** np.percentile(arr, 2.5)), float(10 ** np.percentile(arr, 97.5)), None
    except Exception as exc:  # pragma: no cover - defensive browser runtime guard
        return None, None, f"Bootstrap failed: {exc}"


def _fit_series_payload(result: dict[str, Any], *, plot_use_log: bool) -> list[dict[str, Any]]:
    x_sorted = result["xSorted"]
    x_grid = np.linspace(float(x_sorted.min()), float(x_sorted.max()), 160)
    y_grid = result["predict"](result["params"], x_grid, float(result["x0"]))
    return [
        {
            "name": result.get("seriesName", "CMC fit"),
            "x": (x_grid if plot_use_log else np.power(10.0, x_grid)).tolist(),
            "y": y_grid.tolist(),
        }
    ]


def _scientific_fit_warnings(result: dict[str, Any], warnings: list[dict[str, str]]) -> None:
    x0 = float(result["x0"])
    params = result["params"]
    x_sorted = result["xSorted"]
    y_sorted = result["ySorted"]
    y_hat = result["yHat"]
    errors = result["errorsSorted"]
    candidate_index = int(result["candidateIndex"])
    candidate_count = int(result["candidateCount"])
    model_key = str(result["modelKey"])

    if candidate_index == 0 or candidate_index == candidate_count - 1:
        warnings.append(_fit_warning_payload(
            FIT_BREAKPOINT_AT_BOUNDARY,
            "Best breakpoint is at the edge of the searchable range.",
        ))

    if model_key == "segmented_continuous":
        pre_slope = float(params[1])
        post_slope = float(params[1] + params[2])
    else:
        pre_slope = float(params[1])
        post_slope = 0.0

    if abs(post_slope) > max(0.25, abs(pre_slope) * 0.25):
        warnings.append(_fit_warning_payload(
            FIT_HIGH_POST_CMC_SLOPE,
            "Post-transition segment still has substantial slope.",
        ))
    if model_key == "segmented_continuous" and abs(post_slope) > abs(pre_slope) * 0.5:
        warnings.append(_fit_warning_payload(
            FIT_NO_CLEAR_PLATEAU,
            "The fitted post-transition region is not clearly flatter than the pre-transition trend.",
        ))

    diffs = np.diff(y_sorted)
    if diffs.size and np.nanmax(diffs) > max(0.75, float(np.nanmedian(errors)) * 3.0):
        warnings.append(_fit_warning_payload(
            FIT_NON_MONOTONIC_OR_DIP,
            "Surface tension is not monotonic across the fitted concentration series.",
        ))

    residuals = y_sorted - y_hat
    if residuals.size >= 4:
        median_abs_error = float(np.median(np.abs(residuals)))
        if median_abs_error > 0 and float(np.max(np.abs(residuals))) > 4.0 * median_abs_error:
            warnings.append(_fit_warning_payload(
                FIT_HIGH_OUTLIER_INFLUENCE,
                "One concentration point has unusually large influence on the segmented fit.",
            ))


def fit_cmc_curve(points: Sequence[dict[str, Any]], options: dict[str, Any] | None = None) -> dict[str, Any]:
    fit_options = normalize_cmc_qc_options(options)
    model_key = str(fit_options["fitModel"])
    sample_type = str(fit_options["sampleType"])
    min_points_per_segment = int(fit_options["minPointsPerSegment"])
    n_bootstrap = int(fit_options["nBootstrap"])
    plot_use_log = bool((options or {}).get("plotUseLog", False))
    label = _sample_transition_label(sample_type)

    x, y, errors, used_indexes, warnings = _prepare_fit_points(points)
    min_required = max(2 * min_points_per_segment, 4)

    base = {
        "modelKey": model_key,
        "modelLabel": _model_label(model_key),
        "equationText": "",
        "xScale": "log10C",
        "cmc": None,
        "cmcLog10": None,
        "gammaAtCmc": None,
        "ciLow": None,
        "ciHigh": None,
        "parameters": {},
        "fitSeries": [],
        "cmcMarker": None,
        "residuals": [],
        "usedPointIndexes": used_indexes,
        "warnings": warnings,
    }

    if len(used_indexes) < min_required or np.unique(x).size < min_required:
        base["warnings"].append(_fit_warning_payload(
            FIT_NOT_ENOUGH_CONCENTRATIONS,
            f"At least {min_required} positive concentration points are required for segmented fitting.",
        ))
        return base

    result = _fit_segmented_model(
        x,
        y,
        errors,
        model_key=model_key,
        min_points_per_segment=min_points_per_segment,
    )
    if result is None:
        base["warnings"].append(_fit_warning_payload(
            FIT_NOT_ENOUGH_CONCENTRATIONS,
            "Not enough points were available on both sides of a candidate breakpoint.",
        ))
        return base

    result["modelKey"] = model_key
    result["seriesName"] = f"{label} fit"
    x0 = float(result["x0"])
    cmc = float(10 ** x0)
    gamma_at_cmc = float(result["predict"](result["params"], np.asarray([x0]), x0)[0])
    ci_low, ci_high, bootstrap_warning = _bootstrap_cmc_interval(
        x,
        y,
        errors,
        model_key=model_key,
        min_points_per_segment=min_points_per_segment,
        n_bootstrap=n_bootstrap,
    )
    if bootstrap_warning:
        warnings.append(_fit_warning_payload("BOOTSTRAP_FAILED", bootstrap_warning))

    _scientific_fit_warnings(result, warnings)

    if model_key == "segmented_flat_plateau":
        equation = "γ = a + b·min(log10(C), x0)"
        parameters = {
            "a": float(result["params"][0]),
            "b": float(result["params"][1]),
            "plateauGamma": gamma_at_cmc,
        }
    else:
        equation = "γ = a + b1·log10(C) + b2·max(0, log10(C)-x0)"
        parameters = {
            "a": float(result["params"][0]),
            "b1": float(result["params"][1]),
            "b2": float(result["params"][2]),
            "postSlope": float(result["params"][1] + result["params"][2]),
        }

    residuals = [
        {
            "pointIndex": used_indexes[int(result["order"][idx])],
            "x": float(result["xSorted"][idx]),
            "y": float(result["ySorted"][idx]),
            "fitted": float(result["yHat"][idx]),
            "residual": float(result["ySorted"][idx] - result["yHat"][idx]),
        }
        for idx in range(len(result["xSorted"]))
    ]

    base.update({
        "equationText": f"{label}: {equation}",
        "cmc": cmc,
        "cmcLog10": x0,
        "gammaAtCmc": gamma_at_cmc,
        "ciLow": ci_low,
        "ciHigh": ci_high,
        "parameters": {
            **parameters,
            "x0": x0,
            "rss": float(result["rss"]),
            "sampleType": sample_type,
            "transitionLabel": label,
        },
        "fitSeries": _fit_series_payload(result, plot_use_log=plot_use_log),
        "cmcMarker": {
            "x": x0 if plot_use_log else cmc,
            "y": gamma_at_cmc,
            "label": label,
        },
        "residuals": residuals,
        "warnings": warnings,
    })
    return base


def compute_droplet_means(df: pd.DataFrame, t_min: float, t_max: float) -> list[float]:
    droplet_means: list[float] = []
    for trace in extract_cmc_droplet_traces(df):
        mean = trace.mean_in_window(t_min, t_max)
        if mean is None:
            continue
        droplet_means.append(mean)

    return droplet_means


def summarize_droplet_means(droplet_means: Sequence[float]) -> tuple[float, float]:
    arr = np.asarray(droplet_means, dtype=float)
    if arr.size == 0:
        raise DataProcessingError("No valid droplet data in the requested time range.")

    mean = float(arr.mean())
    std = float(arr.std(ddof=1)) if arr.size > 1 else 0.0
    return mean, std
