import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
PY_ROOT = ROOT / "py"
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from DataProcessor.services.time_series_analysis import analyze_time_series_quality  # noqa: E402


def quality_for(time_values, signal_values):
    return analyze_time_series_quality(
        x_label="Time (ms)",
        x_values=pd.Series(time_values),
        y_values=pd.DataFrame({"I.T.(mN/m).1": signal_values}),
        row_range=(1, len(time_values)),
        selection_label="exp1",
    )


def warning_codes(payload):
    return {warning["code"] for warning in payload["warnings"]}


class TimeSeriesQualityTests(unittest.TestCase):
    def test_clean_regular_data(self):
        payload = quality_for([0, 1, 2, 3, 4, 5], [10, 11, 12, 13, 14, 15])

        self.assertEqual(payload["summary"]["status"], "clean")
        self.assertEqual(payload["warnings"], [])
        self.assertEqual(payload["metrics"]["samplingInterval"]["median"], 1.0)
        self.assertEqual(payload["metrics"]["validRowCount"], 6)

    def test_missing_values(self):
        payload = quality_for([0, 1, np.nan, 3, 4], [10, np.nan, 12, 13, 14])

        self.assertIn("missing-or-nonnumeric-values", warning_codes(payload))
        self.assertEqual(payload["metrics"]["missingTimeCount"], 1)
        self.assertEqual(payload["metrics"]["missingSignalValueCount"], 1)

    def test_non_monotonic_time(self):
        payload = quality_for([0, 1, 3, 2, 4, 5], [10, 11, 12, 13, 14, 15])

        self.assertIn("non-monotonic-time-axis", warning_codes(payload))
        self.assertEqual(payload["metrics"]["nonMonotonicIntervalCount"], 1)

    def test_irregular_intervals(self):
        payload = quality_for([0, 1, 2, 4, 5, 6], [10, 11, 12, 13, 14, 15])

        self.assertIn("irregular-sampling-interval", warning_codes(payload))
        self.assertGreater(payload["metrics"]["samplingInterval"]["irregularCount"], 0)

    def test_duplicate_time(self):
        payload = quality_for([0, 1, 1, 2, 3, 4], [10, 11, 12, 13, 14, 15])

        self.assertIn("duplicate-time-values", warning_codes(payload))
        self.assertEqual(payload["metrics"]["duplicateTimeCount"], 1)
        self.assertEqual(payload["metrics"]["zeroIntervalCount"], 1)

    def test_outliers(self):
        payload = quality_for(
            list(range(10)),
            [10, 10, 10, 10, 10, 100, 10, 10, 10, 10],
        )

        self.assertIn("extreme-outliers-or-spikes", warning_codes(payload))
        self.assertEqual(payload["metrics"]["signals"][0]["outlierCount"], 1)

    def test_too_few_points(self):
        payload = quality_for([0, 1, 2], [10, 11, 12])

        self.assertIn("too-few-points", warning_codes(payload))
        self.assertEqual(payload["metrics"]["validRowCount"], 3)


if __name__ == "__main__":
    unittest.main()
