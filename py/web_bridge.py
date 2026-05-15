import math
import os
from typing import Any

import numpy as np

from DataProcessor.services.cmc_analysis import (
    aggregate_cmc_qc_results,
    compute_droplet_plateau_qc,
    extract_cmc_droplet_traces,
    fit_cmc_curve,
    infer_concentration_from_filename,
    mark_outliers_within_concentration,
    normalize_cmc_qc_options,
)
from DataProcessor.services.dataframe_loader import (
    load_plot_dataframe,
    parse_famas_metadata,
    parse_famas_measurement_detail_volumes,
)
from DataProcessor.services.errors import DataProcessingError
from DataProcessor.services.plot_analysis import prepare_plot_dataset
from DataProcessor.services.time_series_analysis import (
    analyze_noise,
    analyze_time_series_quality as analyze_time_series_quality_dataset,
    extract_trend_analysis,
)


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


def _payload_value(value: Any):
    if isinstance(value, dict):
        return {key: _payload_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_payload_value(item) for item in value]
    return _finite_or_none(value)


def _series_payload(x_values, y_values, experiment_indexes=None) -> list[dict[str, Any]]:
    x_list = [_finite_or_none(value) for value in x_values.tolist()]
    series: list[dict[str, Any]] = []
    experiment_indexes = experiment_indexes or []
    for idx, col in enumerate(y_values.columns):
        item = {
            "name": str(col),
            "x": x_list,
            "y": [_finite_or_none(value) for value in y_values[col].tolist()],
        }
        if idx < len(experiment_indexes) and experiment_indexes[idx] is not None:
            item["experimentIndex"] = int(experiment_indexes[idx])
        series.append(item)
    return series


def _summary_rows_payload(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []
    for row in rows:
        payload.append({key: _finite_or_none(value) for key, value in row.items()})
    return payload


def _prepare_plot_dataframe_and_dataset(
    source_path: str,
    start_text: str,
    end_text: str,
    exp_range_text: str,
    avg_only: bool,
    show_original_with_avg: bool = False,
):
    df = load_plot_dataframe(source_path)
    dataset = prepare_plot_dataset(
        df=df,
        start_text=start_text,
        end_text=end_text,
        exp_range_text=exp_range_text,
        avg_only=avg_only,
        show_original_with_avg=show_original_with_avg,
    )
    return df, dataset


def _load_plot_dataset(
    source_path: str,
    start_text: str,
    end_text: str,
    exp_range_text: str,
    avg_only: bool,
    show_original_with_avg: bool = False,
):
    _, dataset = _prepare_plot_dataframe_and_dataset(
        source_path,
        start_text,
        end_text,
        exp_range_text,
        avg_only,
        show_original_with_avg,
    )
    return dataset


def _positive_float_or_none(value: Any) -> float | None:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    if math.isfinite(numeric) and numeric > 0:
        return numeric
    return None


def _x_value_for_detail_row(x_values, row_range: tuple[int, int], row_index: int) -> tuple[float | int | None, bool]:
    offset = row_index - row_range[0]
    if 0 <= offset < len(x_values):
        x_value = _finite_or_none(x_values.iloc[offset])
        if x_value is not None:
            return x_value, False
    return row_index, True


def _volume_series_from_detail(
    detail_entries: list[dict[str, Any]],
    *,
    experiment_index: int,
    x_values,
    row_range: tuple[int, int],
) -> tuple[dict[str, Any] | None, bool]:
    x: list[float | int] = []
    y: list[float] = []
    used_row_index_fallback = False
    start, end = row_range

    for entry in sorted(detail_entries, key=lambda item: int(item.get("rowIndex", 0) or 0)):
        row_index = int(entry.get("rowIndex", 0) or 0)
        if row_index < start or row_index > end:
            continue
        volume = _positive_float_or_none(entry.get("volume"))
        if volume is None:
            continue
        x_value, used_fallback = _x_value_for_detail_row(x_values, row_range, row_index)
        if x_value is None:
            continue
        used_row_index_fallback = used_row_index_fallback or used_fallback
        x.append(x_value)
        y.append(volume)

    if not x:
        return None, used_row_index_fallback

    return {
        "name": f"Exp {experiment_index} V",
        "experimentIndex": experiment_index,
        "x": x,
        "y": y,
        "source": "detail",
    }, used_row_index_fallback


def _volume_series_from_worksheet(
    df,
    *,
    experiment_index: int,
    x_values,
    row_range: tuple[int, int],
) -> dict[str, Any] | None:
    col = f"V(uL).{experiment_index}"
    if col not in df.columns:
        return None

    start = row_range[0] - 1
    end = row_range[1]
    volume_values = df[col].iloc[start:end]
    x: list[float | int] = []
    y: list[float] = []

    for x_value_raw, volume_raw in zip(x_values.tolist(), volume_values.tolist()):
        x_value = _finite_or_none(x_value_raw)
        volume = _positive_float_or_none(volume_raw)
        if x_value is None or volume is None:
            continue
        x.append(x_value)
        y.append(volume)

    if not x:
        return None

    return {
        "name": f"Exp {experiment_index} V",
        "experimentIndex": experiment_index,
        "x": x,
        "y": y,
        "source": "worksheet",
    }


def _volume_overlay_payload(source_path: str, df, dataset) -> dict[str, Any]:
    warnings: list[str] = []
    detail: dict[int, list[dict[str, Any]]] = {}
    if source_path.lower().endswith(".csv"):
        try:
            detail = parse_famas_measurement_detail_volumes(source_path)
        except Exception:
            detail = {}

    series: list[dict[str, Any]] = []
    used_row_index_fallback = False
    for experiment_index in dataset.selected_experiment_indexes or []:
        volume_series = None
        if experiment_index in detail:
            volume_series, used_fallback = _volume_series_from_detail(
                detail[experiment_index],
                experiment_index=experiment_index,
                x_values=dataset.x_values,
                row_range=dataset.row_range,
            )
            used_row_index_fallback = used_row_index_fallback or used_fallback
        if volume_series is None:
            volume_series = _volume_series_from_worksheet(
                df,
                experiment_index=experiment_index,
                x_values=dataset.x_values,
                row_range=dataset.row_range,
            )
        if volume_series is not None:
            series.append(volume_series)

    if used_row_index_fallback:
        warnings.append("Droplet volume x-values used detail row indexes where time values were unavailable.")
    if not series:
        warnings.append("Droplet volume data was not found.")

    return {
        "yLabel": "Droplet volume, V (μL)",
        "series": series,
        "warnings": warnings,
    }


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
    show_original_with_avg: bool = False,
) -> dict[str, Any]:
    df, dataset = _prepare_plot_dataframe_and_dataset(
        source_path,
        start_text,
        end_text,
        exp_range_text,
        avg_only,
        show_original_with_avg,
    )

    y_values = dataset.plot_values.to_numpy(dtype=float)
    finite_values = y_values[np.isfinite(y_values)]
    y_min = float(finite_values.min()) if finite_values.size else None
    y_max = float(finite_values.max()) if finite_values.size else None

    return {
        "sourcePath": source_path,
        "xLabel": dataset.x_label,
        "expTag": dataset.exp_tag,
        "rowRange": list(dataset.row_range),
        "defaultExpRange": dataset.default_exp_range,
        "series": _series_payload(
            dataset.x_values,
            dataset.plot_values,
            dataset.plot_experiment_indexes,
        ),
        "volumeOverlay": _volume_overlay_payload(source_path, df, dataset),
        "summary": {
            "rows": int(len(dataset.x_values)),
            "seriesCount": int(len(dataset.plot_values.columns)),
            "yMin": _finite_or_none(y_min),
            "yMax": _finite_or_none(y_max),
        },
    }


def analyze_time_series_quality(
    source_path: str,
    start_text: str,
    end_text: str,
    exp_range_text: str,
    avg_only: bool,
    show_original_with_avg: bool = False,
) -> dict[str, Any]:
    dataset = _load_plot_dataset(
        source_path,
        start_text,
        end_text,
        exp_range_text,
        avg_only,
        show_original_with_avg,
    )
    return analyze_time_series_quality_dataset(
        x_label=dataset.x_label,
        x_values=dataset.x_values,
        y_values=dataset.y_values,
        row_range=dataset.row_range,
        selection_label=dataset.exp_tag,
    )


def extract_plot_trend(
    source_path: str,
    start_text: str,
    end_text: str,
    exp_range_text: str,
    avg_only: bool,
    method_key: str,
    parameters: dict[str, Any],
    show_original_with_avg: bool = False,
) -> dict[str, Any]:
    dataset = _load_plot_dataset(
        source_path,
        start_text,
        end_text,
        exp_range_text,
        avg_only,
        show_original_with_avg,
    )
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
        "series": _series_payload(
            dataset.x_values,
            result.trend_values,
            dataset.y_experiment_indexes,
        ),
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
    show_original_with_avg: bool = False,
) -> dict[str, Any]:
    dataset = _load_plot_dataset(
        source_path,
        start_text,
        end_text,
        exp_range_text,
        avg_only,
        show_original_with_avg,
    )
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


def _parse_cmc_time_range(t_min_text: str, t_max_text: str) -> tuple[float, float]:
    try:
        t_min = float(str(t_min_text).strip())
        t_max = float(str(t_max_text).strip())
    except ValueError as exc:
        raise DataProcessingError("Time range must be numeric.") from exc

    if t_min >= t_max:
        raise DataProcessingError("Please ensure t_min < t_max.")

    return t_min, t_max


def _load_cmc_file_review(
    entry: dict[str, Any],
    *,
    t_min: float,
    t_max: float,
    qc_options: dict[str, Any],
) -> tuple[dict[str, Any], list[Any], list[Any]]:
    path = str(entry.get("path", "")).strip()
    filename = str(entry.get("filename", "")).strip() or os.path.basename(path)

    if not path:
        raise DataProcessingError(f"Missing file path for '{filename or 'unknown file'}'.")
    if not os.path.isfile(path):
        raise DataProcessingError(f"File not found in browser runtime: {path}")

    # Reuse the same robust loader as the plot workflow so FAMAS-style CSVs
    # and encoded lab exports behave consistently across both tools.
    df = load_plot_dataframe(path)
    metadata = {}
    if path.lower().endswith(".csv"):
        metadata = parse_famas_metadata(path)
    if not metadata:
        metadata = df.attrs.get("famasMetadata", {}) or {}
    if not metadata:
        metadata = {"sourceFormat": "generic_table"}

    droplet_traces = extract_cmc_droplet_traces(df, metadata)
    droplet_qc = [
        compute_droplet_plateau_qc(
            trace,
            mode=qc_options["plateauMode"],
            t_min=t_min,
            t_max=t_max,
            options=qc_options,
        )
        for trace in droplet_traces
    ]
    mark_outliers_within_concentration(droplet_qc)

    droplet_payloads = [
        _payload_value({
            **trace.to_payload(),
            "filename": filename,
            "path": path,
            "qc": qc.to_payload(),
            "usedForAggregate": qc.used_for_aggregate,
            "excludeReason": qc.exclude_reason,
        })
        for trace, qc in zip(droplet_traces, droplet_qc)
    ]
    file_payload = {
        "filename": filename,
        "path": path,
        "metadata": _payload_value(metadata),
        "detectedDropletCount": len(droplet_traces),
        "acceptedDropletCount": sum(1 for qc in droplet_qc if qc.used_for_aggregate),
        "warningCount": sum(1 for qc in droplet_qc if qc.flags),
        "droplets": droplet_payloads,
    }
    return file_payload, droplet_traces, droplet_qc


def _build_cmc_review_payload(
    entries: list[dict[str, Any]],
    t_min_text: str,
    t_max_text: str,
    options: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not entries:
        raise DataProcessingError("Please choose at least one file.")

    t_min, t_max = _parse_cmc_time_range(t_min_text, t_max_text)
    qc_options = normalize_cmc_qc_options(options)

    files: list[dict[str, Any]] = []
    internals: list[dict[str, Any]] = []
    for file_index, entry in enumerate(entries):
        file_payload, droplet_traces, droplet_qc = _load_cmc_file_review(
            entry,
            t_min=t_min,
            t_max=t_max,
            qc_options=qc_options,
        )
        for droplet in file_payload["droplets"]:
            droplet["fileIndex"] = file_index
        files.append(file_payload)
        internals.append({
            "entry": entry,
            "file": file_payload,
            "traces": droplet_traces,
            "qc": droplet_qc,
        })

    flat_droplets = [
        droplet
        for file_payload in files
        for droplet in file_payload["droplets"]
    ]
    review_payload = {
        "files": files,
        "droplets": flat_droplets,
        "qc": [droplet.get("qc", {}) for droplet in flat_droplets],
        "options": _payload_value(qc_options),
        "summary": {
            "fileCount": len(files),
            "dropletCount": len(flat_droplets),
            "acceptedDropletCount": sum(1 for droplet in flat_droplets if droplet.get("usedForAggregate")),
            "warningCount": sum(1 for droplet in flat_droplets if (droplet.get("qc") or {}).get("flags")),
            "timeWindow": [_finite_or_none(t_min), _finite_or_none(t_max)],
            "plateauMode": qc_options["plateauMode"],
        },
    }
    return review_payload, internals


def review_cmc_files(
    entries: list[dict[str, Any]],
    t_min_text: str,
    t_max_text: str,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    review_payload, _ = _build_cmc_review_payload(entries, t_min_text, t_max_text, options)
    return review_payload


def _aggregate_qc_payloads(qc_payloads: list[dict[str, Any]], aggregation_method: str) -> dict[str, Any]:
    values = np.asarray(
        [
            float(qc.get("gammaEq"))
            for qc in qc_payloads
            if qc.get("usedForAggregate")
            and qc.get("gammaEq") is not None
            and math.isfinite(float(qc.get("gammaEq")))
        ],
        dtype=float,
    )
    method = aggregation_method if aggregation_method in ("mean", "median") else "mean"
    droplet_count = len(qc_payloads)
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
    return {
        "gammaMean": gamma_mean,
        "gammaMedian": gamma_median,
        "gammaStd": gamma_std,
        "gammaSe": gamma_se,
        "gammaMad": gamma_mad,
        "sigmaMean": gamma_mean,
        "sigmaMedian": gamma_median,
        "sigmaStd": gamma_std,
        "sigmaSe": gamma_se,
        "sigmaMad": gamma_mad,
        "dropletCount": droplet_count,
        "usedDropletCount": used_count,
        "aggregationMethod": method,
        "gammaValue": gamma_value,
        "sigmaValue": gamma_value,
        "errorValue": error_value,
        "errorMetric": error_metric,
    }


def _review_concentration_map(plot_options: dict[str, Any]) -> dict[str, float]:
    mapping: dict[str, float] = {}
    concentration_entries = plot_options.get("concentrations") or plot_options.get("entries") or []
    for idx, item in enumerate(concentration_entries):
        filename = str(item.get("filename", "")).strip()
        path = str(item.get("path", "")).strip()
        concentration_text = str(item.get("concentration", "")).strip()
        if not concentration_text:
            raise DataProcessingError(f"Concentration is required for '{filename or path or 'unknown file'}'.")
        try:
            concentration = float(concentration_text)
        except ValueError as exc:
            raise DataProcessingError(
                f"Concentration for '{filename or path or 'unknown file'}' must be numeric."
            ) from exc
        if concentration < 0:
            raise DataProcessingError(f"Concentration for '{filename or path or 'unknown file'}' must be >= 0.")
        if path:
            mapping[f"path:{path}"] = concentration
        if filename:
            mapping[f"filename:{filename}"] = concentration
        mapping[f"index:{idx}"] = concentration
    return mapping


def _concentration_for_file(file_payload: dict[str, Any], index: int, concentration_map: dict[str, float]) -> float:
    path = str(file_payload.get("path", "")).strip()
    filename = str(file_payload.get("filename", "")).strip()
    for key in (f"path:{path}", f"index:{index}", f"filename:{filename}"):
        if key in concentration_map:
            return concentration_map[key]
    value = file_payload.get("concentration")
    if value is not None:
        try:
            numeric = float(value)
        except (TypeError, ValueError) as exc:
            raise DataProcessingError(f"Concentration for '{filename or path}' must be numeric.") from exc
        if numeric >= 0:
            return numeric
    raise DataProcessingError(f"Concentration is required for '{filename or path or 'unknown file'}'.")


def build_cmc_plot_payload_from_review(
    review_payload: dict[str, Any],
    plot_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    plot_options = plot_options or {}
    qc_options = normalize_cmc_qc_options({
        **(review_payload.get("options") or {}),
        **plot_options,
    })
    use_log = bool(plot_options.get("useLog", plot_options.get("plotUseLog", False)))
    c_unit = str(plot_options.get("cUnit", plot_options.get("concentrationUnit", "")) or "")
    concentration_map = _review_concentration_map(plot_options)

    rows: list[dict[str, Any]] = []
    skipped_files: list[dict[str, Any]] = []
    files = list(review_payload.get("files") or [])
    for file_index, file_payload in enumerate(files):
        filename = str(file_payload.get("filename", "")).strip()
        path = str(file_payload.get("path", "")).strip()
        concentration = _concentration_for_file(file_payload, file_index, concentration_map)
        droplets = list(file_payload.get("droplets") or [])
        qc_payloads = [droplet.get("qc") or {} for droplet in droplets]
        try:
            aggregate = _aggregate_qc_payloads(qc_payloads, str(qc_options["aggregationMethod"]))
        except DataProcessingError:
            skipped_files.append({
                "filename": filename,
                "path": path,
                "concentration": concentration,
                "reason": "No droplets are currently marked Used for aggregation.",
            })
            continue
        warning_count = sum(1 for qc in qc_payloads if qc.get("flags"))
        file_with_aggregate = {
            **file_payload,
            "concentration": concentration,
            "aggregate": _payload_value(aggregate),
        }

        rows.append({
            "filename": filename,
            "path": path,
            "concentration": concentration,
            "gammaMean": aggregate["gammaMean"],
            "gammaMedian": aggregate["gammaMedian"],
            "gammaStd": aggregate["gammaStd"],
            "gammaSe": aggregate["gammaSe"],
            "gammaMad": aggregate["gammaMad"],
            "gammaValue": aggregate["gammaValue"],
            "gammaError": aggregate["errorValue"],
            "gammaErrorMetric": aggregate["errorMetric"],
            "sigmaMean": aggregate["sigmaMean"],
            "sigmaMedian": aggregate["sigmaMedian"],
            "sigmaStd": aggregate["sigmaStd"],
            "sigmaSe": aggregate["sigmaSe"],
            "sigmaMad": aggregate["sigmaMad"],
            "sigmaValue": aggregate["sigmaValue"],
            "sigmaError": aggregate["errorValue"],
            "dropletCount": aggregate["dropletCount"],
            "usedDropletCount": aggregate["usedDropletCount"],
            "aggregationMethod": aggregate["aggregationMethod"],
            "usedForAggregate": aggregate["usedDropletCount"] > 0,
            "warningCount": warning_count,
            "file": file_with_aggregate,
        })

    if not rows:
        skipped_names = ", ".join(item["filename"] or item["path"] for item in skipped_files)
        raise DataProcessingError(
            "No CMC plot points could be generated. "
            f"No droplets are marked Used in: {skipped_names or 'all files'}."
        )

    c_arr = np.asarray([row["concentration"] for row in rows], dtype=float)
    if use_log:
        x_arr = np.full_like(c_arr, np.nan, dtype=float)
        positive_mask = c_arr > 0
        x_arr[positive_mask] = np.log10(c_arr[positive_mask])
        x_label = f"log10 C ({c_unit})" if c_unit else "log10 C"
    else:
        x_arr = c_arr
        x_label = f"Concentration C ({c_unit})" if c_unit else "Concentration C"

    order = np.argsort(np.where(np.isfinite(x_arr), x_arr, np.inf))
    plot_rows = [rows[int(idx)] for idx in order.tolist()]
    x_sorted = x_arr[order]
    point_payload = [
        {
            "x": _finite_or_none(x_sorted[idx]),
            "y": _finite_or_none(plot_rows[idx]["gammaValue"]),
            "error": _finite_or_none(plot_rows[idx]["gammaError"]),
            "errorMetric": plot_rows[idx]["gammaErrorMetric"],
            "sigmaValue": _finite_or_none(plot_rows[idx]["sigmaValue"]),
            "sigmaError": _finite_or_none(plot_rows[idx]["sigmaError"]),
            "filename": plot_rows[idx]["filename"],
            "concentration": _finite_or_none(plot_rows[idx]["concentration"]),
            "dropletCount": int(plot_rows[idx]["dropletCount"]),
            "usedDropletCount": int(plot_rows[idx]["usedDropletCount"]),
            "aggregationMethod": plot_rows[idx]["aggregationMethod"],
            "warningCount": int(plot_rows[idx]["warningCount"]),
        }
        for idx in range(len(plot_rows))
    ]
    row_payload = [
        {
            "filename": row["filename"],
            "concentration": _finite_or_none(row["concentration"]),
            "gammaMean": _finite_or_none(row["gammaMean"]),
            "gammaMedian": _finite_or_none(row["gammaMedian"]),
            "gammaStd": _finite_or_none(row["gammaStd"]),
            "gammaSe": _finite_or_none(row["gammaSe"]),
            "gammaMad": _finite_or_none(row["gammaMad"]),
            "gammaValue": _finite_or_none(row["gammaValue"]),
            "gammaError": _finite_or_none(row["gammaError"]),
            "gammaErrorMetric": row["gammaErrorMetric"],
            "sigmaMean": _finite_or_none(row["sigmaMean"]),
            "sigmaMedian": _finite_or_none(row["sigmaMedian"]),
            "sigmaStd": _finite_or_none(row["sigmaStd"]),
            "sigmaSe": _finite_or_none(row["sigmaSe"]),
            "sigmaMad": _finite_or_none(row["sigmaMad"]),
            "sigmaValue": _finite_or_none(row["sigmaValue"]),
            "sigmaError": _finite_or_none(row["sigmaError"]),
            "dropletCount": int(row["dropletCount"]),
            "usedDropletCount": int(row["usedDropletCount"]),
            "aggregationMethod": row["aggregationMethod"],
            "usedForAggregate": bool(row["usedForAggregate"]),
            "warningCount": int(row["warningCount"]),
        }
        for row in plot_rows
    ]
    fit_options = {
        **qc_options,
        "plotUseLog": bool(use_log),
    }
    if qc_options["fitModel"] == "none":
        fit_payload = {
            "modelKey": "none",
            "modelLabel": "No fit",
            "transitionLabel": None,
            "fitSeries": [],
            "fitSegments": [],
            "cmcMarker": None,
            "sigmaAtCmc": None,
            "gammaAtCmc": None,
            "warnings": [],
        }
    else:
        fit_payload = fit_cmc_curve(point_payload, fit_options)

    warnings = []
    if skipped_files:
        warnings.append({
            "code": "FILES_SKIPPED_NO_USED_DROPLETS",
            "message": "Files without any Used droplets were skipped for CMC plotting.",
            "files": skipped_files,
        })
        if isinstance(fit_payload, dict):
            fit_payload.setdefault("warnings", [])
            fit_payload["warnings"].extend(warnings)

    return {
        "xLabel": x_label,
        "useLog": bool(use_log),
        "points": point_payload,
        "rows": row_payload,
        "files": [row["file"] for row in plot_rows],
        "fit": _payload_value(fit_payload),
        "options": _payload_value(qc_options),
        "warnings": _payload_value(warnings),
        "skippedFiles": _payload_value(skipped_files),
        "summary": {
            "fileCount": len(plot_rows),
            "skippedFileCount": len(skipped_files),
            "timeWindow": (review_payload.get("summary") or {}).get("timeWindow"),
            "plateauMode": qc_options["plateauMode"],
            "aggregationMethod": qc_options["aggregationMethod"],
        },
    }


def analyze_cmc_files(
    entries: list[dict[str, Any]],
    t_min_text: str,
    t_max_text: str,
    c_unit: str,
    use_log: bool,
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    review_payload, _ = _build_cmc_review_payload(entries, t_min_text, t_max_text, options)
    plot_options = {
        **(options or {}),
        "cUnit": c_unit,
        "useLog": bool(use_log),
        "concentrations": [
            {
                "filename": str(entry.get("filename", "")).strip(),
                "path": str(entry.get("path", "")).strip(),
                "concentration": str(entry.get("concentration", "")).strip(),
            }
            for entry in entries
        ],
    }
    return build_cmc_plot_payload_from_review(review_payload, plot_options)
