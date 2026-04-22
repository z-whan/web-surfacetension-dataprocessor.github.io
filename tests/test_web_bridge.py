import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY_ROOT = ROOT / "py"
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from web_bridge import (  # noqa: E402
    analyze_cmc_files,
    analyze_plot_file,
    analyze_plot_noise,
    extract_plot_trend,
    infer_concentration,
)


class WebBridgeTests(unittest.TestCase):
    def test_infer_concentration(self):
        result = infer_concentration("sample-12.5mM.csv")
        self.assertEqual(result["value"], 12.5)

    def test_analyze_plot_file(self):
        content = "Time (ms),I.T.(mN/m).1,I.T.(mN/m).2\n0,10,11\n1,12,13\n2,14,15\n"
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as handle:
            handle.write(content)
            path = handle.name

        try:
            payload = analyze_plot_file(path, "", "", "", False)
            self.assertEqual(payload["summary"]["seriesCount"], 2)
            self.assertEqual(payload["rowRange"], [1, 3])
        finally:
            os.unlink(path)

    def test_analyze_cmc_files(self):
        content = "Time (ms),I.T.(mN/m)\n0,10\n10,12\n20,14\n0,11\n10,13\n20,15\n"
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as handle:
            handle.write(content)
            path = handle.name

        try:
            payload = analyze_cmc_files(
                entries=[{"path": path, "filename": "1mM.csv", "concentration": "1.0"}],
                t_min_text="5",
                t_max_text="15",
                c_unit="mM",
                use_log=False,
            )
            self.assertEqual(payload["summary"]["fileCount"], 1)
            self.assertEqual(payload["points"][0]["y"], 12.5)
        finally:
            os.unlink(path)

    def test_extract_plot_trend(self):
        content = "Time (ms),I.T.(mN/m).1\n0,0\n1,1\n2,2\n3,3\n4,4\n5,5\n"
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as handle:
            handle.write(content)
            path = handle.name

        try:
            payload = extract_plot_trend(
                path,
                "",
                "",
                "1",
                False,
                "moving_average",
                {"windowSize": "3", "windowUnit": "points"},
            )
            self.assertEqual(payload["method"]["key"], "moving_average")
            self.assertEqual(len(payload["series"]), 1)
            self.assertEqual(len(payload["series"][0]["y"]), 6)
        finally:
            os.unlink(path)

    def test_analyze_plot_noise_with_trend(self):
        content = "Time (ms),I.T.(mN/m).1\n0,1\n1,1.5\n2,2\n3,2.5\n4,3\n5,3.5\n"
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as handle:
            handle.write(content)
            path = handle.name

        try:
            payload = analyze_plot_noise(
                path,
                "",
                "",
                "1",
                False,
                "residual_std",
                {"useTrend": True},
                {
                    "methodKey": "moving_average",
                    "parameters": {"windowSize": "3", "windowUnit": "points"},
                },
            )
            self.assertEqual(payload["method"]["key"], "residual_std")
            self.assertEqual(payload["summaryColumns"][1], "Residual Std")
            self.assertEqual(len(payload["summaryRows"]), 1)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
