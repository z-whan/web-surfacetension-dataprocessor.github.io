import importlib.util
import re
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))
from DataProcessor.services.errors import DataProcessingError
from DataProcessor.services.langmuir_report import create_langmuir_pdf, decompose_fit


def example_row(double=True, name="Exp 1"):
    t = np.linspace(15000, 615000, 121)
    components = [{"label": label, "amplitude": amplitude, "tauSeconds": tau,
                   "kObsPerSecond": 1 / tau, "halfTimeSeconds": tau * np.log(2)}
                  for label, amplitude, tau in [("fast", 12, 20), ("slow", 20, 160)]]
    if not double:
        components = components[:1]
    elapsed = (t - t[0]) / 1000
    prediction = 40 + sum(item["amplitude"] * np.exp(-elapsed / item["tauSeconds"]) for item in components)
    residual = 0.03 * np.sin(elapsed / 3)
    return {
        "status": "ok", "name": name, "n": len(t), "t0": t[0], "timeEnd": t[-1],
        "gammaInf": 40, "gammaStart": 40 + sum(item["amplitude"] for item in components),
        "rSquared": 0.9999, "rmse": float(np.sqrt(np.mean(residual ** 2))),
        "components": components, "amplitude": components[0]["amplitude"],
        "tauSeconds": components[0]["tauSeconds"], "kObsPerSecond": components[0]["kObsPerSecond"],
        "halfTimeSeconds": components[0]["halfTimeSeconds"],
        "observed": {"x": t.tolist(), "y": (prediction + residual).tolist()},
        "residuals": {"x": t.tolist(), "y": residual.tolist()}, "warnings": [],
    }


class LangmuirReportTests(unittest.TestCase):
    def test_decrease_and_contributions_use_correct_reference_and_units(self):
        row = example_row()
        result = decompose_fit(row, 0.001, True)
        np.testing.assert_allclose(result["componentDecreases"][:, 0], [0, 0])
        expected = [12 * (1 - np.exp(-600 / 20)), 20 * (1 - np.exp(-600 / 160))]
        np.testing.assert_allclose(result["windowDecreases"], expected)
        np.testing.assert_allclose(result["asymptoticPercent"], [37.5, 62.5])
        np.testing.assert_allclose(result["windowPercent"], np.array(expected) / sum(expected) * 100)
        self.assertAlmostEqual(result["windowPercent"].sum(), 100)
        self.assertEqual(result["durationSeconds"], 600)
        self.assertEqual(result["observedTime"][0], 0)
        np.testing.assert_allclose(result["residualY"], row["residuals"]["y"])
        np.testing.assert_allclose(result["fittedY"] + result["totalDecrease"], row["gammaStart"])

    def test_single_component_and_zero_amplitude(self):
        result = decompose_fit(example_row(False), 0.001, False)
        np.testing.assert_allclose(result["windowPercent"], [100])
        row = example_row()
        row["components"][0]["amplitude"] = 0
        result = decompose_fit(row, 0.001, True)
        np.testing.assert_allclose(result["windowPercent"], [0, 100])
        with self.assertRaises(DataProcessingError):
            decompose_fit(row, 0, True)

    @unittest.skipUnless(importlib.util.find_spec("matplotlib"), "PDF generation requires the optional matplotlib runtime")
    def test_generates_one_page_per_successful_curve_for_both_models(self):
        for double in (False, True):
            payload = {"modelKey": "double" if double else "single", "secondsPerAxisUnit": 0.001,
                       "sourceName": "synthetic.csv", "rowRange": [1, 121],
                       "results": [example_row(double), {"status": "error", "name": "No fit"}, example_row(double, "Exp 2")]}
            report = create_langmuir_pdf(payload)
            self.assertTrue(report.startswith(b"%PDF-"))
            self.assertEqual(len(re.findall(rb"/Type /Page\b", report)), 2)
            with self.assertRaises(DataProcessingError):
                create_langmuir_pdf({**payload, "results": []})


if __name__ == "__main__":
    unittest.main()
