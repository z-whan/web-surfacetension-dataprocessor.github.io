import csv
import io
import os
from typing import Iterable, Tuple

import pandas as pd

from DataProcessor.services.errors import DataProcessingError
from DataProcessor.utils.encoding import detect_encoding

_TIME_KEYWORDS = ("時間", "Time", "time")
_COMMON_DELIMITERS = (",", ";", "\t", "|")


def _numeric_or_none(value) -> float | int | None:
    numeric = pd.to_numeric(value, errors="coerce")
    if pd.isna(numeric):
        return None
    number = float(numeric)
    if number.is_integer():
        return int(number)
    return number


def _decode_csv_text(csv_path: str) -> str | None:
    with open(csv_path, "rb") as handle:
        raw = handle.read()

    for encoding in ("shift_jis", "cp932", "utf-8-sig", "utf-8"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue

    return None


def _csv_rows_from_famas_file(csv_path: str) -> list[list[str]] | None:
    text = _decode_csv_text(csv_path)
    if text is None:
        return None
    return list(csv.reader(io.StringIO(text)))


def _read_head_lines(path: str, encoding: str, limit: int = 200) -> list[str]:
    lines: list[str] = []
    with open(path, "r", encoding=encoding, errors="replace") as handle:
        for _ in range(limit):
            line = handle.readline()
            if not line:
                break
            lines.append(line.rstrip("\n\r"))
    return lines


def _guess_delimiter_and_skiprows(
    path: str,
    encoding: str,
    delimiters: Iterable[str] = _COMMON_DELIMITERS,
) -> Tuple[str, int]:
    lines = _read_head_lines(path, encoding, limit=50)
    if not lines:
        return ",", 0

    sample = "\n".join(lines)
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters="".join(delimiters))
        delimiter = dialect.delimiter
    except csv.Error:
        scores = {d: 0 for d in delimiters}
        for line in lines:
            for d in delimiters:
                scores[d] += line.count(d)
        delimiter = max(scores, key=scores.get)

    skiprows = 0
    for idx, line in enumerate(lines):
        if line.count(delimiter) >= 1:
            skiprows = idx
            break

    return delimiter, skiprows


def _find_header_row(lines: list[str]) -> tuple[int | None, str]:
    header_idx = None
    delimiter_guess = ","

    for idx, line in enumerate(lines):
        if not line.strip():
            continue

        sep_candidates = [",", "\t", ";", "|"]
        counts = {sep: line.count(sep) for sep in sep_candidates}
        delimiter = max(counts, key=counts.get)
        fields = [item.strip() for item in line.split(delimiter)]

        has_time_keyword = any(keyword in line for keyword in _TIME_KEYWORDS)
        if has_time_keyword and len(fields) >= 2:
            header_idx = idx
            delimiter_guess = delimiter
            break

    return header_idx, delimiter_guess


def _find_famas_worksheet_header(rows: list[list[str]]) -> int | None:
    for idx, row in enumerate(rows):
        has_time = any("時間(ms)" in (cell or "") for cell in row)
        has_it = any("I.T" in (cell or "") for cell in row)
        if has_time and has_it:
            return idx
    return None


def _normalized_metadata_value(raw_items: dict[str, str], patterns: tuple[str, ...]):
    for key, value in raw_items.items():
        key_norm = key.strip().lower().replace(" ", "")
        if any(pattern in key_norm or pattern in key for pattern in patterns):
            return value
    return None


def _time_value_to_ms(value, key: str = "") -> float | int | None:
    numeric = _numeric_or_none(value)
    if numeric is None:
        return None

    key_norm = key.lower()
    if "ms" in key_norm or "msec" in key_norm or "ミリ" in key or "毫秒" in key:
        return numeric
    if "sec" in key_norm or "(s" in key_norm or "秒" in key:
        return float(numeric) * 1000
    return numeric


def _first_numeric_from_columns(
    rows: list[list[str]],
    header_idx: int,
    header_names: tuple[str, ...],
) -> float | int | None:
    header = rows[header_idx]
    col_indexes = [
        idx
        for idx, cell in enumerate(header)
        if (cell or "").strip() in header_names
    ]
    if not col_indexes:
        return None

    for row in rows[header_idx + 1 :]:
        first = (row[0] if row else "").strip()
        if first.startswith("[") and first.endswith("]"):
            break
        for col_idx in col_indexes:
            if col_idx >= len(row):
                continue
            numeric = _numeric_or_none(row[col_idx])
            if numeric is not None:
                return numeric
    return None


def _positive_time_deltas_ms(rows: list[list[str]], header_idx: int) -> list[float]:
    header = rows[header_idx]
    try:
        time_idx = next(i for i, cell in enumerate(header) if (cell or "").strip() == "時間(ms)")
    except StopIteration:
        return []

    times: list[float] = []
    for row in rows[header_idx + 1 :]:
        first = (row[0] if row else "").strip()
        if first.startswith("[") and first.endswith("]"):
            break
        if time_idx >= len(row):
            continue
        numeric = _numeric_or_none(row[time_idx])
        if numeric is not None:
            times.append(float(numeric))

    return [
        times[idx] - times[idx - 1]
        for idx in range(1, len(times))
        if times[idx] > times[idx - 1]
    ]


def _count_famas_measurement_rows(rows: list[list[str]], header_idx: int) -> int:
    count = 0
    for row in rows[header_idx + 1 :]:
        first = (row[0] if row else "").strip()
        if not first or (first.startswith("[") and first.endswith("]")):
            break
        count += 1
    return count


def _count_famas_experiments(rows: list[list[str]], header_idx: int) -> int | None:
    if header_idx == 0:
        return None

    header = rows[header_idx]
    prefix = rows[header_idx - 1]
    if len(prefix) < len(header):
        prefix = [""] * (len(header) - len(prefix)) + prefix
    elif len(prefix) > len(header):
        prefix = prefix[-len(header) :]

    indexes = {
        int((pfx or "").strip())
        for pfx, col_name in zip(prefix, header)
        if (pfx or "").strip().isdigit()
        and (col_name or "").strip() == "I.T.(mN/m)"
    }
    return len(indexes) if indexes else None


def parse_famas_metadata(csv_path: str) -> dict[str, object]:
    """Extract normalized metadata from a FAMAS CSV when recognizable."""
    rows = _csv_rows_from_famas_file(csv_path)
    if rows is None:
        return {}

    header_idx = _find_famas_worksheet_header(rows)
    if header_idx is None or header_idx == 0:
        return {}

    raw_items: dict[str, str] = {}
    for row in rows[:header_idx]:
        cleaned = [str(cell).strip() for cell in row if str(cell).strip()]
        if not cleaned:
            continue
        if cleaned[0].startswith("[") and cleaned[0].endswith("]"):
            continue
        if len(cleaned) >= 2:
            raw_items[cleaned[0]] = cleaned[1]

    analysis_method = _normalized_metadata_value(
        raw_items,
        ("analysismethod", "method", "解析法", "測定法", "測定方法", "メソッド"),
    )
    measurement_interval_raw = _normalized_metadata_value(
        raw_items,
        ("measurementinterval", "interval", "測定間隔", "間隔"),
    )
    measurement_count_raw = _normalized_metadata_value(
        raw_items,
        ("measurementcount", "pointcount", "測定点数", "測定数"),
    )
    wait_before_raw = _normalized_metadata_value(
        raw_items,
        ("waitbeforemeasurement", "waittime", "待機時間", "測定待ち", "待ち時間"),
    )
    target_volume_raw = _normalized_metadata_value(
        raw_items,
        ("targetdropvolume", "targetvolume", "滴下量", "液滴量", "目標体積"),
    )
    repeat_count_raw = _normalized_metadata_value(
        raw_items,
        ("repeatcount", "repeats", "繰返", "繰り返", "反復"),
    )
    density_raw = _normalized_metadata_value(
        raw_items,
        ("densitydelta", "densitydifference", "d(g/cm^3)", "密度差"),
    )

    deltas = _positive_time_deltas_ms(rows, header_idx)
    measurement_interval = _time_value_to_ms(
        measurement_interval_raw,
        next((key for key in raw_items if raw_items[key] == measurement_interval_raw), ""),
    )
    if measurement_interval is None and deltas:
        measurement_interval = float(pd.Series(deltas).median())

    measurement_count = _numeric_or_none(measurement_count_raw)
    if measurement_count is None:
        measurement_count = _count_famas_measurement_rows(rows, header_idx)

    repeat_count = _numeric_or_none(repeat_count_raw)
    if repeat_count is None:
        repeat_count = _count_famas_experiments(rows, header_idx)

    density_delta = _numeric_or_none(density_raw)
    if density_delta is None:
        density_delta = _first_numeric_from_columns(rows, header_idx, ("d(g/cm^3)",))

    metadata: dict[str, object] = {
        "sourceFormat": "famas_multi_experiment_csv",
        "analysisMethod": analysis_method,
        "measurementIntervalMs": measurement_interval,
        "measurementCount": measurement_count,
        "waitBeforeMeasurementMs": _time_value_to_ms(
            wait_before_raw,
            next((key for key in raw_items if raw_items[key] == wait_before_raw), ""),
        ),
        "targetDropVolumeUL": _numeric_or_none(target_volume_raw),
        "repeatCount": repeat_count,
        "densityDeltaGPerCm3": density_delta,
        "raw": raw_items,
    }
    return metadata


def try_parse_famas_multi_experiment_csv(csv_path: str) -> pd.DataFrame | None:
    """Normalize two-row-header FAMAS exports to plot-friendly columns."""
    rows = _csv_rows_from_famas_file(csv_path)
    if rows is None:
        return None

    header_idx = _find_famas_worksheet_header(rows)
    if header_idx is None or header_idx == 0:
        return None

    header = rows[header_idx]
    prefix = rows[header_idx - 1]
    if len(prefix) < len(header):
        prefix = [""] * (len(header) - len(prefix)) + prefix
    elif len(prefix) > len(header):
        prefix = prefix[-len(header) :]

    try:
        time_idx = next(i for i, cell in enumerate(header) if (cell or "").strip() == "時間(ms)")
    except StopIteration:
        return None

    experiment_cols: list[tuple[int, int]] = []
    volume_cols: list[tuple[int, int]] = []
    avg_idx: int | None = None

    for col_idx, (pfx, col_name) in enumerate(zip(prefix, header)):
        name = (col_name or "").strip()
        if name not in ("I.T.(mN/m)", "V(uL)"):
            continue

        tag = (pfx or "").strip()
        if tag.isdigit():
            if name == "I.T.(mN/m)":
                experiment_cols.append((int(tag), col_idx))
            else:
                volume_cols.append((int(tag), col_idx))
        elif name == "I.T.(mN/m)" and tag.lower().startswith("avg"):
            avg_idx = col_idx

    if not experiment_cols:
        return None

    experiment_cols.sort(key=lambda item: item[0])
    volume_cols.sort(key=lambda item: item[0])
    max_col = max(
        [time_idx]
        + [idx for _, idx in experiment_cols]
        + [idx for _, idx in volume_cols]
        + ([avg_idx] if avg_idx is not None else [])
    )

    data_rows = []
    for row in rows[header_idx + 1 :]:
        if len(row) <= time_idx:
            break
        t_val = row[time_idx]
        t_text = str(t_val).strip() if t_val is not None else ""
        if not t_text or (t_text.startswith("[") and t_text.endswith("]")):
            break
        data_rows.append(row[: max_col + 1])

    if not data_rows:
        return None

    out: dict[str, pd.Series] = {}
    out["時間(ms)"] = pd.to_numeric(
        [row[time_idx] if time_idx < len(row) else "" for row in data_rows],
        errors="coerce",
    )

    for exp_num, col_idx in experiment_cols:
        out[f"I.T.(mN/m).{exp_num}"] = pd.Series(
            [row[col_idx] if col_idx < len(row) else "" for row in data_rows]
        )

    for exp_num, col_idx in volume_cols:
        out[f"V(uL).{exp_num}"] = pd.Series(
            [row[col_idx] if col_idx < len(row) else "" for row in data_rows]
        )

    if avg_idx is not None:
        out["Avg"] = pd.Series(
            [row[avg_idx] if avg_idx < len(row) else "" for row in data_rows]
        )

    df = pd.DataFrame(out)
    valid_time = df["時間(ms)"].notna().sum()
    if valid_time < max(1, int(0.5 * len(df))):
        return None

    df.attrs["sourceFormat"] = "famas_multi_experiment_csv"
    df.attrs["famasMetadata"] = parse_famas_metadata(csv_path)
    return df


def parse_famas_measurement_detail_volumes(csv_path: str) -> dict[int, list[dict[str, float | int | None]]]:
    """Extract high-precision measurement-detail droplet volumes from FAMAS CSV."""
    rows = _csv_rows_from_famas_file(csv_path)
    if rows is None:
        return {}

    header_idx = None
    it_idx = None
    volume_idx = None
    in_detail_section = False
    for idx, row in enumerate(rows):
        first = (row[0] if row else "").strip()
        if first.startswith("[") and first.endswith("]"):
            in_detail_section = first == "[DETAIL]"
            continue
        if not in_detail_section:
            continue

        maybe_it_idx = next(
            (col_idx for col_idx, cell in enumerate(row) if (cell or "").strip() == "I.T.(mN/m)"),
            None,
        )
        maybe_volume_idx = next(
            (col_idx for col_idx, cell in enumerate(row) if (cell or "").strip() == "V(uL)"),
            None,
        )
        if maybe_it_idx is not None and maybe_volume_idx is not None:
            header_idx = idx
            it_idx = maybe_it_idx
            volume_idx = maybe_volume_idx
            break

    if header_idx is None or it_idx is None or volume_idx is None:
        return {}

    detail: dict[int, list[dict[str, float | int | None]]] = {}
    for row in rows[header_idx + 1 :]:
        first = (row[0] if row else "").strip()
        if first.startswith("[") and first.endswith("]"):
            break
        if not first:
            continue
        try:
            row_index = int(float(first))
            experiment_index = int(float(row[1]))
        except (IndexError, ValueError):
            continue

        volume = pd.to_numeric(row[volume_idx] if volume_idx < len(row) else None, errors="coerce")
        surface_tension = pd.to_numeric(row[it_idx] if it_idx < len(row) else None, errors="coerce")
        detail.setdefault(experiment_index, []).append(
            {
                "rowIndex": row_index,
                "experimentIndex": experiment_index,
                "surfaceTension": float(surface_tension) if pd.notna(surface_tension) else None,
                "volume": float(volume) if pd.notna(volume) else None,
            }
        )

    return detail


def read_csv_robust(csv_path: str) -> pd.DataFrame:
    if not os.path.isfile(csv_path):
        raise FileNotFoundError(f"File not found: {csv_path}")

    primary_encoding = detect_encoding(csv_path)
    attempted_configs: list[str] = []

    lines = _read_head_lines(csv_path, primary_encoding, limit=200)
    header_idx, header_sep = _find_header_row(lines)

    if header_idx is not None:
        try:
            return pd.read_csv(
                csv_path,
                encoding=primary_encoding,
                engine="python",
                sep=header_sep,
                skiprows=header_idx,
            )
        except Exception as exc:  # pandas parser errors vary by version
            attempted_configs.append(f"header strategy ({primary_encoding}, {header_sep}): {exc}")

    try:
        return pd.read_csv(csv_path, encoding=primary_encoding, engine="python", sep=None)
    except Exception as exc:
        attempted_configs.append(f"auto sep ({primary_encoding}): {exc}")

    delim, skiprows = _guess_delimiter_and_skiprows(csv_path, primary_encoding)
    try:
        return pd.read_csv(
            csv_path,
            encoding=primary_encoding,
            engine="python",
            sep=delim,
            skiprows=skiprows,
        )
    except Exception as exc:
        attempted_configs.append(f"sniff sep ({primary_encoding}, {delim}): {exc}")

    fallback_encodings = ("utf-8-sig", "utf-8", "shift_jis", "cp932", "gb18030", "latin1")
    for fallback in fallback_encodings:
        try:
            delim, skiprows = _guess_delimiter_and_skiprows(csv_path, fallback)
            return pd.read_csv(
                csv_path,
                encoding=fallback,
                engine="python",
                sep=delim,
                skiprows=skiprows,
            )
        except Exception as exc:
            attempted_configs.append(f"fallback ({fallback}, {delim}): {exc}")

    raise DataProcessingError(
        "Failed to parse CSV. Tried multiple encodings/delimiters. "
        "Please check the file format and header rows."
    )


def read_table_robust(path: str) -> pd.DataFrame:
    if not os.path.isfile(path):
        raise FileNotFoundError(f"File not found: {path}")

    lower = path.lower()
    if lower.endswith((".xlsx", ".xls")):
        return pd.read_excel(path)
    if lower.endswith(".csv"):
        return read_csv_robust(path)

    raise DataProcessingError(f"Unsupported file type: {path}")


def load_plot_dataframe(path: str) -> pd.DataFrame:
    """Prefer FAMAS multi-experiment normalization when available."""
    lower = path.lower()
    if lower.endswith(".csv"):
        famas = try_parse_famas_multi_experiment_csv(path)
        if famas is not None:
            return famas
    return read_table_robust(path)
