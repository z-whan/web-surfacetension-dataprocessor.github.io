import csv
import io
import os
from typing import Iterable, Tuple

import pandas as pd

from DataProcessor.services.errors import DataProcessingError
from DataProcessor.utils.encoding import detect_encoding

_TIME_KEYWORDS = ("時間", "Time", "time")
_COMMON_DELIMITERS = (",", ";", "\t", "|")


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


def try_parse_famas_multi_experiment_csv(csv_path: str) -> pd.DataFrame | None:
    """Normalize two-row-header FAMAS exports to plot-friendly columns."""
    with open(csv_path, "rb") as handle:
        raw = handle.read()

    text = None
    for encoding in ("shift_jis", "utf-8", "cp932"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue

    if text is None:
        return None

    rows = list(csv.reader(io.StringIO(text)))
    header_idx = None
    for idx, row in enumerate(rows):
        has_time = any("時間(ms)" in (cell or "") for cell in row)
        has_it = any("I.T" in (cell or "") for cell in row)
        if has_time and has_it:
            header_idx = idx
            break

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
    avg_idx: int | None = None

    for col_idx, (pfx, col_name) in enumerate(zip(prefix, header)):
        if (col_name or "").strip() != "I.T.(mN/m)":
            continue

        tag = (pfx or "").strip()
        if tag.isdigit():
            experiment_cols.append((int(tag), col_idx))
        elif tag.lower().startswith("avg"):
            avg_idx = col_idx

    if not experiment_cols:
        return None

    experiment_cols.sort(key=lambda item: item[0])
    max_col = max(
        [time_idx] + [idx for _, idx in experiment_cols] + ([avg_idx] if avg_idx is not None else [])
    )

    data_rows = []
    for row in rows[header_idx + 1 :]:
        if len(row) <= time_idx:
            break
        t_val = row[time_idx]
        if t_val is None or str(t_val).strip() == "":
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
        out[f"I.T.(mN/m).{exp_num}"] = pd.to_numeric(
            [row[col_idx] if col_idx < len(row) else "" for row in data_rows],
            errors="coerce",
        )

    if avg_idx is not None:
        out["Avg"] = pd.to_numeric(
            [row[avg_idx] if avg_idx < len(row) else "" for row in data_rows],
            errors="coerce",
        )

    df = pd.DataFrame(out)
    valid_time = df["時間(ms)"].notna().sum()
    if valid_time < max(5, int(0.5 * len(df))):
        return None

    return df


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
