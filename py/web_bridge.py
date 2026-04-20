import math
import os
from typing import Any

import numpy as np

from DataProcessor.services.cmc_analysis import (
    compute_droplet_means,
    infer_concentration_from_filename,
    summarize_droplet_means,
)
from DataProcessor.services.csv_to_xlsx import csv_to_xlsx
from DataProcessor.services.dataframe_loader import load_plot_dataframe, read_table_robust
from DataProcessor.services.errors import DataProcessingError
from DataProcessor.services.plot_analysis import prepare_plot_dataset


def _finite_or_none(value: Any) -> float | int | str | None:
    if value is None:
        return None
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        value = float(value)
        if math.isfinite(value):
            return value
        return None
    return value


def _series_payload(x_values, y_values) -> list[dict[str, Any]]:
    x_list = [_finite_or_none(value) for value in x_values.tolist()]
    series: list[dict[str, Any]] = []
    for col in y_values.columns:
        series.append(
            {
                "name": str(col),
                "x": x_list,
                "y": [_finite_or_none(value) for value in y_values[col].tolist()],
            }
        )
    return series


def get_runtime_metadata() -> dict[str, Any]:
    return {
        "supportsLocalOnly": True,
        "supportedExtensions": [".csv", ".xlsx", ".xls"],
        "pythonBackedFeatures": [
            "CSV to XLSX conversion",
            "Time-series experiment parsing",
            "CMC droplet statistics",
            "Filename concentration inference",
        ],
    }


def infer_concentration(filename: str) -> dict[str, Any]:
    value = infer_concentration_from_filename(filename)
    return {"filename": filename, "value": _finite_or_none(value)}


def convert_csv_to_xlsx_in_fs(source_path: str) -> dict[str, Any]:
    out_path = csv_to_xlsx(source_path)
    return {
        "sourcePath": source_path,
        "outputPath": out_path,
        "downloadName": os.path.basename(out_path),
    }


def analyze_plot_file(
    source_path: str,
    start_text: str,
    end_text: str,
    exp_range_text: str,
    avg_only: bool,
) -> dict[str, Any]:
    df = load_plot_dataframe(source_path)
    dataset = prepare_plot_dataset(
        df=df,
        start_text=start_text,
        end_text=end_text,
        exp_range_text=exp_range_text,
        avg_only=avg_only,
    )

    y_values = dataset.y_values.to_numpy(dtype=float)
    finite_values = y_values[np.isfinite(y_values)]
    y_min = float(finite_values.min()) if finite_values.size else None
    y_max = float(finite_values.max()) if finite_values.size else None

    return {
        "sourcePath": source_path,
        "xLabel": dataset.x_label,
        "expTag": dataset.exp_tag,
        "rowRange": list(dataset.row_range),
        "defaultExpRange": dataset.default_exp_range,
        "series": _series_payload(dataset.x_values, dataset.y_values),
        "summary": {
            "rows": int(len(dataset.x_values)),
            "seriesCount": int(len(dataset.y_values.columns)),
            "yMin": _finite_or_none(y_min),
            "yMax": _finite_or_none(y_max),
        },
    }


def analyze_cmc_files(
    entries: list[dict[str, Any]],
    t_min_text: str,
    t_max_text: str,
    c_unit: str,
    use_log: bool,
) -> dict[str, Any]:
    if not entries:
        raise DataProcessingError("Please choose at least one file.")

    try:
        t_min = float(str(t_min_text).strip())
        t_max = float(str(t_max_text).strip())
    except ValueError as exc:
        raise DataProcessingError("Time range must be numeric.") from exc

    if t_min >= t_max:
        raise DataProcessingError("Please ensure t_min < t_max.")

    rows: list[dict[str, Any]] = []
    for entry in entries:
        path = str(entry.get("path", "")).strip()
        filename = str(entry.get("filename", "")).strip() or os.path.basename(path)
        concentration_text = str(entry.get("concentration", "")).strip()

        if not path:
            raise DataProcessingError(f"Missing file path for '{filename or 'unknown file'}'.")
        if not os.path.isfile(path):
            raise DataProcessingError(f"File not found in browser runtime: {path}")
        if not concentration_text:
            raise DataProcessingError(f"Concentration is required for '{filename}'.")

        try:
            concentration = float(concentration_text)
        except ValueError as exc:
            raise DataProcessingError(
                f"Concentration for '{filename}' must be numeric."
            ) from exc

        if concentration < 0:
            raise DataProcessingError(f"Concentration for '{filename}' must be >= 0.")

        df = read_table_robust(path)
        droplet_means = compute_droplet_means(df, t_min=t_min, t_max=t_max)
        mean, std = summarize_droplet_means(droplet_means)

        rows.append(
            {
                "filename": filename,
                "path": path,
                "concentration": concentration,
                "gammaMean": mean,
                "gammaStd": std,
                "dropletCount": len(droplet_means),
            }
        )

    c_arr = np.asarray([row["concentration"] for row in rows], dtype=float)
    if use_log:
        if not np.all(c_arr > 0):
            raise DataProcessingError(
                "log10(C) is only defined for concentrations greater than 0."
            )
        x_arr = np.log10(c_arr)
        x_label = f"log10 C ({c_unit})" if c_unit else "log10 C"
    else:
        x_arr = c_arr
        x_label = f"Concentration C ({c_unit})" if c_unit else "Concentration C"

    order = np.argsort(x_arr)
    plot_rows = [rows[int(idx)] for idx in order.tolist()]
    x_sorted = x_arr[order]

    return {
        "xLabel": x_label,
        "useLog": bool(use_log),
        "points": [
            {
                "x": _finite_or_none(x_sorted[idx]),
                "y": _finite_or_none(plot_rows[idx]["gammaMean"]),
                "error": _finite_or_none(plot_rows[idx]["gammaStd"]),
                "filename": plot_rows[idx]["filename"],
                "concentration": _finite_or_none(plot_rows[idx]["concentration"]),
                "dropletCount": int(plot_rows[idx]["dropletCount"]),
            }
            for idx in range(len(plot_rows))
        ],
        "rows": [
            {
                "filename": row["filename"],
                "concentration": _finite_or_none(row["concentration"]),
                "gammaMean": _finite_or_none(row["gammaMean"]),
                "gammaStd": _finite_or_none(row["gammaStd"]),
                "dropletCount": int(row["dropletCount"]),
            }
            for row in plot_rows
        ],
        "summary": {
            "fileCount": len(plot_rows),
            "timeWindow": [_finite_or_none(t_min), _finite_or_none(t_max)],
        },
    }
