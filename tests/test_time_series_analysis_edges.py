import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PY_ROOT = ROOT / "py"
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from DataProcessor.services.errors import DataProcessingError  # noqa: E402
from DataProcessor.services.time_series_analysis import (  # noqa: E402
    analyze_noise,
    extract_trend_analysis,
)


class TimeSeriesTrendEdgeTests(unittest.TestCase):
    def setUp(self):
        self.x = pd.Series([0, 1, 2, 3, 4, 5], name="Time (s)")
        self.y = pd.DataFrame({"signal": [1, 2, 3, 4, 5, 6]})

    def test_empty_input_returns_empty_moving_average(self):
        result = extract_trend_analysis(
            x_label="Time (s)",
            x_values=pd.Series([], dtype=float),
            y_values=pd.DataFrame({"signal": pd.Series([], dtype=float)}),
            method_key="moving_average",
            parameters={"windowSize": "2", "windowUnit": "points"},
        )

        self.assertEqual(result.method_key, "moving_average")
        self.assertEqual(len(result.trend_values), 0)

    def test_too_few_points_for_savitzky_golay_raises(self):
        with self.assertRaisesRegex(DataProcessingError, "too short"):
            extract_trend_analysis(
                x_label="Time (s)",
                x_values=pd.Series([0, 1, 2]),
                y_values=pd.DataFrame({"signal": [1, 2, 3]}),
                method_key="savitzky_golay",
                parameters={"windowLength": "5", "polyOrder": "2"},
            )

    def test_invalid_window_sizes_raise_clear_errors(self):
        with self.assertRaisesRegex(DataProcessingError, "at least 2"):
            extract_trend_analysis(
                x_label="Time (s)",
                x_values=self.x,
                y_values=self.y,
                method_key="moving_average",
                parameters={"windowSize": "1", "windowUnit": "points"},
            )

        with self.assertRaisesRegex(DataProcessingError, "odd number"):
            extract_trend_analysis(
                x_label="Time (s)",
                x_values=self.x,
                y_values=self.y,
                method_key="median_filter",
                parameters={"windowSize": "4"},
            )

        with self.assertRaisesRegex(DataProcessingError, "Polynomial order"):
            extract_trend_analysis(
                x_label="Time (s)",
                x_values=self.x,
                y_values=self.y,
                method_key="savitzky_golay",
                parameters={"windowLength": "5", "polyOrder": "5"},
            )

    def test_savitzky_golay_preserves_nan_positions(self):
        result = extract_trend_analysis(
            x_label="Time (s)",
            x_values=self.x,
            y_values=pd.DataFrame({"signal": [1, 2, np.nan, 4, 5, 6]}),
            method_key="savitzky_golay",
            parameters={"windowLength": "3", "polyOrder": "1"},
        )

        values = result.trend_values["signal"].to_numpy(dtype=float)
        self.assertTrue(np.isnan(values[2]))
        self.assertTrue(np.isfinite(values[[0, 1, 3, 4, 5]]).all())

    def test_non_numeric_savitzky_golay_input_raises(self):
        with self.assertRaisesRegex(DataProcessingError, "not have enough valid points"):
            extract_trend_analysis(
                x_label="Time (s)",
                x_values=self.x,
                y_values=pd.DataFrame({"signal": ["a", "b", "c", "d", "e", "f"]}),
                method_key="savitzky_golay",
                parameters={"windowLength": "3", "polyOrder": "1"},
            )


class TimeSeriesNoiseEdgeTests(unittest.TestCase):
    def setUp(self):
        self.x = pd.Series([0, 1, 2, 3, 4, 5, 6, 7], name="Time (s)")
        self.y = pd.DataFrame({"signal": [0.0, 1.0, 0.0, -1.0, 0.0, 1.0, 0.0, -1.0]})

    def test_residual_std_requires_trend_when_enabled(self):
        with self.assertRaisesRegex(DataProcessingError, "requires an extracted trend"):
            analyze_noise(
                x_values=self.x,
                y_values=self.y,
                method_key="residual_std",
                parameters={"useTrend": True},
            )

    def test_residual_std_requires_enough_data(self):
        with self.assertRaisesRegex(DataProcessingError, "enough residual points"):
            analyze_noise(
                x_values=pd.Series([0]),
                y_values=pd.DataFrame({"signal": [1.0]}),
                method_key="residual_std",
                parameters={"useTrend": False},
            )

    def test_adjacent_difference_requires_two_points(self):
        with self.assertRaisesRegex(DataProcessingError, "enough points"):
            analyze_noise(
                x_values=pd.Series([0]),
                y_values=pd.DataFrame({"signal": [1.0]}),
                method_key="adjacent_difference",
                parameters={},
            )

    def test_rolling_std_validates_window_size(self):
        with self.assertRaisesRegex(DataProcessingError, "Window size"):
            analyze_noise(
                x_values=self.x,
                y_values=self.y,
                method_key="rolling_std",
                parameters={"windowSize": "1"},
            )

    def test_allan_deviation_requires_sufficient_data(self):
        with self.assertRaisesRegex(DataProcessingError, "too short"):
            analyze_noise(
                x_values=pd.Series([0, 1, 2]),
                y_values=pd.DataFrame({"signal": [1.0, 1.2, 1.1]}),
                method_key="allan_deviation",
                parameters={"tauCount": "3"},
            )

    def test_psd_validates_processing_mode(self):
        with self.assertRaisesRegex(DataProcessingError, "Unsupported"):
            analyze_noise(
                x_values=self.x,
                y_values=self.y,
                method_key="psd",
                parameters={"processingMode": "bogus"},
            )

    def test_psd_validates_manual_sampling_interval(self):
        with self.assertRaisesRegex(DataProcessingError, "Sampling interval"):
            analyze_noise(
                x_values=self.x,
                y_values=self.y,
                method_key="psd",
                parameters={"samplingInterval": "0"},
            )

    def test_psd_handles_irregular_sampling_with_estimated_interval(self):
        result = analyze_noise(
            x_values=pd.Series([0, 1, 2, 4, 5, 7, 8, 10]),
            y_values=self.y,
            method_key="psd",
            parameters={"processingMode": "remove_mean_only"},
        )

        self.assertEqual(result.method_key, "psd")
        self.assertGreater(result.parameters["samplingInterval"], 0)
        self.assertEqual(result.plot_payload["series"][0]["name"], "signal")


if __name__ == "__main__":
    unittest.main()
