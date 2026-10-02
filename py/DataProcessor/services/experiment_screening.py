"""Transparent, conservative screening of individual raw experiments."""
import re

import numpy as np
import pandas as pd

from DataProcessor.services.errors import DataProcessingError
from DataProcessor.services.plot_analysis import find_time_column, format_experiment_range


def time_scale_seconds(label: str) -> float | None:
    """Do not assume milliseconds for an unlabelled time axis."""
    unit = str(label).lower().replace(" ", "")
    if re.search(r"\((ms|milliseconds?)\)|\[ms\]", unit):
        return 0.001
    if re.search(r"\((s|sec|seconds?)\)|\[s\]", unit):
        return 1.0
    if re.search(r"\((min|minutes?)\)|\[min\]", unit):
        return 60.0
    return None


def _options(options):
    options = options or {}
    def bounded(key, default, minimum, maximum):
        try:
            value = float(options.get(key, default))
        except (ValueError, TypeError):
            return default
        return value if np.isfinite(value) and minimum <= value <= maximum else default
    return {
        "validPercent": bounded("validPercent", 95.0, 50.0, 100.0),
        "durationPercent": bounded("durationPercent", 90.0, 50.0, 100.0),
        "noiseThreshold": bounded("noiseThreshold", 0.5, 0.01, 10.0),
        "evaporationLimit": 5.0,
    }


def _noise_metrics(t, y):
    # Compare each interior sample to linear interpolation of its neighbours.
    # Removing the local slope preserves smooth surface-tension decay. Normalise
    # the residual variance so MAD estimates the noise of the original samples.
    before = t[1:-1] - t[:-2]
    after = t[2:] - t[1:-1]
    good = (before > 0) & (after > 0)
    weight = before[good] / (before[good] + after[good])
    residual = y[1:-1][good] - ((1 - weight) * y[:-2][good] + weight * y[2:][good])
    if len(residual) < 5:
        return None, None
    residual /= np.sqrt(1 + weight ** 2 + (1 - weight) ** 2)
    center = np.median(residual)
    return float(1.4826 * np.median(np.abs(residual - center))), float(np.percentile(np.abs(residual - center), 95))


def screen_experiments(df, volumes=None, options=None):
    """Inspect full raw columns, including missing values and unused slots.

    volumes maps experiment IDs to row-aligned arrays. Invalid time or volume
    never falls back to row numbers. Unknown evaporation remains under review.
    """
    rules = _options(options)
    time_col = find_time_column(df.columns)
    time = pd.to_numeric(df[time_col], errors="coerce").to_numpy(dtype=float)
    scale = time_scale_seconds(str(time_col))
    columns = []
    for col in df.columns:
        match = re.fullmatch(r"I\.?T\.?\s*\(mN\s*/\s*m\)(?:\.(\d+))?", str(col).strip(), re.I)
        if match:
            columns.append((int(match.group(1) or len(columns) + 1), col))
    if not columns:
        raise DataProcessingError("No individual I.T.(mN/m) experiment columns found.")
    arrays = [(idx, pd.to_numeric(df[col], errors="coerce").to_numpy(dtype=float)) for idx, col in columns]
    # Shared recording interval: retain internal missing rows, ignore blank
    # padding outside every measured curve. Zero-filled unused slots are empty.
    active = np.isfinite(time) | np.any([np.isfinite(y) & (y > 0) for _, y in arrays], axis=0)
    positions = np.flatnonzero(active)
    start, end = (int(positions[0]), int(positions[-1]) + 1) if len(positions) else (0, len(time))
    longest = 0.0
    for _, y in arrays:
        valid = np.isfinite(time[start:end]) & np.isfinite(y[start:end]) & (y[start:end] > 0)
        t = time[start:end][valid]
        if len(t):
            longest = max(longest, float(np.max(t) - np.min(t)))

    results = []
    for idx, raw in arrays:
        t_all, y_all = time[start:end], raw[start:end]
        valid = np.isfinite(t_all) & np.isfinite(y_all) & (y_all > 0)
        t, y = t_all[valid], y_all[valid]
        count = int(valid.sum())
        total = len(valid)
        complete = 100.0 * count / total if total else 0.0
        duration = float(np.max(t) - np.min(t)) if count else 0.0
        coverage = duration / longest * 100.0 if longest > 0 else 0.0
        failed, pending, notes = [], [], []
        if not count:
            failed.append("No valid surface-tension data (empty or zero-filled slot).")
        elif count < 10:
            failed.append(f"Only {count} valid points; at least 10 are required for fluctuation screening.")
        if complete + 1e-9 < rules["validPercent"]:
            failed.append(f"Valid data {complete:.1f}% is below {rules['validPercent']:g}%.")
        if coverage + 1e-9 < rules["durationPercent"]:
            failed.append(f"Duration coverage {coverage:.1f}% is below {rules['durationPercent']:g}% of the longest curve.")
        if count and not valid[0]:
            failed.append("The beginning of the shared recording is missing; check the start before selecting this experiment.")
        monotonic = count >= 2 and bool(np.all(np.diff(t) > 0))
        if not monotonic and count:
            failed.append("Time is duplicate, reversed, or too short.")
        if monotonic and len(t) > 2 and np.max(np.diff(t)) > 3 * np.median(np.diff(t)):
            failed.append("Recording gap exceeds three times the median sampling interval.")
        noise, peak = _noise_metrics(t, y) if count >= 10 and monotonic else (None, None)
        if noise is not None and (noise > rules["noiseThreshold"] or peak > 3 * rules["noiseThreshold"]):
            failed.append(f"Strong fluctuations: robust noise {noise:.3f} mN/m; 95th-percentile residual {peak:.3f} mN/m.")
        # MAD/P95 can hide rare spikes. A large change followed by an immediate
        # reversal is screened separately; a monotonic rapid decay is preserved.
        changes = np.diff(y)
        spike_count = int(np.sum((changes[:-1] * changes[1:] < 0) &
                                 (np.minimum(np.abs(changes[:-1]), np.abs(changes[1:])) > 6 * rules["noiseThreshold"]))) if monotonic else 0
        if spike_count:
            failed.append(f"{spike_count} abrupt spike(s): change and reversal both exceed {6 * rules['noiseThreshold']:g} mN/m.")

        volume = (volumes or {}).get(idx)
        evap, loss, volume_duration = None, None, None
        volume_count = 0
        volume_source = None
        if volume is not None:
            v = np.asarray(volume["values"], dtype=float)[start:end]
            v_valid = valid & np.isfinite(v) & (v > 0)
            vt, vv = t_all[v_valid], v[v_valid]
            volume_count = int(v_valid.sum())
            volume_source = volume.get("source")
            if scale is not None and len(vt) >= 2 and monotonic:
                volume_duration = float((vt[-1] - vt[0]) * scale)
                if volume_duration > 0:
                    loss = float(max(0.0, (vv[0] - vv[-1]) / vv[0] * 100.0))
                    evap = loss * 600.0 / volume_duration
                    if evap > rules["evaporationLimit"] + 1e-9:
                        failed.append(f"Evaporation {evap:.2f}%/10min exceeds 5%/10min.")
                    if vv[-1] > vv[0] * 1.01:
                        pending.append("Volume increases by more than 1%; check the volume measurement.")
                    if volume_duration < 600:
                        notes.append("10-minute evaporation is normalised from a shorter recording, not an observed 10-minute loss.")
            if count and volume_count / count * 100 + 1e-9 < rules["validPercent"]:
                pending.append("Volume data is incomplete; evaporation needs manual review.")
            if volume_duration is not None and duration > 0 and volume_duration < duration * scale * rules["durationPercent"] / 100:
                pending.append("Volume measurements cover too little of the surface-tension recording.")
        if evap is None:
            pending.append("Evaporation cannot be assessed: positive volume values and a valid time unit/duration are required.")
        if not failed and not pending:
            notes.insert(0, "Meets the completeness, fluctuation and evaporation screening rules.")
        status = "exclude" if failed else "review" if pending else "suggest"
        results.append({
            "experimentIndex": idx, "status": status, "reasons": failed + pending + notes,
            "validPoints": count, "totalPoints": total, "validPercent": complete,
            "durationCoveragePercent": coverage, "durationSeconds": duration * scale if scale else None,
            "noiseSigma": noise, "residualP95": peak,
            "spikeCount": spike_count,
            "evaporationPctPer10Min": evap, "volumeLossPercent": loss,
            "volumeDurationSeconds": volume_duration, "volumePoints": volume_count,
            "volumeSource": volume_source,
        })
    return {
        "recommendedRange": format_experiment_range([r["experimentIndex"] for r in results if r["status"] == "suggest"]),
        "experiments": results, "rules": rules, "timeLabel": str(time_col),
    }
