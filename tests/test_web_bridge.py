import os
import sys
import tempfile
import time
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
from DataProcessor.services.dataframe_loader import (  # noqa: E402
    parse_famas_measurement_detail_volumes,
    parse_famas_metadata,
)
from DataProcessor.services.cmc_analysis import fit_cmc_curve  # noqa: E402
from web_bridge import (  # noqa: E402
    analyze_cmc_files,
    analyze_plot_file,
    analyze_plot_noise,
    build_cmc_plot_payload_from_review,
    analyze_time_series_quality,
    extract_plot_trend,
    infer_concentration,
    review_cmc_files,
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

    def _write_cmc_famas_csv(self, gamma_traces, volume_traces=None) -> str:
        time_values = [idx * 1000 for idx in range(len(gamma_traces[0]))]
        volume_traces = volume_traces or [
            [10.0 for _ in time_values]
            for _ in gamma_traces
        ]
        prefix = [""]
        header = ["時間(ms)"]
        for exp_index in range(1, len(gamma_traces) + 1):
            prefix.extend([str(exp_index), str(exp_index)])
            header.extend(["I.T.(mN/m)", "V(uL)"])
        prefix.append("Avg.")
        header.append("I.T.(mN/m)")

        rows = [["[WORKSHEET]"], ["解析法", "懸滴法"], ["繰り返し数", str(len(gamma_traces))], prefix, header]
        for row_index, time_value in enumerate(time_values):
            row = [str(time_value)]
            gamma_values = []
            for gamma_trace, volume_trace in zip(gamma_traces, volume_traces):
                row.append(str(gamma_trace[row_index]))
                row.append(str(volume_trace[row_index]))
                gamma_values.append(float(gamma_trace[row_index]))
            row.append(str(sum(gamma_values) / len(gamma_values)))
            rows.append(row)

        content = "\n".join(",".join(row) for row in rows) + "\n"
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="shift_jis") as handle:
            handle.write(content)
            return handle.name

    def _write_famas_slots_fixture(
        self,
        *,
        configured_slots: int = 10,
        actual_repeats: int = 3,
        row_count: int = 12,
        volume_traces=None,
        gamma_traces=None,
    ) -> str:
        time_values = [idx * 1000 for idx in range(row_count)]
        if gamma_traces is None:
            gamma_traces = [
                [70.0 + exp + (0.02 if idx >= row_count // 2 else 0.5 - idx * 0.05) for idx in range(row_count)]
                for exp in range(actual_repeats)
            ]
        if volume_traces is None:
            volume_traces = [
                [10.0 - idx * 0.01 for idx in range(row_count)]
                for _ in range(actual_repeats)
            ]

        prefix = [""]
        header = ["時間(ms)"]
        for exp_index in range(1, configured_slots + 1):
            prefix.extend([str(exp_index), str(exp_index), str(exp_index)])
            header.extend(["d(g/cm^3)", "I.T.(mN/m)", "V(uL)"])
        prefix.extend(["Avg.", "S.D."])
        header.extend(["I.T.(mN/m)", "I.T.(mN/m)"])

        rows = [
            ["[WORKSHEET]"],
            ["測定間隔(ms)", "1000"],
            ["回数", str(row_count)],
            ["解析方法", "Fitting-Laplace"],
            ["測定までの待ち時間(ms)", "1000"],
            ["作成液量(uL)", "10"],
            ["くり返し回数", str(actual_repeats)],
            ["d(g/cm^3)", "1.0000"],
            prefix,
            header,
        ]
        for row_index, time_value in enumerate(time_values):
            row = [str(time_value)]
            actual_gamma_values = []
            for exp_index in range(1, configured_slots + 1):
                row.append("1.0000")
                if exp_index <= actual_repeats:
                    gamma = gamma_traces[exp_index - 1][row_index]
                    volume = volume_traces[exp_index - 1][row_index]
                    row.append(str(gamma))
                    row.append(str(volume))
                    actual_gamma_values.append(float(gamma))
                else:
                    row.append("0" if row_index == 0 else "")
                    row.append("")
            row.append(str(sum(actual_gamma_values) / len(actual_gamma_values)))
            row.append("0.1")
            rows.append(row)

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
            self.assertIn("fit", payload)
            self.assertIn(
                "NOT_ENOUGH_CONCENTRATIONS",
                [warning["code"] for warning in payload["fit"]["warnings"]],
            )
        finally:
            os.unlink(path)

    def test_analyze_cmc_files_uses_famas_droplet_columns_and_metadata(self):
        rows = [
            ["[WORKSHEET]"],
            ["解析法", "懸滴法"],
            ["繰り返し数", "3"],
            ["", "1", "1", "1", "2", "2", "2", "3", "3", "3", "Avg.", "S.D."],
            [
                "時間(ms)",
                "d(g/cm^3)",
                "I.T.(mN/m)",
                "V(uL)",
                "d(g/cm^3)",
                "I.T.(mN/m)",
                "V(uL)",
                "d(g/cm^3)",
                "I.T.(mN/m)",
                "V(uL)",
                "I.T.(mN/m)",
                "I.T.(mN/m)",
            ],
            ["0", "0.998", "70.0", "5.0", "0.998", "71.0", "5.1", "0.998", "72.0", "5.2", "99.0", "1.0"],
            ["1000", "0.998", "70.2", "5.0", "0.998", "71.2", "5.1", "0.998", "72.2", "5.2", "99.0", "1.0"],
            ["2000", "0.998", "70.4", "5.0", "0.998", "71.4", "5.1", "0.998", "72.4", "5.2", "99.0", "1.0"],
        ]
        content = "\n".join(",".join(row) for row in rows) + "\n"
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="shift_jis") as handle:
            handle.write(content)
            path = handle.name

        try:
            metadata = parse_famas_metadata(path)
            self.assertEqual(metadata["sourceFormat"], "famas_multi_experiment_csv")
            self.assertEqual(metadata["analysisMethod"], "懸滴法")
            self.assertEqual(metadata["repeatCount"], 3)
            self.assertEqual(metadata["configuredExperimentSlotCount"], 3)
            self.assertEqual(metadata["actualRepeatCount"], 3)
            self.assertAlmostEqual(metadata["densityDeltaGPerCm3"], 0.998)

            payload = analyze_cmc_files(
                entries=[{"path": path, "filename": "2mM.csv", "concentration": "2.0"}],
                t_min_text="0",
                t_max_text="2000",
                c_unit="mM",
                use_log=False,
                options={"maxAbsSlopeMnMPerMin": 99},
            )

            self.assertEqual(payload["points"][0]["dropletCount"], 3)
            self.assertAlmostEqual(payload["points"][0]["y"], 71.2)
            file_info = payload["files"][0]
            self.assertEqual(file_info["detectedDropletCount"], 3)
            self.assertEqual(file_info["metadata"]["analysisMethod"], "懸滴法")
            self.assertEqual(file_info["metadata"]["repeatCount"], 3)
            self.assertEqual(file_info["metadata"]["configuredExperimentSlotCount"], 3)
            self.assertEqual(file_info["metadata"]["actualRepeatCount"], 3)
            self.assertAlmostEqual(file_info["metadata"]["densityDeltaGPerCm3"], 0.998)
            self.assertEqual(
                [droplet["sourceColumn"] for droplet in file_info["droplets"]],
                ["I.T.(mN/m).1", "I.T.(mN/m).2", "I.T.(mN/m).3"],
            )
            self.assertTrue(all(droplet["hasVolume"] for droplet in file_info["droplets"]))
            self.assertTrue(
                all(droplet["densityDeltaGPerCm3"] == 0.998 for droplet in file_info["droplets"])
            )
        finally:
            os.unlink(path)

    def test_analyze_cmc_files_auto_plateau_returns_three_droplets(self):
        path = self._write_cmc_famas_csv([
            [73, 72, 71, 70.2, 70.1, 70.0, 70.0, 70.0, 70.0, 70.0, 70.0],
            [74, 73, 72, 71.2, 71.1, 71.0, 71.0, 71.0, 71.0, 71.0, 71.0],
            [75, 74, 73, 72.2, 72.1, 72.0, 72.0, 72.0, 72.0, 72.0, 72.0],
        ])

        try:
            payload = analyze_cmc_files(
                entries=[{"path": path, "filename": "3mM.csv", "concentration": "3.0"}],
                t_min_text="0",
                t_max_text="10000",
                c_unit="mM",
                use_log=False,
                options={"plateauMode": "auto", "minPlateauWindowMs": 4000},
            )
            file_info = payload["files"][0]
            self.assertEqual(file_info["detectedDropletCount"], 3)
            self.assertEqual(payload["rows"][0]["dropletCount"], 3)
            self.assertEqual(payload["rows"][0]["usedDropletCount"], 3)
            self.assertTrue(all(droplet["qc"]["usedForAggregate"] for droplet in file_info["droplets"]))
            self.assertTrue(all(droplet["qc"]["plateauStartMs"] >= 3000 for droplet in file_info["droplets"]))
        finally:
            os.unlink(path)

    def test_famas_review_counts_actual_repeats_not_reserved_slots(self):
        path = self._write_famas_slots_fixture(configured_slots=10, actual_repeats=3, row_count=12)

        try:
            metadata = parse_famas_metadata(path)
            self.assertEqual(metadata["repeatCount"], 3)
            self.assertEqual(metadata["rawRepeatCount"], 3)
            self.assertEqual(metadata["configuredExperimentSlotCount"], 10)
            self.assertEqual(metadata["actualRepeatCount"], 3)
            self.assertEqual(metadata["analysisMethod"], "Fitting-Laplace")
            self.assertAlmostEqual(metadata["densityDeltaGPerCm3"], 1.0)
            self.assertEqual(metadata["measurementIntervalMs"], 1000)
            self.assertEqual(metadata["measurementCount"], 12)
            self.assertEqual(metadata["targetDropVolumeUL"], 10)
            self.assertEqual(metadata["waitBeforeMeasurementMs"], 1000)

            review = review_cmc_files(
                entries=[{"path": path, "filename": "slots.csv"}],
                t_min_text="0",
                t_max_text="11000",
                options={"plateauMode": "auto", "minPlateauWindowMs": 4000},
            )
            self.assertEqual(review["files"][0]["detectedDropletCount"], 3)
            self.assertEqual(len(review["droplets"]), 3)
            self.assertEqual(
                [droplet["sourceColumn"] for droplet in review["files"][0]["droplets"]],
                ["I.T.(mN/m).1", "I.T.(mN/m).2", "I.T.(mN/m).3"],
            )
            self.assertEqual(review["files"][0]["metadata"]["configuredExperimentSlotCount"], 10)
            self.assertEqual(review["files"][0]["metadata"]["actualRepeatCount"], 3)
        finally:
            os.unlink(path)

    def test_cmc_volume_qc_separates_full_and_plateau_loss(self):
        stable_gamma = [[70.0 for _ in range(20)], [71.0 for _ in range(20)], [72.0 for _ in range(20)]]
        volumes = [
            [10.0 - idx * 0.03 for idx in range(20)],
            [10.0 for _ in range(20)],
            [10.0 for _ in range(20)],
        ]
        path = self._write_famas_slots_fixture(
            configured_slots=10,
            actual_repeats=3,
            row_count=20,
            gamma_traces=stable_gamma,
            volume_traces=volumes,
        )

        try:
            payload = analyze_cmc_files(
                entries=[{"path": path, "filename": "evap.csv", "concentration": "1"}],
                t_min_text="15000",
                t_max_text="19000",
                c_unit="mM",
                use_log=False,
                options={
                    "plateauMode": "manual",
                    "minPlateauWindowMs": 4000,
                    "maxVolumeLossPct": 3.0,
                    "maxEvaporationRatePctPerMin": 100.0,
                },
            )
            qc = payload["files"][0]["droplets"][0]["qc"]
            self.assertGreater(qc["fullVolumeLossPct"], qc["plateauVolumeLossPct"])
            self.assertIn("HIGH_VOLUME_LOSS", qc["flags"])
            self.assertFalse(qc["usedForAggregate"])
            self.assertEqual(payload["rows"][0]["usedDropletCount"], 2)
        finally:
            os.unlink(path)

    def test_cmc_full_evaporation_rate_flags_used_false(self):
        path = self._write_cmc_famas_csv(
            [
                [70.0 for _ in range(11)],
                [71.0 for _ in range(11)],
                [72.0 for _ in range(11)],
            ],
            volume_traces=[
                [10.0 - idx * 0.06 for idx in range(11)],
                [10.0 for _ in range(11)],
                [10.0 for _ in range(11)],
            ],
        )

        try:
            payload = analyze_cmc_files(
                entries=[{"path": path, "filename": "rate.csv", "concentration": "2"}],
                t_min_text="0",
                t_max_text="10000",
                c_unit="mM",
                use_log=False,
                options={
                    "plateauMode": "auto",
                    "minPlateauWindowMs": 4000,
                    "maxVolumeLossPct": 99.0,
                    "maxEvaporationRatePctPerMin": 0.5,
                },
            )
            qc = payload["files"][0]["droplets"][0]["qc"]
            self.assertIn("HIGH_EVAPORATION", qc["flags"])
            self.assertFalse(qc["usedForAggregate"])
        finally:
            os.unlink(path)

    def test_cmc_outlier_within_concentration_defaults_used_false(self):
        path = self._write_cmc_famas_csv([
            [70.0 for _ in range(11)],
            [71.0 for _ in range(11)],
            [72.0 for _ in range(11)],
            [90.0 for _ in range(11)],
        ])

        try:
            payload = analyze_cmc_files(
                entries=[{"path": path, "filename": "outlier.csv", "concentration": "3"}],
                t_min_text="0",
                t_max_text="10000",
                c_unit="mM",
                use_log=False,
                options={"plateauMode": "manual"},
            )
            outlier_qc = payload["files"][0]["droplets"][-1]["qc"]
            self.assertIn("OUTLIER_WITHIN_CONCENTRATION", outlier_qc["flags"])
            self.assertFalse(outlier_qc["usedForAggregate"])
            self.assertEqual(payload["rows"][0]["usedDropletCount"], 3)
        finally:
            os.unlink(path)

    def test_cmc_auto_plateau_performance_for_many_points(self):
        row_count = 600
        gamma_traces = []
        volume_traces = []
        for exp in range(3):
            gamma_traces.append([
                76.0 - idx * 0.02 if idx < 200 else 70.0 + exp + np.sin(idx / 20) * 0.02
                for idx in range(row_count)
            ])
            volume_traces.append([10.0 - idx * 0.0005 for idx in range(row_count)])
        path = self._write_famas_slots_fixture(
            configured_slots=10,
            actual_repeats=3,
            row_count=row_count,
            gamma_traces=gamma_traces,
            volume_traces=volume_traces,
        )

        try:
            start = time.perf_counter()
            review = review_cmc_files(
                entries=[{"path": path, "filename": "large.csv"}],
                t_min_text="0",
                t_max_text=str((row_count - 1) * 1000),
                options={
                    "plateauMode": "auto",
                    "minPlateauWindowMs": 30000,
                    "plateauSearchStrideMs": 5000,
                },
            )
            elapsed = time.perf_counter() - start
            self.assertEqual(review["files"][0]["detectedDropletCount"], 3)
            self.assertLess(elapsed, 2.0)
            for droplet in review["files"][0]["droplets"]:
                self.assertGreaterEqual(droplet["qc"]["plateauStartMs"], 170000)
                self.assertAlmostEqual(droplet["qc"]["gammaEq"], 70.0 + droplet["dropletIndex"] - 1, delta=0.2)
        finally:
            os.unlink(path)

    def test_analyze_cmc_files_auto_flags_high_final_drift(self):
        path = self._write_cmc_famas_csv([
            [70.0 + idx * 0.1 for idx in range(11)],
            [71.0 for _ in range(11)],
            [72.0 for _ in range(11)],
        ])

        try:
            payload = analyze_cmc_files(
                entries=[{"path": path, "filename": "4mM.csv", "concentration": "4.0"}],
                t_min_text="0",
                t_max_text="10000",
                c_unit="mM",
                use_log=False,
                options={
                    "plateauMode": "auto",
                    "minPlateauWindowMs": 4000,
                    "maxAbsSlopeMnMPerMin": 0.5,
                },
            )
            flags = payload["files"][0]["droplets"][0]["qc"]["flags"]
            self.assertIn("HIGH_FINAL_DRIFT", flags)
            self.assertFalse(payload["files"][0]["droplets"][0]["qc"]["usedForAggregate"])
            self.assertEqual(payload["rows"][0]["usedDropletCount"], 2)
        finally:
            os.unlink(path)

    def test_analyze_cmc_files_auto_flags_high_volume_loss(self):
        path = self._write_cmc_famas_csv(
            [
                [70.0 for _ in range(11)],
                [71.0 for _ in range(11)],
                [72.0 for _ in range(11)],
            ],
            volume_traces=[
                [10.0 - idx * 0.3 for idx in range(11)],
                [10.0 for _ in range(11)],
                [10.0 for _ in range(11)],
            ],
        )

        try:
            payload = analyze_cmc_files(
                entries=[{"path": path, "filename": "5mM.csv", "concentration": "5.0"}],
                t_min_text="0",
                t_max_text="10000",
                c_unit="mM",
                use_log=False,
                options={
                    "plateauMode": "auto",
                    "minPlateauWindowMs": 4000,
                    "maxVolumeLossPct": 10,
                },
            )
            qc = payload["files"][0]["droplets"][0]["qc"]
            self.assertIn("HIGH_VOLUME_LOSS", qc["flags"])
            self.assertGreater(qc["fullVolumeLossPct"], 10)
            self.assertIsNotNone(qc["plateauVolumeLossPct"])
            self.assertFalse(qc["usedForAggregate"])
        finally:
            os.unlink(path)

    def test_analyze_cmc_files_manual_mode_keeps_old_time_window_behavior(self):
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
                options={"plateauMode": "manual"},
            )
            self.assertEqual(payload["summary"]["plateauMode"], "manual")
            self.assertEqual(payload["rows"][0]["usedDropletCount"], 2)
            self.assertEqual(payload["points"][0]["y"], 12.5)
            self.assertEqual(
                [droplet["qc"]["gammaEq"] for droplet in payload["files"][0]["droplets"]],
                [12.0, 13.0],
            )
        finally:
            os.unlink(path)

    def test_fit_cmc_curve_sds_like_segmented_breakpoint(self):
        log_c = np.asarray([-3.0, -2.5, -2.0, -1.5, -1.2, -0.8, -0.5, 0.0])
        concentrations = np.power(10.0, log_c)
        gamma = [75.0, 70.0, 65.0, 60.0, 57.0, 55.0, 55.0, 55.1]
        points = [
            {"concentration": float(c), "y": y, "error": 0.1}
            for c, y in zip(concentrations, gamma)
        ]

        fit = fit_cmc_curve(points, {
            "model": "segmented_flat_plateau",
            "sampleType": "single",
            "nBootstrap": 40,
        })

        self.assertEqual(fit["modelKey"], "segmented_flat_plateau")
        self.assertAlmostEqual(fit["cmcLog10"], -1.0, delta=0.08)
        self.assertAlmostEqual(fit["cmc"], 0.1, delta=0.025)
        self.assertEqual(fit["cmcMarker"]["label"], "CMC")
        self.assertTrue(fit["fitSeries"][0]["x"])

    def test_fit_cmc_curve_excludes_nonpositive_blank_from_log_fit(self):
        log_c = np.asarray([-3.0, -2.5, -2.0, -1.5, -1.2, -0.8])
        points = [{"concentration": 0.0, "y": 72.0, "error": 0.2}]
        points.extend(
            {"concentration": float(10 ** x), "y": float(75 + -10 * (x + 3)), "error": 0.2}
            for x in log_c
        )

        fit = fit_cmc_curve(points, {"model": "segmented_continuous", "nBootstrap": 0})

        self.assertNotIn(0, fit["usedPointIndexes"])
        self.assertIn(
            "LOG_REQUIRES_POSITIVE_CONCENTRATIONS",
            [warning["code"] for warning in fit["warnings"]],
        )

    def test_fit_cmc_curve_not_enough_points_warns_without_exception(self):
        fit = fit_cmc_curve([
            {"concentration": 0.001, "y": 72.0},
            {"concentration": 0.01, "y": 62.0},
            {"concentration": 0.1, "y": 52.0},
        ], {"model": "segmented_continuous"})

        self.assertIsNone(fit["cmc"])
        self.assertEqual(fit["fitSeries"], [])
        self.assertIn(
            "NOT_ENOUGH_CONCENTRATIONS",
            [warning["code"] for warning in fit["warnings"]],
        )

    def test_fit_cmc_curve_wsom_uses_apparent_label(self):
        log_c = np.asarray([-3.0, -2.5, -2.0, -1.5, -1.2, -0.8, -0.5, 0.0])
        points = [
            {"concentration": float(10 ** x), "y": y, "error": 0.2}
            for x, y in zip(log_c, [75, 70, 65, 60, 57, 55, 55, 55])
        ]

        fit = fit_cmc_curve(points, {
            "model": "segmented_flat_plateau",
            "sampleType": "WSOM",
            "nBootstrap": 0,
        })

        self.assertEqual(fit["cmcMarker"]["label"], "apparent CMC/CAC")
        self.assertIn("apparent CMC/CAC", fit["equationText"])

    def _surface_tension_points(self):
        concentrations = np.asarray([0.01, 0.03, 0.1, 0.3, 1, 2, 4, 6, 8, 12, 20, 40, 80], dtype=float)
        x0 = np.log10(8.0)
        sigma = []
        for concentration in concentrations:
            x = np.log10(concentration)
            if concentration < 1:
                sigma.append(72.0)
            elif concentration < 8:
                sigma.append(39.0 - 20.0 * (x - x0))
            else:
                sigma.append(39.0)
        return [
            {"concentration": float(concentration), "sigmaValue": float(value), "sigmaError": 0.2}
            for concentration, value in zip(concentrations, sigma)
        ]

    def test_surface_tension_cmc_fits_plateau_intersection_not_onset(self):
        fit = fit_cmc_curve(self._surface_tension_points(), {
            "sampleType": "single",
            "nBootstrap": 0,
        })

        self.assertEqual(fit["modelKey"], "surface_tension_cmc")
        self.assertEqual(fit["modelLabel"], "Surface tension CMC")
        self.assertAlmostEqual(fit["cmc"], 8.0, delta=0.4)
        self.assertGreater(fit["cmc"], 3.0)
        self.assertAlmostEqual(fit["sigmaAtCmc"], 39.0, delta=0.2)
        self.assertEqual(fit["gammaAtCmc"], fit["sigmaAtCmc"])
        self.assertEqual(len(fit["fitSeries"]), 2)
        self.assertIn("σ", fit["equationText"])

    def test_segmented_continuous_still_runs_but_is_not_default(self):
        default_fit = fit_cmc_curve(self._surface_tension_points(), {"nBootstrap": 0})
        trend_fit = fit_cmc_curve(self._surface_tension_points(), {
            "model": "segmented_continuous",
            "nBootstrap": 0,
        })

        self.assertEqual(default_fit["modelKey"], "surface_tension_cmc")
        self.assertEqual(trend_fit["modelKey"], "segmented_continuous")
        self.assertEqual(
            trend_fit["modelLabel"],
            "Trend breakpoint (not recommended for σ-CMC)",
        )
        self.assertIsNotNone(trend_fit["cmc"])

    def test_surface_tension_cmc_records_excluded_low_baseline_points(self):
        fit = fit_cmc_curve(self._surface_tension_points(), {"nBootstrap": 0})

        excluded = fit["parameters"]["excludedLowConcentrationPointIndexes"]
        self.assertEqual(excluded, [0, 1, 2, 3])
        self.assertIn(
            "LOW_CONCENTRATION_BASELINE_EXCLUDED",
            [warning["code"] for warning in fit["warnings"]],
        )

    def test_surface_tension_cmc_plot_scale_changes_display_not_cmc(self):
        points = self._surface_tension_points()
        fit_linear = fit_cmc_curve(points, {
            "fitModel": "surface_tension_cmc",
            "plotUseLog": False,
            "nBootstrap": 0,
        })
        fit_log = fit_cmc_curve(points, {
            "fitModel": "surface_tension_cmc",
            "plotUseLog": True,
            "nBootstrap": 0,
        })

        self.assertAlmostEqual(fit_linear["cmc"], fit_log["cmc"], delta=1e-9)
        self.assertAlmostEqual(fit_linear["cmcLog10"], fit_log["cmcLog10"], delta=1e-9)
        self.assertAlmostEqual(fit_linear["cmcMarker"]["x"], fit_linear["cmc"], delta=1e-9)
        self.assertAlmostEqual(fit_log["cmcMarker"]["x"], fit_log["cmcLog10"], delta=1e-9)
        self.assertNotEqual(fit_linear["fitSeries"][0]["x"][0], fit_log["fitSeries"][0]["x"][0])

    def test_surface_tension_cmc_n_bootstrap_zero_skips_ci(self):
        fit = fit_cmc_curve(self._surface_tension_points(), {"nBootstrap": 0})

        self.assertIsNone(fit["ciLow"])
        self.assertIsNone(fit["ciHigh"])
        self.assertNotIn("BOOTSTRAP_FAILED", [warning["code"] for warning in fit["warnings"]])

    def test_surface_tension_cmc_wsom_uses_apparent_label(self):
        fit = fit_cmc_curve(self._surface_tension_points(), {
            "sampleType": "WSOM",
            "nBootstrap": 0,
        })

        self.assertEqual(fit["transitionLabel"], "apparent CMC/CAC")
        self.assertEqual(fit["cmcMarker"]["label"], "apparent CMC/CAC")
        self.assertIn("apparent CMC/CAC", fit["equationText"])

    def test_build_cmc_plot_payload_from_review_reuses_qc_without_refitting_droplets(self):
        review = {
            "files": [],
            "options": {"fitModel": "surface_tension_cmc", "aggregationMethod": "mean"},
            "summary": {"timeWindow": [0, 10000], "plateauMode": "manual"},
        }
        for idx, point in enumerate(self._surface_tension_points()):
            review["files"].append({
                "filename": f"c{idx}.csv",
                "path": f"/tmp/c{idx}.csv",
                "metadata": {},
                "detectedDropletCount": 1,
                "droplets": [{
                    "dropletIndex": 1,
                    "qc": {
                        "gammaEq": point["sigmaValue"],
                        "usedForAggregate": True,
                        "flags": [],
                    },
                }],
            })

        payload_linear = build_cmc_plot_payload_from_review(review, {
            "concentrations": [
                {"filename": f"c{idx}.csv", "path": f"/tmp/c{idx}.csv", "concentration": point["concentration"]}
                for idx, point in enumerate(self._surface_tension_points())
            ],
            "useLog": False,
            "nBootstrap": 0,
        })
        payload_log = build_cmc_plot_payload_from_review(review, {
            "concentrations": [
                {"filename": f"c{idx}.csv", "path": f"/tmp/c{idx}.csv", "concentration": point["concentration"]}
                for idx, point in enumerate(self._surface_tension_points())
            ],
            "useLog": True,
            "nBootstrap": 0,
        })

        self.assertAlmostEqual(payload_linear["fit"]["cmc"], 8.0, delta=0.4)
        self.assertAlmostEqual(payload_linear["fit"]["cmc"], payload_log["fit"]["cmc"], delta=1e-9)
        self.assertAlmostEqual(payload_linear["fit"]["cmcMarker"]["x"], payload_linear["fit"]["cmc"], delta=1e-9)
        self.assertAlmostEqual(payload_log["fit"]["cmcMarker"]["x"], payload_log["fit"]["cmcLog10"], delta=1e-9)
        self.assertIn("sigmaValue", payload_linear["rows"][0])
        self.assertIn("sigmaError", payload_linear["points"][0])

    def test_build_cmc_plot_payload_skips_files_without_used_droplets(self):
        review = {
            "files": [
                {
                    "filename": "good.csv",
                    "path": "/tmp/good.csv",
                    "metadata": {},
                    "droplets": [
                        {"dropletIndex": 1, "qc": {"gammaEq": 70.0, "usedForAggregate": True, "flags": []}},
                    ],
                },
                {
                    "filename": "bad.csv",
                    "path": "/tmp/bad.csv",
                    "metadata": {},
                    "droplets": [
                        {"dropletIndex": 1, "qc": {"gammaEq": 80.0, "usedForAggregate": False, "flags": ["HIGH_NOISE"]}},
                    ],
                },
            ],
            "options": {"fitModel": "none", "aggregationMethod": "mean"},
            "summary": {"timeWindow": [0, 10000], "plateauMode": "manual"},
        }

        payload = build_cmc_plot_payload_from_review(review, {
            "concentrations": [
                {"filename": "good.csv", "path": "/tmp/good.csv", "concentration": "1"},
                {"filename": "bad.csv", "path": "/tmp/bad.csv", "concentration": "2"},
            ],
            "useLog": False,
        })

        self.assertEqual([row["filename"] for row in payload["rows"]], ["good.csv"])
        self.assertEqual(payload["summary"]["skippedFileCount"], 1)
        self.assertEqual(payload["skippedFiles"][0]["filename"], "bad.csv")
        self.assertEqual(payload["warnings"][0]["code"], "FILES_SKIPPED_NO_USED_DROPLETS")

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
