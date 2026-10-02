import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))
from DataProcessor.services.experiment_screening import screen_experiments
from web_bridge import analyze_plot_file, suggest_plot_experiments


class ExperimentScreeningTests(unittest.TestCase):
    def fixture(self, duration=600, label="Time (s)"):
        t = np.linspace(0, duration, 601)
        df = pd.DataFrame({label: t, "I.T.(mN/m).1": 55 + 15 * np.exp(-t / 20)})
        volume = {1: {"values": np.linspace(10, 9.6, len(t)), "source": "worksheet"}}
        return df, volume

    def test_smooth_fast_decline_is_not_noise(self):
        df, volumes = self.fixture()
        result = screen_experiments(df, volumes)
        self.assertEqual(result["recommendedRange"], "1")
        row = result["experiments"][0]
        self.assertLess(row["noiseSigma"], 0.01)
        self.assertAlmostEqual(row["evaporationPctPer10Min"], 4)

    def test_noise_missing_tail_and_excessive_evaporation_are_excluded(self):
        df, volumes = self.fixture()
        rng = np.random.default_rng(23)
        for idx in range(2, 5):
            df[f"I.T.(mN/m).{idx}"] = df.iloc[:, 1]
            volumes[idx] = volumes[1]
        df["I.T.(mN/m).2"] += rng.normal(0, 2, len(df))
        df.loc[300:, "I.T.(mN/m).3"] = np.nan
        volumes[4] = {"values": np.linspace(10, 9.4, len(df))}
        result = screen_experiments(df, volumes)
        self.assertEqual(result["recommendedRange"], "1")
        self.assertGreater(result["experiments"][1]["noiseSigma"], 0.5)
        self.assertLess(result["experiments"][2]["durationCoveragePercent"], 90)
        self.assertAlmostEqual(result["experiments"][3]["evaporationPctPer10Min"], 6)

    def test_short_duration_normalisation_and_exact_five_percent_boundary(self):
        df, volumes = self.fixture(duration=300)
        volumes[1]["values"] = np.linspace(10, 9.75, len(df))
        row = screen_experiments(df, volumes)["experiments"][0]
        self.assertEqual(row["status"], "suggest")
        self.assertAlmostEqual(row["evaporationPctPer10Min"], 5)
        self.assertEqual(row["volumeDurationSeconds"], 300)
        self.assertTrue(any("shorter recording" in reason for reason in row["reasons"]))
        volumes[1]["values"][-1] = 9.74
        self.assertEqual(screen_experiments(df, volumes)["experiments"][0]["status"], "exclude")

    def test_missing_volume_and_unknown_time_unit_require_review(self):
        df, volumes = self.fixture()
        self.assertEqual(screen_experiments(df)["experiments"][0]["status"], "review")
        df.rename(columns={"Time (s)": "Time"}, inplace=True)
        row = screen_experiments(df, volumes)["experiments"][0]
        self.assertIsNone(row["evaporationPctPer10Min"])
        self.assertEqual(row["status"], "review")

    def test_time_units_and_invalid_time_never_use_row_index(self):
        for label, multiplier in [("Time (ms)", 1000), ("Time (min)", 1 / 60)]:
            df, volumes = self.fixture(label=label)
            df[label] *= multiplier
            self.assertAlmostEqual(screen_experiments(df, volumes)["experiments"][0]["evaporationPctPer10Min"], 4)
        df, volumes = self.fixture()
        df.loc[50, "Time (s)"] = df.loc[49, "Time (s)"]
        row = screen_experiments(df, volumes)["experiments"][0]
        self.assertEqual(row["status"], "exclude")
        self.assertIsNone(row["evaporationPctPer10Min"])

    def test_missing_internal_rows_threshold_and_zero_volume(self):
        df, volumes = self.fixture()
        df.loc[100, "I.T.(mN/m).1"] = np.nan
        self.assertEqual(screen_experiments(df, volumes)["recommendedRange"], "1")
        self.assertEqual(screen_experiments(df, volumes, {"validPercent": 100})["recommendedRange"], "")
        volumes[1]["values"][:] = 0
        self.assertIsNone(screen_experiments(df, volumes)["experiments"][0]["evaporationPctPer10Min"])

    def test_shared_missing_tail_and_missing_start_time_are_counted(self):
        df, volumes = self.fixture()
        df.loc[0, "Time (s)"] = np.nan
        row = screen_experiments(df, volumes)["experiments"][0]
        self.assertEqual(row["totalPoints"], 601)
        self.assertEqual(row["validPoints"], 600)
        self.assertEqual(row["status"], "exclude")
        df, volumes = self.fixture()
        df.loc[540:, "I.T.(mN/m).1"] = np.nan
        row = screen_experiments(df, volumes)["experiments"][0]
        self.assertLess(row["validPercent"], 90)
        self.assertEqual(row["status"], "exclude")

    def test_partial_volume_does_not_silently_pass(self):
        df, volumes = self.fixture()
        volumes[1]["values"][200:] = np.nan
        row = screen_experiments(df, volumes)["experiments"][0]
        self.assertEqual(row["status"], "review")
        self.assertEqual(screen_experiments(df, volumes)["recommendedRange"], "")

    def test_single_large_spike_does_not_disappear_in_robust_metrics(self):
        df, volumes = self.fixture()
        df.loc[300, "I.T.(mN/m).1"] += 8
        row = screen_experiments(df, volumes)["experiments"][0]
        self.assertLess(row["noiseSigma"], 0.01)
        self.assertEqual(row["spikeCount"], 1)
        self.assertEqual(row["status"], "exclude")

    def test_famas_detail_precision_unused_slots_and_copyable_numbering(self):
        rows = ["[WORKSHEET]", ",1,1,2,2,3,3", "時間(ms),I.T.(mN/m),V(uL),I.T.(mN/m),V(uL),I.T.(mN/m),V(uL)"]
        for i in range(11):
            rows.append(f"{i * 60000},70,10,0,0,68,10")
        rows += ["[DETAIL]", "行,列,I.T.(mN/m),V(uL)"]
        for i in range(11):
            rows += [f"{i + 1},1,70,{10 - i * 0.04}", f"{i + 1},3,68,{10 - i * 0.06}"]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "famas.csv"
            path.write_text("\n".join(rows), encoding="shift_jis")
            result = suggest_plot_experiments(str(path))
            self.assertEqual(result["recommendedRange"], "1")
            self.assertEqual(len(result["experiments"]), 3)
            self.assertEqual(result["experiments"][0]["volumeSource"], "detail")
            self.assertAlmostEqual(result["experiments"][2]["evaporationPctPer10Min"], 6)
            plotted = analyze_plot_file(str(path), "", "", "1,3", False)
            self.assertEqual([row["experimentIndex"] for row in plotted["series"]], [1, 3])
            self.assertEqual(analyze_plot_file(str(path), "", "", "", False)["defaultExpRange"], "1,3")
            json.dumps(result, allow_nan=False)

    def test_famas_missing_timestamp_does_not_truncate_the_check(self):
        rows = ["[WORKSHEET]", ",,1,1", "コメント,時間(ms),I.T.(mN/m),V(uL)"]
        rows += [f",{i * 6000 if i != 40 else ''},70,10" for i in range(101)]
        rows += ["[WORKSHEET]", "", "[DETAIL]", "行,列,I.T.(mN/m),V(uL)", "1,1,70,10", "[DETAIL]", "[EDGE]", "1,1,111,112"]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "missing-time.csv"
            path.write_text("\n".join(rows), encoding="shift_jis")
            row = suggest_plot_experiments(str(path))["experiments"][0]
            self.assertEqual(row["totalPoints"], 101)
            self.assertEqual(row["validPoints"], 100)
            self.assertEqual(row["durationSeconds"], 600)


if __name__ == "__main__":
    unittest.main()
