"""The native PDF route accepts only passive, fully local OOXML packages."""
import base64
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
from zipfile import ZIP_DEFLATED, ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import powerpoint_pdf as native
from pptx_import import PptxImportError, NS


def fixture(extra=None, external=False, slide_markup="", content_type=None):
    def rel(kind, target, attrs=""):
        return (f'<Relationships xmlns="{native._OPC}relationships"><Relationship Id="r1" '
                f'Type="{native._OFFICE}{kind}" Target="{target}" {attrs}/></Relationships>')
    parts = {
        "[Content_Types].xml": f'<Types xmlns="{native._OPC}content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        f'<Override PartName="/ppt/presentation.xml" ContentType="{content_type or native._PRESENTATION_TYPE + "presentation.main+xml"}"/>'
        f'<Override PartName="/ppt/slides/slide1.xml" ContentType="{native._PRESENTATION_TYPE}slide+xml"/></Types>',
        "_rels/.rels": rel("officeDocument", "ppt/presentation.xml"),
        "ppt/presentation.xml": f'<p:presentation xmlns:p="{NS["p"]}" xmlns:r="{NS["r"]}">'
        '<p:sldIdLst><p:sldId id="256" r:id="r1"/></p:sldIdLst></p:presentation>',
        "ppt/_rels/presentation.xml.rels": rel("slide", "slides/slide1.xml"),
        "ppt/slides/slide1.xml": f'<p:sld xmlns:p="{NS["p"]}">{slide_markup}</p:sld>',
    }
    if external:
        parts["ppt/slides/_rels/slide1.xml.rels"] = rel("image", "https://outside.invalid/example.png", 'TargetMode="External"')
    parts.update(extra or {})
    buf = io.BytesIO()
    with ZipFile(buf, "w", ZIP_DEFLATED) as output:
        for path, value in parts.items():
            output.writestr(path, value)
    return buf.getvalue()


class NativePdfTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        temp_path = mock.patch.object(native, "_POWERPOINT_TEMP", Path(folder.name))
        temp_path.start()
        self.addCleanup(temp_path.stop)

    def test_active_content_is_refused_before_launch_even_if_hidden_in_unused_parts(self):
        with mock.patch.object(native, "power_point_pdf_available", return_value=True), mock.patch.object(native.subprocess, "run") as run:
            for deck in [fixture(external=True), fixture(slide_markup='<p:oleObj/>'),
                         fixture(extra={"ppt/vbaProject.bin": b"macro"}), fixture(slide_markup='<p:item action="ppaction://program"/>'),
                         fixture(content_type="application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"),
                         fixture(extra={"ppt/media/image1.svg": b"<svg/>"})]:
                with self.subTest(size=len(deck)), self.assertRaises(PptxImportError) as failure:
                    native.render_powerpoint_pdf({"name": "poster.pptx", "data": base64.b64encode(deck).decode()})
                self.assertEqual(failure.exception.status, 422)
            run.assert_not_called()

    def test_uses_only_private_generated_paths_and_returns_native_pdf(self):
        pdf = b"%PDF-1.4\nreference\n%%EOF"
        paths = []
        def export(command, **options):
            self.assertTrue(options["check"])
            self.assertGreater(options["timeout"], 0)
            source, target = map(Path, command[-3:-1])
            self.assertTrue(source.is_file())
            self.assertEqual(source.name, command[-1])
            self.assertNotIn("private-poster", str(source))
            with ZipFile(source) as safe, ZipFile(io.BytesIO(deck)) as orig:
                self.assertEqual(set(orig.namelist()), set(safe.namelist()))
                self.assertTrue(all(safe.read(k) == orig.read(k) for k in safe.namelist()))
            paths.extend((source, target))
            target.write_bytes(pdf)
        deck = fixture()
        with mock.patch.object(native, "power_point_pdf_available", return_value=True), mock.patch.object(native.subprocess, "run", side_effect=export):
            result = native.render_powerpoint_pdf({"name": "private-poster.pptx", "data": base64.b64encode(deck).decode()})
        self.assertEqual(base64.b64decode(result["data"]), pdf)
        self.assertTrue(all(not path.exists() for path in paths))

    def test_timeout_cleans_up_private_files_and_releases_the_lock(self):
        paths = []
        def timeout(command, **_):
            paths.append(Path(command[-3]))
            raise native.subprocess.TimeoutExpired(command, 110)
        payload = {"name": "poster.pptx", "data": base64.b64encode(fixture()).decode()}
        with mock.patch.object(native, "power_point_pdf_available", return_value=True), mock.patch.object(native.subprocess, "run", side_effect=timeout):
            for _ in range(2):
                with self.assertRaises(PptxImportError) as failure:
                    native.render_powerpoint_pdf(payload)
                self.assertEqual(failure.exception.status, 504)
        self.assertEqual(len(set(paths)), 2)
        self.assertTrue(all(not path.exists() for path in paths))


if __name__ == "__main__":
    unittest.main()
