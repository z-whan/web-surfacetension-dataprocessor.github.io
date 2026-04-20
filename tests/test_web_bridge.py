import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY_ROOT = ROOT / "py"
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from web_bridge import analyze_cmc_files, analyze_plot_file, infer_concentration  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
