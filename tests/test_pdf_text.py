"""Request hardening and real CoreText outline checks (native checks require macOS)."""

import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pdf_text import PdfTextError, PdfTextOutliner, _run, _validate

ROOT = Path(__file__).resolve().parents[1]


def item(text="Hello", **updates):
    return {"id": "text-1", "text": text, "fontFamily": "Arial", "fontSize": 24,
            "fontWeight": "normal", "fontStyle": "normal", **updates}


class ValidationTests(unittest.TestCase):
    def test_normalizes_line_endings_and_numeric_weight(self):
        items, encoded = _validate({"items": [item("First\r\nSecond\r", fontWeight=700)]})
        self.assertEqual(items[0]["text"], "First\nSecond\n")
        self.assertEqual(items[0]["fontWeight"], "700")
        self.assertEqual(json.loads(encoded)["items"], items)

    def test_no_items_needs_no_native_helper(self):
        outliner = PdfTextOutliner(ROOT)
        with mock.patch.object(outliner, "_executable") as executable:
            self.assertEqual(outliner.outline({"items": []}), {"outlines": [], "substitutions": []})
            executable.assert_not_called()

    def test_rejects_invalid_or_unbounded_requests_before_native_execution(self):
        invalid = [None, {}, {"items": "hello"}, {"items": [], "path": "/tmp/font"},
                   {"items": [item(), item()]}, {"items": [item(id="")]},
                   {"items": [item(fontSize=True)]}, {"items": [item(fontSize=float("inf"))]},
                   {"items": [item(fontSize=10 ** 1000)]},
                   {"items": [item(fontSize=2001)]}, {"items": [item(fontWeight=250)]},
                   {"items": [item(fontWeight={})]}, {"items": [item(fontStyle="arbitrary")]},
                   {"items": [item(fontFamily="Arial\n")]}, {"items": [item("\x00")]},
                   {"items": [item("\ud800")]}, {"items": [item("x" * 100001)]},
                   {"items": [item(id=str(i)) for i in range(2001)]}]
        outliner = PdfTextOutliner(ROOT)
        with mock.patch.object(outliner, "_executable") as executable:
            for payload in invalid:
                with self.subTest(payload_type=type(payload).__name__):
                    with self.assertRaises(PdfTextError):
                        outliner.outline(payload)
            executable.assert_not_called()

    def test_rejects_malformed_native_output(self):
        outliner = PdfTextOutliner(ROOT)
        malformed = [b"", b"{}", b'[]', json.dumps({"outlines": [{"id": "text-1", "lines": [None]}]}).encode(),
                     json.dumps({"outlines": [{"id": "text-1", "lines": [{"width": 4, "path": "/Script Do"}]}]}).encode(),
                     json.dumps({"outlines": [{"id": "text-1", "lines": [{"width": 4, "path": "1e-6 0 m"}]}]}).encode(),
                     json.dumps({"outlines": [{"id": "other", "lines": [{"width": 4, "path": "0 0 m"}]}]}).encode()]
        with mock.patch.object(outliner, "_executable", return_value=Path("/trusted-helper")), mock.patch("pdf_text._run") as run:
            for output in malformed:
                run.return_value = (0, output, b"")
                with self.assertRaises(PdfTextError) as failure:
                    outliner.outline({"items": [item()]})
                self.assertEqual(failure.exception.status, 503)

    def test_nonmac_error_is_actionable(self):
        with mock.patch("pdf_text.sys.platform", "linux"):
            outliner = PdfTextOutliner(ROOT)
            self.assertFalse(outliner.available)
            with self.assertRaisesRegex(PdfTextError, "local macOS editor"):
                outliner.outline({"items": [item()]})


@unittest.skipUnless(sys.platform == "darwin" and Path("/usr/bin/xcrun").is_file(), "CoreText requires macOS")
class NativeOutlineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.outliner = PdfTextOutliner(ROOT)
        # Compile and exercise real native code once; do not convert build failures into skips.
        cls.outliner._executable()

    def outlines(self, *items):
        return self.outliner.outline({"items": list(items)})

    def test_latin_greek_and_cjk_have_vector_paths(self):
        for text in ("Arial XAS 123", "αβγ Δ χ μ Ω", "中文测试 譜線"):
            with self.subTest(text=text):
                result = self.outlines(item(text))
                line = result["outlines"][0]["lines"][0]
                self.assertGreater(line["width"], 0)
                self.assertIn(" m\n", line["path"])
                self.assertIn("h", line["path"])
                self.assertEqual(result["substitutions"], [])

    def test_empty_lines_and_spaces_are_preserved(self):
        lines = self.outlines(item("First\n\n   \n"))["outlines"][0]["lines"]
        self.assertEqual(len(lines), 4)
        self.assertEqual(lines[1], {"width": 0, "path": ""})
        self.assertGreater(lines[2]["width"], 0)
        self.assertEqual(lines[2]["path"], "")
        self.assertEqual(lines[3], {"width": 0, "path": ""})

    def test_weight_and_italic_change_real_glyph_geometry(self):
        normal = self.outlines(item("Hello"))["outlines"][0]["lines"][0]["path"]
        for changes in ({"fontWeight": "bold"}, {"fontStyle": "italic"}, {"fontWeight": "700", "fontStyle": "italic"}):
            with self.subTest(changes=changes):
                styled = self.outlines(item("Hello", **changes))["outlines"][0]["lines"][0]["path"]
                self.assertNotEqual(normal, styled)

    def test_unavailable_font_reports_substitution(self):
        result = self.outlines(item(fontFamily="MissingFont-628e1b24"))
        self.assertEqual(result["substitutions"], [{"id": "text-1", "requested": "MissingFont-628e1b24", "actual": "Arial"}])

    def test_generic_families_are_intentional_mappings(self):
        for family in ("sans-serif", "serif", "monospace"):
            self.assertEqual(self.outlines(item(fontFamily=family))["substitutions"], [])

    def test_color_emoji_is_explicitly_rejected(self):
        with self.assertRaisesRegex(PdfTextError, "without a vector outline") as error:
            self.outlines(item("Hello 😀"))
        self.assertEqual(error.exception.status, 422)

    def test_private_executable_is_reused(self):
        first = self.outliner._executable()
        self.assertEqual(first, PdfTextOutliner(ROOT)._executable())
        self.assertNotIn(str(ROOT), str(first))
        self.assertEqual(first.parent.stat().st_mode & 0o777, 0o700)

    def test_tiny_pdf_numbers_are_decimal_and_locale_independent(self):
        # Exercise the actual helper's formatter, including values glyph outlines
        # do not reliably produce on every installed font version.
        source = (ROOT / "scripts" / "pdf_text.swift").read_text()
        formatter = re.search(r"func number\(_ value: CGFloat\) -> String \{.*?\n\}", source, re.S).group(0)
        with tempfile.TemporaryDirectory(prefix="figure-pdf-number-test-") as directory:
            path = Path(directory) / "numbers.swift"
            path.write_text("import Foundation\nimport CoreGraphics\n" + formatter +
                            '\nfor value in [0.000001, -0.000001, 0.0000001, -0.0000001, 12.3456789, 12000000.0] { print(number(CGFloat(value))) }\n')
            executable = Path(directory) / "numbers"
            status, _, _ = _run(["/usr/bin/xcrun", "swiftc", "-module-cache-path", str(self.outliner._executable().parent / "modules"),
                                 str(path), "-o", str(executable)], b"", 120, 16384)
            self.assertEqual(status, 0)
            status, output, _ = _run([str(executable)], b"", 10, 16384)
            self.assertEqual(status, 0)
            self.assertEqual(output.decode().splitlines(), ["0.000001", "-0.000001", "0", "0", "12.345679", "12000000"])


if __name__ == "__main__":
    unittest.main()
