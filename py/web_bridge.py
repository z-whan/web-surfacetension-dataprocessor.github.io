import math
import os
from typing import Any

import numpy as np

from DataProcessor.services.cmc_analysis import (
    compute_droplet_means,
    infer_concentration_from_filename,
    summarize_droplet_means,
)
from DataProcessor.services.dataframe_loader import load_plot_dataframe
from DataProcessor.services.errors import DataProcessingError
from DataProcessor.services.plot_analysis import prepare_plot_dataset
from DataProcessor.services.time_series_analysis import analyze_noise, extract_trend_analysis


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


def _summary_rows_payload(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []
    for row in rows:
        payload.append({key: _finite_or_none(value) for key, value in row.items()})
    return payload


def _load_plot_dataset(
    source_path: str,
    start_text: str,
    end_text: str,
    exp_range_text: str,
    avg_only: bool,
):
    df = load_plot_dataframe(source_path)
    return prepare_plot_dataset(
        df=df,
        start_text=start_text,
        end_text=end_text,
        exp_range_text=exp_range_text,
        avg_only=avg_only,
    )


def get_runtime_metadata() -> dict[str, Any]:
    return {
        "supportsLocalOnly": True,
        "supportedExtensions": [".csv", ".xlsx", ".xls"],
        "pythonBackedFeatures": [
            "Time-series experiment parsing",
            "CMC droplet statistics",
            "Filename concentration inference",
        ],
    }


def infer_concentration(filename: str) -> dict[str, Any]:
    value = infer_concentration_from_filename(filename)
    return {"filename": filename, "value": _finite_or_none(value)}


def analyze_plot_file(
    source_path: str,
    start_text: str,
    end_text: str,
    exp_range_text: str,
    avg_only: bool,
) -> dict[str, Any]:
    dataset = _load_plot_dataset(source_path, start_text, end_text, exp_range_text, avg_only)

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


def extract_plot_trend(
    source_path: str,
    start_text: str,
    end_text: str,
    exp_range_text: str,
    avg_only: bool,
    method_key: str,
    parameters: dict[str, Any],
) -> dict[str, Any]:
    dataset = _load_plot_dataset(source_path, start_text, end_text, exp_range_text, avg_only)
    result = extract_trend_analysis(
        x_label=dataset.x_label,
        x_values=dataset.x_values,
        y_values=dataset.y_values,
        method_key=method_key,
        parameters=parameters,
    )
    return {
        "method": {
            "key": result.method_key,
            "label": result.method_label,
            "parameters": {key: _finite_or_none(value) for key, value in result.parameters.items()},
        },
        "summaryText": result.summary_text,
        "series": _series_payload(dataset.x_values, result.trend_values),
    }


def analyze_plot_noise(
    source_path: str,
    start_text: str,
    end_text: str,
    exp_range_text: str,
    avg_only: bool,
    method_key: str,
    parameters: dict[str, Any],
    trend_request: dict[str, Any] | None = None,
) -> dict[str, Any]:
    dataset = _load_plot_dataset(source_path, start_text, end_text, exp_range_text, avg_only)
    trend_values = None

    if trend_request is not None:
        trend_method_key = str(trend_request.get("methodKey", "")).strip()
        trend_parameters = trend_request.get("parameters", {}) or {}
        if trend_method_key:
            trend_values = extract_trend_analysis(
                x_label=dataset.x_label,
                x_values=dataset.x_values,
                y_values=dataset.y_values,
                method_key=trend_method_key,
                parameters=trend_parameters,
            ).trend_values

    result = analyze_noise(
        x_values=dataset.x_values,
        y_values=dataset.y_values,
        method_key=method_key,
        parameters=parameters,
        trend_values=trend_values,
    )

    plot_payload = None
    if result.plot_payload is not None:
        plot_payload = {
            "title": result.plot_payload["title"],
            "xLabel": result.plot_payload["xLabel"],
            "yLabel": result.plot_payload["yLabel"],
            "xScale": result.plot_payload["xScale"],
            "yScale": result.plot_payload["yScale"],
            "series": [
                {
                    "name": series["name"],
                    "x": [_finite_or_none(value) for value in series["x"]],
                    "y": [_finite_or_none(value) for value in series["y"]],
                }
                for series in result.plot_payload["series"]
            ],
        }

    return {
        "method": {
            "key": result.method_key,
            "label": result.method_label,
            "parameters": {key: _finite_or_none(value) for key, value in result.parameters.items()},
        },
        "summaryText": result.summary_text,
        "summaryColumns": result.summary_columns,
        "summaryRows": _summary_rows_payload(result.summary_rows),
        "plot": plot_payload,
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

        # Reuse the same robust loader as the plot workflow so FAMAS-style CSVs
        # and encoded lab exports behave consistently across both tools.
        df = load_plot_dataframe(path)
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
