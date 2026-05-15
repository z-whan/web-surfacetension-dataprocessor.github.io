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
}


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
