import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR_PATH = ROOT / "tools" / "build_python_sources.py"

spec = importlib.util.spec_from_file_location("build_python_sources", GENERATOR_PATH)
build_python_sources = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(build_python_sources)


class BuildPythonSourcesTests(unittest.TestCase):
    def test_generates_deterministic_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            py_root = Path(tmp) / "py"
            (py_root / "pkg").mkdir(parents=True)
            (py_root / "b.py").write_text("B = 2\n", encoding="utf-8")
            (py_root / "pkg" / "a.py").write_text("A = 'quote\"safe'\n", encoding="utf-8")

            first = build_python_sources.render_python_sources(py_root)
            second = build_python_sources.render_python_sources(py_root)

        self.assertEqual(first, second)
        self.assertLess(first.index('"py/b.py"'), first.index('"py/pkg/a.py"'))
        self.assertIn("Generated file. Do not edit manually.", first)
        self.assertIn(r"quote\"safe", first)

    def test_includes_web_bridge_and_service_modules(self):
        content = build_python_sources.render_python_sources(ROOT / "py")

        self.assertIn('"py/web_bridge.py"', content)
        self.assertIn('"py/DataProcessor/services/plot_analysis.py"', content)
        self.assertIn('"py/DataProcessor/services/time_series_analysis.py"', content)

    def test_check_mode_fails_when_output_is_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            py_root = tmp_path / "py"
            output = tmp_path / "assets" / "js" / "python-sources.js"
            py_root.mkdir()
            output.parent.mkdir(parents=True)
            (py_root / "web_bridge.py").write_text("VALUE = 1\n", encoding="utf-8")
            output.write_text("// stale\n", encoding="utf-8")

            result = subprocess.run(
                [
                    sys.executable,
                    str(GENERATOR_PATH),
                    "--py-root",
                    str(py_root),
                    "--output",
                    str(output),
                    "--check",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is stale", result.stderr)


if __name__ == "__main__":
    unittest.main()
