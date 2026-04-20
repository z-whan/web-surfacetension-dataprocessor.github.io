import os
import re
from typing import Sequence

import numpy as np
import pandas as pd

from DataProcessor.services.errors import DataProcessingError


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


def compute_droplet_means(df: pd.DataFrame, t_min: float, t_max: float) -> list[float]:
    time_col = guess_time_column(df.columns)
    gamma_col = guess_gamma_column(df.columns)

    if time_col is None or gamma_col is None:
        raise DataProcessingError(
            "Cannot automatically detect time or surface tension columns."
        )

    time_series = pd.to_numeric(df[time_col], errors="coerce")
    gamma_series = pd.to_numeric(df[gamma_col], errors="coerce")

    valid_mask = time_series.notna() & gamma_series.notna()
    time = time_series[valid_mask].to_numpy()
    gamma = gamma_series[valid_mask].to_numpy()

    if time.size == 0:
        return []

    droplet_ids = np.zeros_like(time, dtype=int)
    current_id = 0
    for idx in range(1, len(time)):
        if time[idx] < time[idx - 1]:
            current_id += 1
        droplet_ids[idx] = current_id

    droplet_means: list[float] = []
    for droplet_id in range(current_id + 1):
        mask_d = droplet_ids == droplet_id
        if not mask_d.any():
            continue

        t_d = time[mask_d]
        g_d = gamma[mask_d]

        mask_t = (t_d >= t_min) & (t_d <= t_max)
        if not mask_t.any():
            continue

        droplet_means.append(float(g_d[mask_t].mean()))

    return droplet_means


def summarize_droplet_means(droplet_means: Sequence[float]) -> tuple[float, float]:
    arr = np.asarray(droplet_means, dtype=float)
    if arr.size == 0:
        raise DataProcessingError("No valid droplet data in the requested time range.")

    mean = float(arr.mean())
    std = float(arr.std(ddof=1)) if arr.size > 1 else 0.0
    return mean, std
