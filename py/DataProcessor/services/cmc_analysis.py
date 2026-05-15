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
QC_HIGH_EVAPORATION = "HIGH_EVAPORATION"
QC_OUTLIER_WITHIN_CONCENTRATION = "OUTLIER_WITHIN_CONCENTRATION"
QC_NO_VOLUME_DATA = "NO_VOLUME_DATA"
QC_LOW_POINT_COUNT = "LOW_POINT_COUNT"

QC_FAIL_FLAGS = {
    QC_NO_VALID_DATA,
    QC_NO_PLATEAU,
    QC_HIGH_FINAL_DRIFT,
    QC_HIGH_NOISE,
    QC_HIGH_VOLUME_LOSS,
    QC_HIGH_EVAPORATION,
    QC_OUTLIER_WITHIN_CONCENTRATION,
}

DEFAULT_CMC_QC_OPTIONS: dict[str, Any] = {
    "plateauMode": "manual",
    "minPlateauWindowMs": 5000.0,
    "plateauSearchStrideMs": 5000.0,
    "autoSearchTailFraction": 0.7,
    "maxAbsSlopeMnMPerMin": 0.5,
    "maxPlateauSdMnM": 0.5,
    "maxVolumeLossPct": 5.0,
    "maxEvaporationRatePctPerMin": 0.5,
    "aggregationMethod": "mean",
    "fitModel": "surface_tension_cmc",
    "sampleType": "unknown",
    "minPointsPerSegment": 2,
    "minPrePoints": 3,
    "minPostPoints": 3,
    "nBootstrap": 80,
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
    full_volume_start_ul: float | None = None
    full_volume_end_ul: float | None = None
    full_volume_loss_pct: float | None = None
    full_volume_duration_min: float | None = None
    full_evaporation_rate_pct_per_min: float | None = None
    plateau_volume_start_ul: float | None = None
    plateau_volume_end_ul: float | None = None
    plateau_volume_loss_pct: float | None = None

    def to_payload(self) -> dict[str, Any]:
        plateau_start = self.plateau_volume_start_ul
        plateau_end = self.plateau_volume_end_ul
        plateau_loss = self.plateau_volume_loss_pct
        if plateau_start is None:
            plateau_start = self.volume_start_ul
        if plateau_end is None:
            plateau_end = self.volume_end_ul
        if plateau_loss is None:
            plateau_loss = self.volume_loss_pct
        return {
            "gammaEq": self.gamma_eq,
            "gammaSd": self.gamma_sd,
            "gammaSe": self.gamma_se,
            "plateauStartMs": self.plateau_start_ms,
            "plateauEndMs": self.plateau_end_ms,
            "slopeMnMPerMin": self.slope_mn_m_per_min,
            "pointCount": self.point_count,
            "volumeStartUL": plateau_start,
            "volumeEndUL": plateau_end,
            "volumeLossPct": plateau_loss,
            "fullVolumeStartUL": self.full_volume_start_ul,
            "fullVolumeEndUL": self.full_volume_end_ul,
            "fullVolumeLossPct": self.full_volume_loss_pct,
            "fullVolumeDurationMin": self.full_volume_duration_min,
            "fullEvaporationRatePctPerMin": self.full_evaporation_rate_pct_per_min,
            "plateauVolumeStartUL": plateau_start,
            "plateauVolumeEndUL": plateau_end,
            "plateauVolumeLossPct": plateau_loss,
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
            "sigmaMean": self.gamma_mean,
            "sigmaMedian": self.gamma_median,
            "sigmaStd": self.gamma_std,
            "sigmaSe": self.gamma_se,
            "sigmaMad": self.gamma_mad,
            "dropletCount": self.droplet_count,
            "usedDropletCount": self.used_droplet_count,
            "aggregationMethod": self.aggregation_method,
            "gammaValue": self.gamma_value,
            "sigmaValue": self.gamma_value,
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

    model_value = normalized.get("model") if options and "model" in options else normalized.get("fitModel", "surface_tension_cmc")
    model = str(model_value).strip().lower()
    normalized["fitModel"] = model if model in (
        "none",
        "surface_tension_cmc",
        "segmented_continuous",
        "segmented_flat_plateau",
    ) else "surface_tension_cmc"

    sample_type = str(normalized.get("sampleType", "unknown")).strip()
    normalized["sampleType"] = sample_type if sample_type in ("single", "mixture", "WSOM", "unknown") else "unknown"
    if sample_type.lower() == "wsom":
        normalized["sampleType"] = "WSOM"

    for key in (
        "minPlateauWindowMs",
        "plateauSearchStrideMs",
        "autoSearchTailFraction",
        "maxAbsSlopeMnMPerMin",
        "maxPlateauSdMnM",
        "maxVolumeLossPct",
        "maxEvaporationRatePctPerMin",
    ):
        try:
            normalized[key] = float(normalized[key])
        except (TypeError, ValueError):
            normalized[key] = DEFAULT_CMC_QC_OPTIONS[key]

    normalized["minPlateauWindowMs"] = max(0.0, float(normalized["minPlateauWindowMs"]))
    normalized["plateauSearchStrideMs"] = max(1.0, float(normalized["plateauSearchStrideMs"]))
    normalized["autoSearchTailFraction"] = min(1.0, max(0.0, float(normalized["autoSearchTailFraction"])))
    normalized["maxAbsSlopeMnMPerMin"] = max(0.0, float(normalized["maxAbsSlopeMnMPerMin"]))
    normalized["maxPlateauSdMnM"] = max(0.0, float(normalized["maxPlateauSdMnM"]))
    normalized["maxVolumeLossPct"] = max(0.0, float(normalized["maxVolumeLossPct"]))
    normalized["maxEvaporationRatePctPerMin"] = max(0.0, float(normalized["maxEvaporationRatePctPerMin"]))

    try:
        normalized["minPointsPerSegment"] = max(1, int(normalized["minPointsPerSegment"]))
    except (TypeError, ValueError):
        normalized["minPointsPerSegment"] = int(DEFAULT_CMC_QC_OPTIONS["minPointsPerSegment"])

    for key in ("minPrePoints", "minPostPoints"):
        try:
            normalized[key] = max(1, int(normalized[key]))
        except (TypeError, ValueError):
            normalized[key] = int(DEFAULT_CMC_QC_OPTIONS[key])

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


def _surface_tension_trace_is_valid(values: np.ndarray, total_count: int | None = None) -> bool:
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return False

    denominator = int(total_count if total_count is not None else values.size)
    min_required = max(2, min(5, int(denominator * 0.2)))
    if finite.size < min_required:
        return False
    if int(np.count_nonzero(np.abs(finite) > 1e-12)) == 0:
        return False

    plausible = finite[(finite >= 1.0) & (finite <= 200.0)]
    return plausible.size >= min_required


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
        gamma_values = _series_to_numeric_array(gamma_series)
        if not _surface_tension_trace_is_valid(gamma_values, len(gamma_series)):
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


def _volume_loss_pct(start: float | None, end: float | None) -> float | None:
    if start is None or end is None or start <= 0:
        return None
    return float(max(0.0, (start - end) / start * 100.0))


def _volume_values_for_mask(
    trace: CmcDropletTrace,
    mask: np.ndarray,
) -> tuple[float | None, float | None, float | None]:
    if trace.volume is None:
        return None, None, None

    volumes = _finite_values(trace.volume[mask])
    if volumes.size == 0:
        return None, None, None

    start = float(volumes[0])
    end = float(volumes[-1])
    loss_pct = _volume_loss_pct(start, end)
    return start, end, loss_pct


def _full_volume_metrics(trace: CmcDropletTrace) -> dict[str, float | None]:
    metrics: dict[str, float | None] = {
        "start": None,
        "end": None,
        "lossPct": None,
        "durationMin": None,
        "evaporationRatePctPerMin": None,
    }
    if trace.volume is None:
        return metrics

    mask = np.isfinite(trace.volume) & np.isfinite(trace.time)
    if not mask.any():
        return metrics

    volumes = trace.volume[mask].astype(float)
    times = trace.time[mask].astype(float)
    start = float(volumes[0])
    end = float(volumes[-1])
    duration_min = float(max(0.0, (times[-1] - times[0]) / 60000.0))
    loss_pct = _volume_loss_pct(start, end)
    evaporation_rate = None
    if loss_pct is not None and duration_min > 0:
        evaporation_rate = float(loss_pct / duration_min)

    metrics.update({
        "start": start,
        "end": end,
        "lossPct": loss_pct,
        "durationMin": duration_min,
        "evaporationRatePctPerMin": evaporation_rate,
    })
    return metrics


def _first_fail_flag(flags: Sequence[str]) -> str | None:
    for flag in flags:
        if flag in QC_FAIL_FLAGS:
            return flag
    return None


def _finalize_qc_usage(qc: CmcDropletQc) -> CmcDropletQc:
    reason = _first_fail_flag(qc.flags)
    qc.used_for_aggregate = reason is None
    qc.exclude_reason = reason
    return qc


def _empty_qc(flag: str, trace: CmcDropletTrace | None = None) -> CmcDropletQc:
    full_metrics = _full_volume_metrics(trace) if trace is not None else {
        "start": None,
        "end": None,
        "lossPct": None,
        "durationMin": None,
        "evaporationRatePctPerMin": None,
    }
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
        flags=[flag],
        used_for_aggregate=False,
        exclude_reason=flag,
        full_volume_start_ul=full_metrics["start"],
        full_volume_end_ul=full_metrics["end"],
        full_volume_loss_pct=full_metrics["lossPct"],
        full_volume_duration_min=full_metrics["durationMin"],
        full_evaporation_rate_pct_per_min=full_metrics["evaporationRatePctPerMin"],
        plateau_volume_start_ul=None,
        plateau_volume_end_ul=None,
        plateau_volume_loss_pct=None,
    )


def _fit_window_qc(
    trace: CmcDropletTrace,
    mask: np.ndarray,
    options: dict[str, Any],
) -> CmcDropletQc:
    time = trace.time[mask]
    gamma = trace.gamma[mask]
    point_count = int(gamma.size)

    if point_count == 0:
        return _empty_qc(QC_NO_VALID_DATA, trace)

    gamma_eq = float(gamma.mean())
    gamma_sd = float(gamma.std(ddof=1)) if point_count > 1 else 0.0
    gamma_se = float(gamma_sd / np.sqrt(point_count)) if point_count > 0 else None

    slope = 0.0
    if point_count > 1 and float(np.nanmax(time) - np.nanmin(time)) > 0:
        time_min = time / 60000.0
        slope = float(np.polyfit(time_min, gamma, 1)[0])

    plateau_volume_start, plateau_volume_end, plateau_volume_loss = _volume_values_for_mask(trace, mask)
    full_metrics = _full_volume_metrics(trace)
    flags: list[str] = []
    if point_count < 3:
        _append_flag(flags, QC_LOW_POINT_COUNT)
    if abs(slope) > float(options["maxAbsSlopeMnMPerMin"]):
        _append_flag(flags, QC_HIGH_FINAL_DRIFT)
    if gamma_sd > float(options["maxPlateauSdMnM"]):
        _append_flag(flags, QC_HIGH_NOISE)
    if full_metrics["lossPct"] is None:
        _append_flag(flags, QC_NO_VOLUME_DATA)
    elif full_metrics["lossPct"] > float(options["maxVolumeLossPct"]):
        _append_flag(flags, QC_HIGH_VOLUME_LOSS)
    if (
        full_metrics["evaporationRatePctPerMin"] is not None
        and full_metrics["evaporationRatePctPerMin"] > float(options["maxEvaporationRatePctPerMin"])
    ):
        _append_flag(flags, QC_HIGH_EVAPORATION)

    qc = CmcDropletQc(
        gamma_eq=gamma_eq,
        gamma_sd=gamma_sd,
        gamma_se=gamma_se,
        plateau_start_ms=float(np.nanmin(time)),
        plateau_end_ms=float(np.nanmax(time)),
        slope_mn_m_per_min=slope,
        point_count=point_count,
        volume_start_ul=plateau_volume_start,
        volume_end_ul=plateau_volume_end,
        volume_loss_pct=plateau_volume_loss,
        flags=flags,
        used_for_aggregate=True,
        exclude_reason=None,
        full_volume_start_ul=full_metrics["start"],
        full_volume_end_ul=full_metrics["end"],
        full_volume_loss_pct=full_metrics["lossPct"],
        full_volume_duration_min=full_metrics["durationMin"],
        full_evaporation_rate_pct_per_min=full_metrics["evaporationRatePctPerMin"],
        plateau_volume_start_ul=plateau_volume_start,
        plateau_volume_end_ul=plateau_volume_end,
        plateau_volume_loss_pct=plateau_volume_loss,
    )
    return _finalize_qc_usage(qc)


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
        return _empty_qc(QC_NO_VALID_DATA, trace)

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

    min_window_ms = max(1.0, float(qc_options["minPlateauWindowMs"]))
    stride_ms = max(1.0, float(qc_options["plateauSearchStrideMs"]))
    tail_fraction = float(qc_options["autoSearchTailFraction"])

    time_values = trace.time[valid_mask].astype(float)
    gamma_values = trace.gamma[valid_mask].astype(float)
    order = np.argsort(time_values)
    time_values = time_values[order]
    gamma_values = gamma_values[order]
    if time_values.size < 2:
        return _empty_qc(QC_NO_PLATEAU, trace)

    t_start = float(time_values[0])
    t_end = float(time_values[-1])
    total_duration = t_end - t_start
    if total_duration < min_window_ms:
        return _empty_qc(QC_NO_PLATEAU, trace)

    x_min = time_values / 60000.0
    prefixes = {
        "x": np.concatenate(([0.0], np.cumsum(x_min))),
        "y": np.concatenate(([0.0], np.cumsum(gamma_values))),
        "x2": np.concatenate(([0.0], np.cumsum(np.square(x_min)))),
        "y2": np.concatenate(([0.0], np.cumsum(np.square(gamma_values)))),
        "xy": np.concatenate(([0.0], np.cumsum(x_min * gamma_values))),
    }

    def stats(left: int, right: int) -> dict[str, float | int] | None:
        n = right - left
        if n < 2:
            return None
        sx = float(prefixes["x"][right] - prefixes["x"][left])
        sy = float(prefixes["y"][right] - prefixes["y"][left])
        sx2 = float(prefixes["x2"][right] - prefixes["x2"][left])
        sy2 = float(prefixes["y2"][right] - prefixes["y2"][left])
        sxy = float(prefixes["xy"][right] - prefixes["xy"][left])
        mean = sy / n
        variance = max(0.0, (sy2 - sy * sy / n) / max(1, n - 1))
        denom = n * sx2 - sx * sx
        slope = 0.0 if abs(denom) <= 1e-12 else float((n * sxy - sx * sy) / denom)
        return {
            "count": n,
            "mean": mean,
            "sd": float(np.sqrt(variance)),
            "slope": slope,
        }

    search_start = t_start + total_duration * (1.0 - tail_fraction)
    latest_start = t_end - min_window_ms
    start_values = np.arange(search_start, latest_start + stride_ms * 0.5, stride_ms)
    start_values = np.unique(np.concatenate((start_values, [search_start, latest_start])))
    window_lengths = np.unique(np.asarray([
        min_window_ms,
        min_window_ms * 2.0,
        min_window_ms * 4.0,
        total_duration * 0.5,
        total_duration,
    ], dtype=float))

    candidate_bounds: set[tuple[float, float]] = set()
    for start_value in start_values:
        if start_value < t_start or start_value > latest_start:
            continue
        for length in window_lengths:
            if length < min_window_ms:
                continue
            end_value = min(t_end, float(start_value + length))
            if end_value - start_value >= min_window_ms:
                candidate_bounds.add((round(float(start_value), 6), round(float(end_value), 6)))

    for length in window_lengths:
        if length < min_window_ms or length > total_duration:
            continue
        candidate_bounds.add((round(float(t_end - length), 6), round(t_end, 6)))

    full_metrics = _full_volume_metrics(trace)
    evaporation_penalty = 0.0
    if (
        full_metrics["lossPct"] is not None
        and full_metrics["lossPct"] > float(qc_options["maxVolumeLossPct"])
    ):
        evaporation_penalty += 1.0
    if (
        full_metrics["evaporationRatePctPerMin"] is not None
        and full_metrics["evaporationRatePctPerMin"] > float(qc_options["maxEvaporationRatePctPerMin"])
    ):
        evaporation_penalty += 1.0

    candidates: list[tuple[float, float, int, float, float]] = []
    for start_value, end_value in candidate_bounds:
        left = int(np.searchsorted(time_values, start_value, side="left"))
        right = int(np.searchsorted(time_values, end_value, side="right"))
        window_stats = stats(left, right)
        if window_stats is None:
            continue

        duration = float(end_value - start_value)
        slope_score = abs(float(window_stats["slope"])) / max(float(qc_options["maxAbsSlopeMnMPerMin"]), 1e-9)
        noise_score = float(window_stats["sd"]) / max(float(qc_options["maxPlateauSdMnM"]), 1e-9)
        later_score = (t_end - end_value) / max(total_duration, 1.0)
        width_score = -duration / max(total_duration, 1.0)
        score = slope_score * 2.0 + noise_score + later_score * 0.75 + width_score * 0.25 + evaporation_penalty
        candidates.append((score, -end_value, -int(window_stats["count"]), start_value, end_value))

    if not candidates:
        return _empty_qc(QC_NO_PLATEAU, trace)

    candidates.sort(key=lambda item: (item[0], item[1], item[2]))
    _, _, _, best_start, best_end = candidates[0]
    mask = valid_mask & (trace.time >= best_start) & (trace.time <= best_end)
    qc = _fit_window_qc(trace, mask, qc_options)
    if qc.point_count == 0:
        return _empty_qc(QC_NO_PLATEAU, trace)
    return qc


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
            _finalize_qc_usage(qc)


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
    if model_key == "surface_tension_cmc":
        return "Surface tension CMC"
    if model_key == "segmented_flat_plateau":
        return "Segmented linear + plateau"
    if model_key == "segmented_continuous":
        return "Trend breakpoint (not recommended for σ-CMC)"
    return "No fit"


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
        y_value = _coerce_point_value(point, ("sigmaValue", "gammaValue", "sigmaMean", "gammaMean", "y"))
        if concentration is None or y_value is None:
            continue
        if concentration <= 0:
            skipped_nonpositive = True
            continue

        error = _coerce_point_value(point, ("sigmaError", "gammaError", "error", "sigmaSe", "gammaSe", "sigmaStd", "gammaStd"))
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


def _weighted_line_fit(x: np.ndarray, y: np.ndarray, weights: np.ndarray) -> tuple[float, float, np.ndarray, float]:
    design = np.column_stack([np.ones_like(x), x])
    params, rss, y_hat = _weighted_lstsq(design, y, weights)
    return float(params[0]), float(params[1]), y_hat, rss


def _weighted_mean_and_sd(y: np.ndarray, weights: np.ndarray) -> tuple[float, float]:
    weight_sum = float(np.sum(weights))
    if weight_sum <= 0:
        return float(np.mean(y)), float(np.std(y, ddof=1)) if y.size > 1 else 0.0
    mean = float(np.sum(weights * y) / weight_sum)
    variance = float(np.sum(weights * np.square(y - mean)) / weight_sum)
    return mean, float(np.sqrt(max(0.0, variance)))


def _surface_monotonic_penalty(y: np.ndarray, error_scale: float) -> float:
    diffs = np.diff(y)
    if diffs.size == 0:
        return 0.0
    upward = diffs[diffs > max(0.25, error_scale * 2.0)]
    return float(upward.size) * 1.5 + float(np.sum(upward)) / max(error_scale, 0.25)


def _fit_surface_tension_candidate(
    x: np.ndarray,
    y: np.ndarray,
    errors: np.ndarray,
    *,
    left_start: int,
    split: int,
    min_post_points: int,
) -> dict[str, Any] | None:
    pre_x = x[left_start:split]
    pre_y = y[left_start:split]
    post_x = x[split:]
    post_y = y[split:]
    if pre_x.size < 2 or post_x.size < min_post_points:
        return None

    pre_weights = _safe_weights(errors[left_start:split])
    post_weights = _safe_weights(errors[split:])
    intercept, slope, pre_fit, pre_rss = _weighted_line_fit(pre_x, pre_y, pre_weights)
    if slope >= 0:
        return None

    plateau_sigma, plateau_sd = _weighted_mean_and_sd(post_y, post_weights)
    post_intercept, post_slope, post_fit, _post_slope_rss = _weighted_line_fit(post_x, post_y, post_weights)
    del post_intercept, _post_slope_rss

    x0 = (plateau_sigma - intercept) / slope
    if not np.isfinite(x0):
        return None

    coverage_min = float(x[left_start])
    coverage_max = float(x[-1])
    if x0 < coverage_min or x0 > coverage_max:
        return None

    plateau_fit = np.full_like(post_y, plateau_sigma, dtype=float)
    post_rss = float(np.sum(post_weights * np.square(post_y - plateau_fit)))
    reduced_rss = pre_rss / max(1, pre_y.size - 2) + post_rss / max(1, post_y.size - 1)

    error_scale = float(np.median(errors[np.isfinite(errors) & (errors > 0)])) if np.isfinite(errors).any() else 1.0
    error_scale = max(error_scale, 0.05)
    pre_span = max(float(pre_x[-1] - pre_x[0]), 1e-9)
    boundary_left = float(pre_x[-1])
    boundary_right = float(post_x[0])
    if boundary_left <= x0 <= boundary_right:
        boundary_penalty = 0.0
    else:
        boundary_distance = min(abs(x0 - boundary_left), abs(x0 - boundary_right))
        boundary_penalty = 6.0 * boundary_distance / max(pre_span, 0.25)

    excluded_count = left_start
    excluded_penalty = excluded_count * 0.25 + (excluded_count / max(1, x.size)) * 1.5
    slope_scale = max(abs(slope), 0.25)
    post_slope_penalty = max(0.0, abs(post_slope) - slope_scale * 0.12) / slope_scale * 8.0
    plateau_penalty = max(0.0, plateau_sd - max(0.5, error_scale * 2.5)) / max(error_scale, 0.1) * 2.0
    pre_slope_penalty = max(0.0, 1.0 - abs(slope)) * 3.0
    monotonic_penalty = _surface_monotonic_penalty(y[left_start:], error_scale)

    score = (
        reduced_rss
        + excluded_penalty
        + boundary_penalty
        + post_slope_penalty
        + plateau_penalty
        + pre_slope_penalty
        + monotonic_penalty
    )

    fitted = np.full_like(y, np.nan, dtype=float)
    fitted[left_start:split] = pre_fit
    fitted[split:] = plateau_fit
    return {
        "score": float(score),
        "rss": float(pre_rss + post_rss),
        "leftStart": int(left_start),
        "split": int(split),
        "x0": float(x0),
        "cmc": float(10 ** x0),
        "sigmaAtCmc": float(plateau_sigma),
        "preIntercept": intercept,
        "preSlope": slope,
        "preFit": pre_fit,
        "plateauSigma": float(plateau_sigma),
        "plateauSd": float(plateau_sd),
        "postSlopeDiagnostic": float(post_slope),
        "postFit": post_fit,
        "fitted": fitted,
        "boundaryPenalty": float(boundary_penalty),
        "postSlopePenalty": float(post_slope_penalty),
        "plateauPenalty": float(plateau_penalty),
        "preSlopePenalty": float(pre_slope_penalty),
        "monotonicPenalty": float(monotonic_penalty),
        "excludedCount": int(excluded_count),
        "postPointCount": int(post_y.size),
    }


def _fit_surface_tension_cmc_core(
    x: np.ndarray,
    y: np.ndarray,
    errors: np.ndarray,
    *,
    min_pre_points: int,
    min_post_points: int,
) -> dict[str, Any] | None:
    if x.size < min_pre_points + min(2, min_post_points):
        return None
    order = np.argsort(x)
    x_sorted = x[order]
    y_sorted = y[order]
    errors_sorted = errors[order]

    post_min = min_post_points
    if x_sorted.size < min_pre_points + post_min and min_post_points > 2:
        post_min = 2

    best: dict[str, Any] | None = None
    max_left_start = max(0, x_sorted.size - min_pre_points - post_min)
    for left_start in range(0, max_left_start + 1):
        for split in range(left_start + min_pre_points, x_sorted.size - post_min + 1):
            candidate = _fit_surface_tension_candidate(
                x_sorted,
                y_sorted,
                errors_sorted,
                left_start=left_start,
                split=split,
                min_post_points=post_min,
            )
            if candidate is None:
                continue
            if best is None or float(candidate["score"]) < float(best["score"]):
                best = candidate

    if best is None:
        return None
    best["xSorted"] = x_sorted
    best["ySorted"] = y_sorted
    best["errorsSorted"] = errors_sorted
    best["order"] = order
    best["minPostUsed"] = post_min
    return best


def _bootstrap_surface_cmc_interval(
    x: np.ndarray,
    y: np.ndarray,
    errors: np.ndarray,
    *,
    min_pre_points: int,
    min_post_points: int,
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
            if np.unique(x[indexes]).size < min_pre_points + min(2, min_post_points):
                continue
            result = _fit_surface_tension_cmc_core(
                x[indexes],
                y[indexes],
                errors[indexes],
                min_pre_points=min_pre_points,
                min_post_points=min_post_points,
            )
            if result is not None and np.isfinite(result["cmc"]):
                estimates.append(float(result["cmc"]))
        if len(estimates) < max(10, int(n_bootstrap * 0.2)):
            return None, None, "Bootstrap produced too few valid CMC estimates."
        arr = np.asarray(estimates, dtype=float)
        return float(np.percentile(arr, 2.5)), float(np.percentile(arr, 97.5)), None
    except Exception as exc:  # pragma: no cover - defensive browser runtime guard
        return None, None, f"Bootstrap failed: {exc}"


def _surface_fit_series_payload(result: dict[str, Any], *, plot_use_log: bool) -> list[dict[str, Any]]:
    x_sorted = result["xSorted"]
    left_start = int(result["leftStart"])
    split = int(result["split"])
    x0 = float(result["x0"])
    pre_start = float(x_sorted[left_start])
    post_end = float(x_sorted[-1])
    pre_grid = np.linspace(pre_start, x0, 80)
    post_grid = np.linspace(x0, post_end, 80)
    pre_y = float(result["preIntercept"]) + float(result["preSlope"]) * pre_grid
    post_y = np.full_like(post_grid, float(result["plateauSigma"]), dtype=float)
    return [
        {
            "name": "pre-CMC decline",
            "x": (pre_grid if plot_use_log else np.power(10.0, pre_grid)).tolist(),
            "xLog": pre_grid.tolist(),
            "y": pre_y.tolist(),
        },
        {
            "name": "post-CMC plateau",
            "x": (post_grid if plot_use_log else np.power(10.0, post_grid)).tolist(),
            "xLog": post_grid.tolist(),
            "y": post_y.tolist(),
        },
    ]


def _surface_fit_warnings(
    result: dict[str, Any],
    warnings: list[dict[str, str]],
    *,
    requested_min_post_points: int,
) -> None:
    if int(result["minPostUsed"]) < requested_min_post_points:
        warnings.append(_fit_warning_payload(
            "LOW_POST_PLATEAU_POINTS",
            "Only two high-concentration points were available for the plateau segment.",
        ))
    if result["boundaryPenalty"] > 0:
        warnings.append(_fit_warning_payload(
            FIT_BREAKPOINT_AT_BOUNDARY,
            "The CMC intersection is not directly between the fitted decline and plateau segments.",
        ))
    if result["postSlopePenalty"] > 0:
        warnings.append(_fit_warning_payload(
            FIT_HIGH_POST_CMC_SLOPE,
            "High-concentration points still show a measurable post-CMC slope.",
        ))
    if result["plateauPenalty"] > 0:
        warnings.append(_fit_warning_payload(
            FIT_NO_CLEAR_PLATEAU,
            "High-concentration plateau scatter is larger than expected.",
        ))
    if result["preSlopePenalty"] > 0:
        warnings.append(_fit_warning_payload(
            "WEAK_PRE_CMC_DECLINE",
            "The fitted pre-CMC decline is shallow.",
        ))
    if result["monotonicPenalty"] > 0:
        warnings.append(_fit_warning_payload(
            FIT_NON_MONOTONIC_OR_DIP,
            "Surface tension is not monotonic across the fitted pre/post CMC range.",
        ))
    if int(result["excludedCount"]) > 0:
        warnings.append(_fit_warning_payload(
            "LOW_CONCENTRATION_BASELINE_EXCLUDED",
            "Low-concentration baseline points were excluded from the pre-CMC decline fit.",
        ))


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
    min_pre_points = int(fit_options["minPrePoints"])
    min_post_points = int(fit_options["minPostPoints"])
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
        "transitionLabel": label,
        "cmc": None,
        "cmcLog10": None,
        "sigmaAtCmc": None,
        "gammaAtCmc": None,
        "ciLow": None,
        "ciHigh": None,
        "parameters": {},
        "fitSegments": [],
        "fitSeries": [],
        "cmcMarker": None,
        "residuals": [],
        "usedPointIndexes": used_indexes,
        "warnings": warnings,
    }

    if model_key == "surface_tension_cmc":
        min_post_available = min_post_points
        if len(used_indexes) < min_pre_points + min_post_available and min_post_available > 2:
            min_post_available = 2
        min_required_surface = min_pre_points + min_post_available
        if len(used_indexes) < min_required_surface or np.unique(x).size < min_required_surface:
            base["warnings"].append(_fit_warning_payload(
                FIT_NOT_ENOUGH_CONCENTRATIONS,
                f"At least {min_required_surface} positive concentration points are required for surface-tension CMC fitting.",
            ))
            return base

        result = _fit_surface_tension_cmc_core(
            x,
            y,
            errors,
            min_pre_points=min_pre_points,
            min_post_points=min_post_points,
        )
        if result is None:
            base["warnings"].append(_fit_warning_payload(
                FIT_NO_CLEAR_PLATEAU,
                "Could not find a negative pre-CMC decline followed by a usable high-concentration plateau.",
            ))
            return base

        _surface_fit_warnings(result, warnings, requested_min_post_points=min_post_points)
        ci_low, ci_high, bootstrap_warning = _bootstrap_surface_cmc_interval(
            x,
            y,
            errors,
            min_pre_points=min_pre_points,
            min_post_points=min_post_points,
            n_bootstrap=n_bootstrap,
        )
        if bootstrap_warning:
            warnings.append(_fit_warning_payload("BOOTSTRAP_FAILED", bootstrap_warning))

        x_sorted = result["xSorted"]
        y_sorted = result["ySorted"]
        order = result["order"]
        left_start = int(result["leftStart"])
        split = int(result["split"])
        fitted = result["fitted"]
        residuals = []
        for idx in range(len(x_sorted)):
            fitted_value = fitted[idx]
            residuals.append({
                "pointIndex": used_indexes[int(order[idx])],
                "x": float(x_sorted[idx]),
                "y": float(y_sorted[idx]),
                "fitted": None if not np.isfinite(fitted_value) else float(fitted_value),
                "residual": None if not np.isfinite(fitted_value) else float(y_sorted[idx] - fitted_value),
                "excludedFromFit": bool(idx < left_start),
                "segment": "excluded_baseline" if idx < left_start else ("pre" if idx < split else "post"),
            })

        excluded_indexes = [
            used_indexes[int(order[idx])]
            for idx in range(left_start)
        ]
        fit_series = _surface_fit_series_payload(result, plot_use_log=plot_use_log)
        sigma_at_cmc = float(result["sigmaAtCmc"])
        cmc = float(result["cmc"])
        x0 = float(result["x0"])
        base.update({
            "equationText": f"{label}: σ = a + b·log10(C) until σ = σ_plateau",
            "cmc": cmc,
            "cmcLog10": x0,
            "sigmaAtCmc": sigma_at_cmc,
            "gammaAtCmc": sigma_at_cmc,
            "ciLow": ci_low,
            "ciHigh": ci_high,
            "parameters": {
                "preSlope": float(result["preSlope"]),
                "preIntercept": float(result["preIntercept"]),
                "plateauSigma": sigma_at_cmc,
                "plateauSd": float(result["plateauSd"]),
                "postSlopeDiagnostic": float(result["postSlopeDiagnostic"]),
                "leftStartIndex": left_start,
                "splitIndex": split,
                "excludedLowConcentrationPointIndexes": excluded_indexes,
                "rss": float(result["rss"]),
                "score": float(result["score"]),
                "sampleType": sample_type,
                "transitionLabel": label,
            },
            "fitSegments": fit_series,
            "fitSeries": fit_series,
            "cmcMarker": {
                "x": x0 if plot_use_log else cmc,
                "xLog": x0,
                "y": sigma_at_cmc,
                "label": label,
            },
            "residuals": residuals,
            "warnings": warnings,
        })
        return base

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
        equation = "σ = a + b·min(log10(C), x0)"
        parameters = {
            "a": float(result["params"][0]),
            "b": float(result["params"][1]),
            "plateauSigma": gamma_at_cmc,
        }
    else:
        equation = "σ = a + b1·log10(C) + b2·max(0, log10(C)-x0)"
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
        "sigmaAtCmc": gamma_at_cmc,
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
        "fitSegments": _fit_series_payload(result, plot_use_log=plot_use_log),
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
