import os
import re
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np
import pandas as pd

from DataProcessor.services.errors import DataProcessingError


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
