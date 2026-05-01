import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PY_ROOT = ROOT / "py"
if str(PY_ROOT) not in sys.path:
    sys.path.insert(0, str(PY_ROOT))

from DataProcessor.services.plot_analysis import (  # noqa: E402
    detect_non_empty_experiments,
    first_data_cell_has_value,
    format_experiment_range,
)
from DataProcessor.services.dataframe_loader import parse_famas_measurement_detail_volumes  # noqa: E402
from web_bridge import (  # noqa: E402
    analyze_cmc_files,
    analyze_plot_file,
    analyze_plot_noise,
    analyze_time_series_quality,
    extract_plot_trend,
    infer_concentration,
)


class WebBridgeTests(unittest.TestCase):
    def _write_temp_csv(self, content: str) -> str:
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as handle:
            handle.write(content)
            return handle.name

    def _write_famas_csv(
        self,
        *,
        row_count: int = 5,
        measured_experiments=(1,),
        experiment_count: int = 2,
        include_detail: bool = True,
        include_main_volume: bool = True,
        detail_zero_experiments=(),
    ) -> str:
        prefix = [""]
        header = ["時間(ms)"]
        for exp in range(1, experiment_count + 1):
            prefix.append(str(exp))
            header.append("I.T.(mN/m)")
            if include_main_volume:
                prefix.append(str(exp))
                header.append("V(uL)")

        rows = [["[WORKSHEET]"], prefix, header]
        for row_index in range(1, row_count + 1):
            row = [str(row_index * 1000)]
            for exp in range(1, experiment_count + 1):
                if exp in measured_experiments:
                    row.append(str(70 + exp + row_index / 10))
                    if include_main_volume:
                        row.append(str(10 + exp + row_index / 100))
                else:
                    row.append("")
                    if include_main_volume:
                        row.append("")
            rows.append(row)

        if include_detail:
            rows.extend([["[DETAIL]"], [
                "行",
                "列",
                "I.T.(mN/m)",
                "V(uL)",
                "de(um)",
            ]])
            for row_index in range(1, row_count + 1):
                for exp in range(1, experiment_count + 1):
                    if exp in measured_experiments:
                        volume = 11 + exp + row_index / 1000000
                        surface_tension = 70 + exp + row_index / 1000
                    elif exp in detail_zero_experiments:
                        volume = 0
                        surface_tension = 0
                    else:
                        volume = ""
                        surface_tension = ""
                    rows.append([
                        str(row_index),
                        str(exp),
                        str(surface_tension),
                        str(volume),
                        "2500",
                    ])
            rows.extend([["[DETAIL]"], [], ["[EDGE]"], ["行", "列", "L1 x"], ["1", "1", "123"]])

        content = "\n".join(",".join(str(cell) for cell in row) for row in rows) + "\n"
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="shift_jis") as handle:
            handle.write(content)
            return handle.name

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

    def test_parse_famas_measurement_detail_volumes(self):
        path = self._write_famas_csv(row_count=5, measured_experiments=(1, 2), experiment_count=2)

        try:
            detail = parse_famas_measurement_detail_volumes(path)
            self.assertIn(1, detail)
            self.assertIn(2, detail)
            self.assertEqual(detail[1][0]["rowIndex"], 1)
            self.assertEqual(detail[1][0]["experimentIndex"], 1)
            self.assertAlmostEqual(detail[1][0]["volume"], 12.000001)
            self.assertEqual(detail[2][0]["rowIndex"], 1)
            self.assertAlmostEqual(detail[2][0]["volume"], 13.000001)
        finally:
            os.unlink(path)

    def test_analyze_plot_file_volume_overlay_variable_duration(self):
        path = self._write_famas_csv(row_count=6, measured_experiments=(1,), experiment_count=1)

        try:
            payload = analyze_plot_file(path, "", "", "1", False)
            overlay = payload["volumeOverlay"]
            self.assertEqual(payload["summary"]["rows"], 6)
            self.assertEqual(len(overlay["series"]), 1)
            self.assertEqual(len(overlay["series"][0]["x"]), 6)
            self.assertEqual(overlay["series"][0]["source"], "detail")
            self.assertEqual(overlay["series"][0]["x"][0], 1000)
        finally:
            os.unlink(path)

    def test_analyze_plot_file_volume_overlay_skips_empty_experiments(self):
        path = self._write_famas_csv(
            row_count=5,
            measured_experiments=(1, 2, 3, 4),
            experiment_count=10,
            detail_zero_experiments=(5, 6, 7, 8, 9, 10),
        )

        try:
            payload = analyze_plot_file(path, "", "", "1-10", False)
            overlay = payload["volumeOverlay"]
            self.assertEqual(payload["defaultExpRange"], "1-4")
            self.assertEqual(payload["summary"]["seriesCount"], 4)
            self.assertEqual([series["experimentIndex"] for series in overlay["series"]], [1, 2, 3, 4])
        finally:
            os.unlink(path)

    def test_detail_zeros_do_not_classify_experiments_as_measured(self):
        path = self._write_famas_csv(
            row_count=5,
            measured_experiments=(),
            experiment_count=2,
            detail_zero_experiments=(1, 2),
        )

        try:
            with self.assertRaisesRegex(
                Exception,
                "No non-empty experiments were detected in the selected data.",
            ):
                analyze_plot_file(path, "", "", "1-2", False)
        finally:
            os.unlink(path)

    def test_analyze_plot_file_volume_overlay_falls_back_to_main_table_volume(self):
        path = self._write_famas_csv(
            row_count=5,
            measured_experiments=(1,),
            experiment_count=1,
            include_detail=False,
        )

        try:
            payload = analyze_plot_file(path, "", "", "1", False)
            overlay = payload["volumeOverlay"]
            self.assertEqual(len(overlay["series"]), 1)
            self.assertEqual(overlay["series"][0]["source"], "worksheet")
            self.assertEqual(overlay["warnings"], [])
        finally:
            os.unlink(path)

    def test_analyze_plot_file_volume_overlay_warns_when_missing(self):
        path = self._write_famas_csv(
            row_count=5,
            measured_experiments=(1,),
            experiment_count=1,
            include_detail=False,
            include_main_volume=False,
        )

        try:
            payload = analyze_plot_file(path, "", "", "1", False)
            self.assertEqual(payload["summary"]["seriesCount"], 1)
            self.assertEqual(payload["volumeOverlay"]["series"], [])
            self.assertIn("Droplet volume data was not found.", payload["volumeOverlay"]["warnings"])
        finally:
            os.unlink(path)

    def test_analyze_plot_file_skips_empty_tail_experiments(self):
        headers = ["Time (ms)"] + [f"I.T.(mN/m).{idx}" for idx in range(1, 11)]
        rows = [
            ["0", "10", "11", "12", "13", "", "", "", "", "", ""],
            ["1", "20", "21", "22", "23", "", "", "", "", "", ""],
            ["2", "30", "31", "32", "33", "", "", "", "", "", ""],
        ]
        content = ",".join(headers) + "\n" + "\n".join(",".join(row) for row in rows) + "\n"
        path = self._write_temp_csv(content)

        try:
            payload = analyze_plot_file(path, "", "", "1-10", False)
            self.assertEqual(payload["defaultExpRange"], "1-4")
            self.assertEqual(payload["summary"]["seriesCount"], 4)
            self.assertEqual([series["name"] for series in payload["series"]], headers[1:5])
        finally:
            os.unlink(path)

    def test_analyze_plot_file_formats_sparse_detected_experiments(self):
        content = (
            "Time (ms),I.T.(mN/m).1,I.T.(mN/m).2,I.T.(mN/m).3,I.T.(mN/m).4,"
            "I.T.(mN/m).5,I.T.(mN/m).6,I.T.(mN/m).7\n"
            "0,10,20,,40,,,70\n"
            "1,11,21,,41,,,71\n"
        )
        path = self._write_temp_csv(content)

        try:
            payload = analyze_plot_file(path, "", "", "1-7", False)
            self.assertEqual(payload["defaultExpRange"], "1-2,4,7")
            self.assertEqual([series["name"] for series in payload["series"]], [
                "I.T.(mN/m).1",
                "I.T.(mN/m).2",
                "I.T.(mN/m).4",
                "I.T.(mN/m).7",
            ])
        finally:
            os.unlink(path)

    def test_analyze_plot_file_treats_zero_first_cell_as_non_empty(self):
        content = "Time (ms),I.T.(mN/m).1,I.T.(mN/m).2\n0,0,\n1,1,\n"
        path = self._write_temp_csv(content)

        try:
            payload = analyze_plot_file(path, "", "", "1-2", False)
            self.assertEqual(payload["defaultExpRange"], "1")
            self.assertEqual(payload["summary"]["seriesCount"], 1)
            self.assertEqual(payload["series"][0]["y"], [0, 1])
        finally:
            os.unlink(path)

    def test_analyze_plot_file_treats_symbol_first_cell_as_non_empty(self):
        content = "Time (ms),I.T.(mN/m).1,I.T.(mN/m).2\n0,ERR,\n1,12,\n"
        path = self._write_temp_csv(content)

        try:
            payload = analyze_plot_file(path, "", "", "1-2", False)
            self.assertEqual(payload["defaultExpRange"], "1")
            self.assertEqual(payload["summary"]["seriesCount"], 1)
            self.assertEqual(payload["series"][0]["y"], [12])
        finally:
            os.unlink(path)

    def test_empty_first_cells_are_detected_as_empty(self):
        df = pd.DataFrame({
            "I.T.(mN/m).1": [""],
            "I.T.(mN/m).2": [None],
            "I.T.(mN/m).3": [np.nan],
            "I.T.(mN/m).4": ["  "],
            "I.T.(mN/m).5": [0],
        })

        self.assertFalse(first_data_cell_has_value(""))
        self.assertFalse(first_data_cell_has_value(None))
        self.assertFalse(first_data_cell_has_value(np.nan))
        self.assertTrue(first_data_cell_has_value(0))
        self.assertTrue(first_data_cell_has_value("ERR"))
        self.assertEqual(
            detect_non_empty_experiments(df, list(df.columns)),
            [5],
        )
        self.assertEqual(format_experiment_range([1, 2, 4, 7]), "1-2,4,7")

    def test_analyze_plot_file_raises_when_no_selected_experiments_have_data(self):
        content = "Time (ms),I.T.(mN/m).1,I.T.(mN/m).2\n0,,\n1,,\n"
        path = self._write_temp_csv(content)

        try:
            with self.assertRaisesRegex(
                Exception,
                "No non-empty experiments were detected in the selected data.",
            ):
                analyze_plot_file(path, "", "", "1-2", False)
        finally:
            os.unlink(path)

    def test_famas_loader_preserves_symbol_for_non_empty_detection(self):
        content = (
            ",1,2\n"
            "時間(ms),I.T.(mN/m),I.T.(mN/m)\n"
            "0,ERR,\n"
            "1,12,\n"
            "2,13,\n"
            "3,14,\n"
            "4,15,\n"
        )
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="shift_jis") as handle:
            handle.write(content)
            path = handle.name

        try:
            payload = analyze_plot_file(path, "", "", "1-2", False)
            self.assertEqual(payload["defaultExpRange"], "1")
            self.assertEqual(payload["summary"]["seriesCount"], 1)
            self.assertEqual(payload["series"][0]["name"], "I.T.(mN/m).1")
        finally:
            os.unlink(path)

    def test_analyze_time_series_quality(self):
        content = "Time (ms),I.T.(mN/m).1\n0,10\n1,11\n1,12\n5,100\n6,14\n7,15\n"
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as handle:
            handle.write(content)
            path = handle.name

        try:
            payload = analyze_time_series_quality(path, "", "", "1", False)
            codes = {warning["code"] for warning in payload["warnings"]}
            self.assertIn("duplicate-time-values", codes)
            self.assertIn("large-time-gaps", codes)
            self.assertEqual(payload["summary"]["seriesCount"], 1)
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

    def test_analyze_plot_noise_psd_with_subtracted_trend(self):
        content = "Time (ms),I.T.(mN/m).1\n0,1.0\n1,1.2\n2,1.5\n3,1.7\n4,1.8\n5,2.0\n6,2.2\n7,2.4\n"
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
                "psd",
                {"processingMode": "subtract_extracted_trend"},
                {
                    "methodKey": "moving_average",
                    "parameters": {"windowSize": "3", "windowUnit": "points"},
                },
            )
            self.assertEqual(payload["method"]["key"], "psd")
            self.assertEqual(payload["method"]["parameters"]["processingMode"], "subtract_extracted_trend")
            self.assertEqual(payload["summaryColumns"][1], "Processing")
            self.assertEqual(payload["summaryRows"][0]["Processing"], "Subtract extracted trend")
        finally:
            os.unlink(path)

    def test_analyze_plot_file_avg_only_uses_selected_experiment_range(self):
        content = (
            "Time (ms),I.T.(mN/m).1,I.T.(mN/m).2,I.T.(mN/m).3,Avg\n"
            "0,10,20,100,999\n"
            "1,12,22,102,999\n"
            "2,14,24,104,999\n"
        )
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as handle:
            handle.write(content)
            path = handle.name

        try:
            payload = analyze_plot_file(path, "", "", "1-2", True)
            self.assertEqual(payload["summary"]["seriesCount"], 1)
            self.assertEqual(payload["series"][0]["name"], "Avg (1-2)")
            self.assertEqual(payload["series"][0]["y"], [15.0, 17.0, 19.0])
        finally:
            os.unlink(path)

    def test_analyze_plot_file_avg_only_can_show_original_series(self):
        content = (
            "Time (ms),I.T.(mN/m).1,I.T.(mN/m).2,I.T.(mN/m).3,Avg\n"
            "0,10,20,100,999\n"
            "1,12,22,102,999\n"
            "2,14,24,104,999\n"
        )
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as handle:
            handle.write(content)
            path = handle.name

        try:
            payload = analyze_plot_file(path, "", "", "1-2", True, True)
            self.assertEqual(payload["summary"]["seriesCount"], 3)
            self.assertEqual([series["name"] for series in payload["series"]], ["I.T.(mN/m).1", "I.T.(mN/m).2", "Avg (1-2)"])
            self.assertEqual(payload["series"][-1]["y"], [15.0, 17.0, 19.0])
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
