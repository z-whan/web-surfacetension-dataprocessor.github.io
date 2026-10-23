import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))
from DataProcessor.services.errors import DataProcessingError
from DataProcessor.services.langmuir_analysis import _positive_linear_fit, fit_langmuir_kinetics
from web_bridge import fit_plot_langmuir


class LangmuirTests(unittest.TestCase):
    def fit(self, t, y, label="Time (s)", options=None):
        return fit_langmuir_kinetics(x_label=label, x_values=t, y_values=pd.DataFrame({"Exp 1": y}), options=options)

    def test_recovers_known_parameters_and_residuals(self):
        t = np.linspace(15, 615, 301)
        y = 43 + 28 * np.exp(-(t - 15) / 90)
        payload = self.fit(t, y)
        row = payload["results"][0]
        self.assertEqual(row["status"], "ok")
        for key, expected in [("gammaInf", 43), ("gammaStart", 71), ("tauSeconds", 90), ("kObsPerSecond", 1 / 90), ("halfTimeSeconds", 90 * math.log(2))]:
            self.assertAlmostEqual(row[key], expected, places=6)
        self.assertAlmostEqual(row["rSquared"], 1, places=12)
        self.assertLess(row["rmse"], 1e-7)
        self.assertEqual(row["t0"], 15)
        self.assertEqual(row["warnings"], [])
        np.testing.assert_allclose(row["residuals"]["y"], 0, atol=1e-7)
        json.dumps(payload, allow_nan=False)

    def test_units_window_and_noisy_recovery(self):
        rng = np.random.default_rng(221026)
        seconds = np.linspace(0, 600, 301)
        y = 45 + 25 * np.exp(-seconds / 80) + rng.normal(0, 0.08, len(seconds))
        for unit, scale in [("ms", 1000), ("s", 1), ("min", 1 / 60)]:
            payload = self.fit(seconds * scale, y, f"Time ({unit})", {"timeMin": 20 * scale, "timeMax": 500 * scale})
            row = payload["results"][0]
            self.assertAlmostEqual(row["tauSeconds"], 80, delta=1)
            self.assertAlmostEqual(row["gammaInf"], 45, delta=0.1)
            self.assertAlmostEqual(row["gammaStart"], 45 + 25 * math.exp(-20 / 80), delta=0.1)
            self.assertGreaterEqual(row["t0"], 20 * scale)
            self.assertLessEqual(row["timeEnd"], 500 * scale)
            self.assertGreater(row["rSquared"], 0.99)

    def test_rejects_unknown_units_invalid_limits_and_constant_signal(self):
        t = np.arange(20)
        y = 40 + 20 * np.exp(-t / 4)
        with self.assertRaisesRegex(DataProcessingError, "Time unit"):
            self.fit(t, y, "Time")
        self.assertEqual(self.fit(t, y, "Time", {"timeUnit": "s"})["summary"]["fitted"], 1)
        for options in [{"timeMin": "nan"}, {"timeMax": "invalid"}, {"timeMin": 10, "timeMax": 5}]:
            with self.assertRaises(DataProcessingError):
                self.fit(t, y, options=options)
        self.assertEqual(self.fit(t, np.ones(20) * 70)["summary"]["fitted"], 0)
        self.assertEqual(self.fit(t, y, options={"timeMin": 100})["summary"]["fitted"], 0)
        self.assertEqual(self.fit(t, -y)["summary"]["fitted"], 0)
        self.assertEqual(self.fit(t, 80 - y)["summary"]["fitted"], 0)

    def test_missing_unsorted_and_short_windows(self):
        t = np.array([5, 0, 1, 2, 3, 4, 6, 7, 8, 9, 9, 10], dtype=float)
        y = 44 + 27 * np.exp(-t / 60)
        y[2] = np.nan
        row = self.fit(t, y)["results"][0]
        self.assertEqual(row["n"], 11)
        self.assertAlmostEqual(row["tauSeconds"], 60, places=5)
        self.assertTrue(any("Omitted 1" in value for value in row["warnings"]))
        self.assertTrue(any("sorted" in value for value in row["warnings"]))
        self.assertTrue(any("less than 3 tau" in value for value in row["warnings"]))
        self.assertEqual(self.fit([1] * 6, [70, 69, 68, 67, 66, 65])["summary"]["fitted"], 0)

    def test_bridge_respects_rows_experiments_and_average(self):
        t = np.arange(100) * 1000
        y = 42 + 30 * np.exp(-t / 20000)
        with tempfile.TemporaryDirectory() as directory:
            csv = Path(directory) / "kinetics.csv"
            pd.DataFrame({"Time (ms)": t, "I.T.(mN/m).1": y, "I.T.(mN/m).2": y + 2, "I.T.(mN/m).3": np.ones(100) * 70}).to_csv(csv, index=False)
            payload = fit_plot_langmuir(str(csv), "11", "91", "1-2", True, {}, False)
            self.assertEqual(payload["summary"], {"fitted": 1, "total": 1})
            self.assertEqual(payload["rowRange"], [11, 91])
            row = payload["results"][0]
            self.assertEqual(row["name"], "Avg (1-2)")
            self.assertEqual(row["n"], 81)
            self.assertAlmostEqual(row["gammaInf"], 43, places=6)
            self.assertAlmostEqual(row["tauSeconds"], 20, places=6)
            payload = fit_plot_langmuir(str(csv), "", "", "1,3", False)
            self.assertEqual(payload["summary"], {"fitted": 1, "total": 2})
            self.assertEqual(payload["results"][1]["status"], "error")
            json.dumps(payload, allow_nan=False)
            payload = fit_plot_langmuir(str(csv), "", "", "1-2", True, {"model": "double"})
            self.assertEqual(payload["modelKey"], "double")
            self.assertEqual(payload["options"]["model"], "double")
            self.assertEqual(len(payload["results"][0]["components"]), 2)

    def test_double_recovers_known_fast_slow_parameters(self):
        t = np.linspace(15, 615, 301)
        y = 40 + 12 * np.exp(-(t - 15) / 20) + 20 * np.exp(-(t - 15) / 160)
        payload = self.fit(t, y, options={"model": "double"})
        row = payload["results"][0]
        self.assertEqual(payload["modelKey"], "double")
        self.assertEqual(row["status"], "ok")
        self.assertAlmostEqual(row["gammaInf"], 40, places=6)
        self.assertAlmostEqual(row["gammaStart"], 72, places=6)
        self.assertEqual(row["t0"], 15)
        for component, amplitude, tau in zip(row["components"], (12, 20), (20, 160)):
            self.assertAlmostEqual(component["amplitude"], amplitude, places=6)
            self.assertAlmostEqual(component["tauSeconds"], tau, places=6)
            self.assertAlmostEqual(component["kObsPerSecond"], 1 / tau, places=6)
            self.assertAlmostEqual(component["halfTimeSeconds"], tau * math.log(2), places=6)
        self.assertNotIn("tauSeconds", row, "a double fit must not imply one overall time constant")
        self.assertLess(row["rmse"], 1e-7)
        np.testing.assert_allclose(row["residuals"]["y"], 0, atol=1e-7)
        self.assertEqual(row["warnings"], [])
        json.dumps(payload, allow_nan=False)

    def test_double_noisy_recovery_units_and_window(self):
        rng = np.random.default_rng(231026)
        t = np.linspace(0, 600, 601)
        y = 41 + 12 * np.exp(-t / 15) + 20 * np.exp(-t / 140) + rng.normal(0, 0.04, len(t))
        for unit, scale in [("ms", 1000), ("s", 1), ("min", 1 / 60)]:
            payload = self.fit(t * scale, y, f"Time ({unit})", {"model": "double", "timeMin": 10 * scale, "timeMax": 500 * scale})
            row = payload["results"][0]
            self.assertAlmostEqual(row["gammaInf"], 41, delta=0.1)
            self.assertAlmostEqual(row["components"][0]["tauSeconds"], 15, delta=0.8)
            self.assertAlmostEqual(row["components"][1]["tauSeconds"], 140, delta=1.5)
            self.assertAlmostEqual(row["components"][0]["amplitude"], 12 * math.exp(-10 / 15), delta=0.2)
            self.assertGreater(row["rSquared"], 0.99)

    def test_double_input_validation_and_identifiability(self):
        t = np.arange(101, dtype=float)
        y = 40 + 30 * np.exp(-t / 30)
        with self.assertRaisesRegex(DataProcessingError, "fit model"):
            self.fit(t, y, options={"model": "triple"})
        payload = self.fit(t[:9], y[:9], options={"model": "double"})
        self.assertIn("10 finite", payload["results"][0]["message"])
        for values in (np.full(len(t), 70), -y, 80 - y):
            self.assertEqual(self.fit(t, values, options={"model": "double"})["summary"]["fitted"], 0)
        row = self.fit(t, y, options={"model": "double"})["results"][0]
        self.assertTrue(any("2%" in warning or "factor of 2" in warning or "identifiable" in warning for warning in row["warnings"]))
        self.assertGreaterEqual(row["components"][1]["tauSeconds"], row["components"][0]["tauSeconds"])
        slow_y = 40 + 10 * np.exp(-t / 5) + 20 * np.exp(-t / 300)
        row = self.fit(t, slow_y, options={"model": "double"})["results"][0]
        self.assertTrue(any("3 tau_slow" in warning for warning in row["warnings"]))

    def test_positive_linear_solver_matches_active_set_reference(self):
        rng = np.random.default_rng(2310)
        u = np.linspace(0, 1, 81)
        for _ in range(24):
            times = np.sort(np.exp(rng.uniform(-3, 1, 2)))
            design = np.column_stack((np.ones(len(u)), np.exp(-u / times[0]), np.exp(-u / times[1])))
            # Include constraints that force an amplitude or baseline to zero.
            y = design @ rng.uniform(-10, 20, 3) + rng.normal(0, 0.1, len(u))
            floor = np.array([1e-12, 0, 0])
            expected = float(np.sum((y - design @ floor) ** 2))
            for active_bits in range(1, 8):
                active = [index for index in range(3) if active_bits & (1 << index)]
                solution = np.linalg.lstsq(design[:, active], y - design @ floor, rcond=None)[0]
                if np.all(solution >= 0):
                    coefficients = floor.copy()
                    coefficients[active] += solution
                    expected = min(expected, float(np.sum((y - design @ coefficients) ** 2)))
            score, coefficients = _positive_linear_fit(design, y, float(np.mean(y)), y - np.mean(y))
            self.assertAlmostEqual(score, expected, delta=1e-8 * max(1, expected))
            self.assertTrue(np.all(coefficients >= 0))


if __name__ == "__main__":
    unittest.main()
