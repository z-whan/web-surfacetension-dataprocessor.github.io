from dataclasses import dataclass
import re
from typing import Sequence

import numpy as np
import pandas as pd

from DataProcessor.services.errors import DataProcessingError


@dataclass
class PlotDataset:
    x_label: str
    x_values: pd.Series
    y_values: pd.DataFrame
    plot_values: pd.DataFrame
    exp_tag: str
    row_range: tuple[int, int]
    default_exp_range: str | None = None


_IT_PATTERN = re.compile(r"^I\.?T\.?\s*\(mN\s*/\s*m\)(?:\.(\d+))?$", re.IGNORECASE)


def _normalize_col(name: str) -> str:
    return re.sub(r"[\s\._\-/()]+", "", str(name)).lower()


def find_time_column(columns: Sequence[object]) -> object:
    preferred = []
    for col in columns:
        text = str(col).strip().lower().replace(" ", "")
        if text in ("時間(ms)", "time(ms)"):
            preferred.append(col)

    if preferred:
        return preferred[0]

    for col in columns:
        if "時間" in str(col):
            return col
        if re.search(r"\btime\b", str(col), flags=re.IGNORECASE):
            return col

    raise DataProcessingError("No time column found (expected '時間(ms)' or 'Time (ms)').")


def _extract_it_columns_and_avg(columns: Sequence[object]) -> tuple[list[object], object | None]:
    numbered: list[tuple[int, object]] = []
    avg_col = None

    for col in columns:
        name = str(col).strip()
        normalized = _normalize_col(name)

        if name == "Avg" or normalized in (
            "avg",
            "average",
            "mean",
            "平均",
            "平均值",
            "平均値",
            "avgmnm",
            "averagemnm",
        ):
            avg_col = col
            continue

        match = _IT_PATTERN.match(name)
        if not match:
            continue

        if match.group(1):
            numbered.append((int(match.group(1)), col))
        else:
            numbered.append((len(numbered) + 1, col))

    numbered.sort(key=lambda item: item[0])

    continuous: list[tuple[int, object]] = []
    expected = 1
    for idx, col in numbered:
        if idx == expected:
            continuous.append((idx, col))
            expected += 1
        elif idx > expected:
            break

    ordered_cols = [col for _, col in continuous]
    return ordered_cols, avg_col


def parse_experiment_range(range_text: str, n_experiments: int) -> list[int]:
    if n_experiments <= 0:
        raise DataProcessingError("No experiment columns found.")

    cleaned = range_text.strip()
    if not cleaned:
        return list(range(1, n_experiments + 1))

    selected: list[int] = []
    try:
        parts = [part.strip() for part in cleaned.split(",") if part.strip()]
        for part in parts:
            if "-" in part:
                left, right = part.split("-", 1)
                a, b = int(left), int(right)
                if a <= 0 or b <= 0 or a > b:
                    raise ValueError
                selected.extend(range(a, b + 1))
            else:
                idx = int(part)
                if idx <= 0:
                    raise ValueError
                selected.append(idx)
    except ValueError as exc:
        raise DataProcessingError(
            f"Invalid experiment range '{range_text}'. Use '1-3' or '1,3,5' or '1-2,5'."
        ) from exc

    seen = set()
    selected = [idx for idx in selected if not (idx in seen or seen.add(idx))]
    selected = [idx for idx in selected if 1 <= idx <= n_experiments]

    if not selected:
        raise DataProcessingError(
            f"Experiment range '{range_text}' does not select any valid columns (1-{n_experiments})."
        )

    return selected


def _find_longest_true_run(mask: np.ndarray) -> tuple[int, int] | None:
    best: tuple[int, int] | None = None
    run_start: int | None = None

    for idx, flag in enumerate(mask):
        if flag and run_start is None:
            run_start = idx
        elif not flag and run_start is not None:
            current = (run_start, idx - 1)
            if best is None or (current[1] - current[0]) > (best[1] - best[0]):
                best = current
            run_start = None

    if run_start is not None:
        current = (run_start, len(mask) - 1)
        if best is None or (current[1] - current[0]) > (best[1] - best[0]):
            best = current

    return best


def _resolve_row_bounds(
    x_values: pd.Series,
    y_values: pd.DataFrame,
    start_text: str,
    end_text: str,
) -> tuple[int, int, tuple[int, int]]:
    start = start_text.strip()
    end = end_text.strip()

    if not start and not end:
        valid_x = np.isfinite(x_values.to_numpy())
        valid_y = np.isfinite(y_values.to_numpy()).any(axis=1)
        valid = valid_x & valid_y

        if not valid.any():
            raise DataProcessingError(
                "Could not find any rows with valid time and I.T.(mN/m) values."
            )

        run = _find_longest_true_run(valid)
        if run is None:
            raise DataProcessingError("Could not determine a continuous numeric segment to plot.")

        s, e_inclusive = run
        e = e_inclusive + 1
        return s, e, (s + 1, e)

    try:
        s = int(start) - 1 if start else 0
        e = int(end) if end else len(x_values)
    except ValueError as exc:
        raise DataProcessingError("Row range is invalid. Please enter numeric values.") from exc

    if s < 0 or e <= 0:
        raise DataProcessingError("Row range must be positive and start < end.")

    e = min(e, len(x_values))
    if s >= e:
        raise DataProcessingError("Row range is empty after applying boundaries.")

    return s, e, (s + 1, e)


def prepare_plot_dataset(
    df: pd.DataFrame,
    start_text: str,
    end_text: str,
    exp_range_text: str,
    avg_only: bool,
    show_original_with_avg: bool = False,
) -> PlotDataset:
    time_col = find_time_column(df.columns)
    x_raw = pd.to_numeric(df[time_col], errors="coerce")
    x_label_raw = str(time_col).strip()
    x_label = "Time (ms)" if x_label_raw.replace(" ", "") == "時間(ms)" else x_label_raw

    ordered_it_cols, avg_col = _extract_it_columns_and_avg(df.columns)
    n_experiments = len(ordered_it_cols)

    default_range: str | None = None

    if avg_only:
        if exp_range_text.strip():
            if n_experiments == 0:
                raise DataProcessingError("No I.T.(mN/m) experiment columns found.")

            selected_indexes = parse_experiment_range(exp_range_text, n_experiments)
            resolved_range_text = exp_range_text.strip()
            selected_cols = [ordered_it_cols[idx - 1] for idx in selected_indexes]
            selected_numeric = df[selected_cols].apply(
                lambda series: pd.to_numeric(series, errors="coerce")
            )
            avg_label = f"Avg ({resolved_range_text})"
            avg_numeric = pd.DataFrame({avg_label: selected_numeric.mean(axis=1, skipna=True)})
            y_numeric = avg_numeric
            plot_numeric = (
                pd.concat([selected_numeric, avg_numeric], axis=1)
                if show_original_with_avg
                else avg_numeric
            )
            exp_tag = f"avg({resolved_range_text})"
        else:
            if avg_col is None:
                raise DataProcessingError(
                    "Avg column not found (looked for names like 'Avg', 'Average', 'Mean', '平均')."
                )

            avg_numeric = (
                df[[avg_col]]
                .apply(lambda series: pd.to_numeric(series, errors="coerce"))
                .rename(columns={avg_col: "Avg"})
            )
            y_numeric = avg_numeric
            if show_original_with_avg and n_experiments > 0:
                selected_numeric = df[ordered_it_cols].apply(
                    lambda series: pd.to_numeric(series, errors="coerce")
                )
                plot_numeric = pd.concat([selected_numeric, avg_numeric], axis=1)
            else:
                plot_numeric = avg_numeric
            exp_tag = "avg"
    else:
        if n_experiments == 0:
            raise DataProcessingError(
                "No I.T.(mN/m) experiment columns found."
            )

        if not exp_range_text.strip():
            default_range = f"1-{n_experiments}"
            selected_indexes = list(range(1, n_experiments + 1))
            resolved_range_text = default_range
        else:
            selected_indexes = parse_experiment_range(exp_range_text, n_experiments)
            resolved_range_text = exp_range_text.strip()

        selected_cols = [ordered_it_cols[idx - 1] for idx in selected_indexes]
        y_numeric = df[selected_cols].apply(lambda series: pd.to_numeric(series, errors="coerce"))
        plot_numeric = y_numeric
        exp_tag = f"exp{resolved_range_text}"

    s, e, row_range = _resolve_row_bounds(x_raw, y_numeric, start_text, end_text)
    x_plot = x_raw.iloc[s:e]
    y_plot = y_numeric.iloc[s:e]
    plot_values = plot_numeric.iloc[s:e]

    if x_plot.empty:
        raise DataProcessingError("Empty selection after range processing.")

    return PlotDataset(
        x_label=x_label,
        x_values=x_plot,
        y_values=y_plot,
        plot_values=plot_values,
        exp_tag=exp_tag,
        row_range=row_range,
        default_exp_range=default_range,
    )
