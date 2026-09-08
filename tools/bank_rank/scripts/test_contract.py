#!/usr/bin/env python3
"""Offline regression tests: invalid inputs must fail before publication."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

DATA = module("validate_data")
VERIFY = module("validate_verification")
STATIC = module("render_static")


class DataContractTests(unittest.TestCase):
    def setUp(self):
        self.data = DATA.load_rankings()
        self.snapshot = DATA.load_snapshot()

    def test_production_passes(self):
        self.assertEqual(DATA.validate_dataset(self.data, self.snapshot), [])
        self.assertEqual(VERIFY.validate(), [])

    def test_non_finite_or_coerced_financial_values_are_rejected(self):
        for field in ("coreTier1Capital", "assets", "netProfit"):
            for value in (float("nan"), float("inf"), float("-inf"), True, "123.45", None):
                with self.subTest(field=field, value=repr(value)):
                    data, snapshot = copy.deepcopy(self.data), copy.deepcopy(self.snapshot)
                    data["years"][0]["records"][0][field] = value
                    # Keep the digest synchronized so it cannot mask a missing field check.
                    snapshot["years"][0]["normalizedRecordsSha256"] = DATA.records_digest(data["years"][0]["records"])
                    errors = DATA.validate_dataset(data, snapshot)
                    self.assertTrue(any(f"invalid {field}" in error for error in errors), errors)

    def test_duplicate_snapshot_year_is_rejected(self):
        self.snapshot["years"].append(copy.deepcopy(self.snapshot["years"][0]))
        self.assertTrue(DATA.validate_dataset(self.data, self.snapshot))

    def test_empty_dataset_is_rejected(self):
        self.data.update(banks=[], years=[], relations=[])
        self.snapshot["years"] = []
        self.assertTrue(DATA.validate_dataset(self.data, self.snapshot))

    def test_boolean_rank_is_rejected(self):
        self.data["years"][0]["records"][0]["rank"] = True
        self.snapshot["years"][0]["normalizedRecordsSha256"] = DATA.records_digest(self.data["years"][0]["records"])
        self.assertTrue(any("invalid rank" in error for error in DATA.validate_dataset(self.data, self.snapshot)))

    def test_bad_relations_are_rejected(self):
        cases = [("sourceUrl", "javascript:alert(1)"), ("sourceUrl", "https://"),
                 ("sourceUrl", "https://user:password@example.com/"), ("date", "2025-02-30"),
                 ("type", "unknown"), ("fromName", "未登记的同一主体"), ("toName", "其他银行"),
                 ("note", []), ("bankId", "b_unknown")]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                data = copy.deepcopy(self.data)
                data["relations"][0][field] = value
                self.assertTrue(DATA.validate_dataset(data, self.snapshot))

    def test_malformed_records_return_errors(self):
        for section, value in (("banks", [None]), ("years", [None]), ("relations", [None])):
            with self.subTest(section=section):
                data = copy.deepcopy(self.data)
                data[section] = value
                self.assertTrue(DATA.validate_dataset(data, self.snapshot))
        self.data["years"][0]["records"][0] = None
        self.assertTrue(DATA.validate_dataset(self.data, self.snapshot))

    def test_manifest_paths_cannot_escape_data_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_dir = root / "data"
            data_dir.mkdir()
            manifest = json.loads((ROOT / "data/rankings.json").read_text(encoding="utf-8"))
            manifest["banksFile"] = "../outside.json"
            (root / "outside.json").write_text("[]", encoding="utf-8")
            (data_dir / "rankings.json").write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "path|file|路径"):
                DATA.load_rankings(data_dir)

    def test_non_numeric_evidence_never_compares_equal(self):
        for value in ("NaN", "nan", "sNaN", "Infinity", "-Infinity", "not-a-number", None, True):
            with self.subTest(value=value):
                self.assertFalse(VERIFY._numeric_equal(value, value))
        self.assertTrue(VERIFY._numeric_equal("(34.94)", -34.94))
        self.assertTrue(VERIFY._numeric_equal("1,234.50", 1234.5))

    def test_metadata_and_file_contracts_are_rejected(self):
        for field, value in (("schemaVersion", True), ("banksFile", "other.json"), ("relationsFile", "../relations.json")):
            with self.subTest(field=field):
                data = copy.deepcopy(self.data)
                data[field] = value
                self.assertTrue(DATA.validate_dataset(data, self.snapshot))
        for field, value in (("rankingYear", 2016.5), ("dataYear", True), ("recordsFile", "years/2025.json"), ("publishedAt", "2025-02-30")):
            with self.subTest(field=field):
                data = copy.deepcopy(self.data)
                data["years"][0][field] = value
                self.assertTrue(DATA.validate_dataset(data, self.snapshot))

    def test_missing_prior_year_is_not_absent_bank(self):
        missing = self.data["years"][-1]["rankingYear"] - 1
        self.data["years"] = [block for block in self.data["years"] if block["rankingYear"] != missing]
        self.data["scope"]["historicalBackfillPending"] = [missing]
        self.snapshot["years"] = [block for block in self.snapshot["years"] if block["rankingYear"] != missing]
        self.assertEqual(DATA.validate_dataset(self.data, self.snapshot), [])
        rendered = STATIC.render(self.data, (ROOT / "index.html").read_text(encoding="utf-8"))
        self.assertEqual(rendered.count('class="change new">上年未收录</span>'), 100)

    def test_static_markers_must_be_unique(self):
        with self.assertRaises(RuntimeError):
            STATIC.replace_marker_block("START a END START b END", "START", "END", "new")
        with self.assertRaises(RuntimeError):
            STATIC.replace_marker_block("END START", "START", "END", "new")

    def test_static_generator_refuses_invalid_data_without_overwrite(self):
        self.data["years"][0]["records"][0]["assets"] = -1
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "index.html"
            original = (ROOT / "index.html").read_text(encoding="utf-8")
            target.write_text(original, encoding="utf-8")
            with patch.object(STATIC, "HTML_PATH", target), patch.object(STATIC.MODULE, "load_rankings", return_value=self.data), patch("sys.argv", ["render_static.py"]):
                self.assertNotEqual(STATIC.main(), 0)
            self.assertEqual(target.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
