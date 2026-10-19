"""Loopback vector-PDF text API tests; never open Finder or native dialogs."""

import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from pdf_text import PdfTextError


def text_item(**changes):
    return {"id": "text-1", "text": "Hello", "fontFamily": "Arial", "fontSize": 24,
            "fontWeight": "normal", "fontStyle": "normal", **changes}


class PdfTextApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.local = server.create_server(self.root, 0)
        self.thread = threading.Thread(target=lambda: self.local.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()
        self.origin = "http://127.0.0.1:" + str(self.local.server_port)
        self.quiet = mock.patch.object(server.Handler, "log_message")
        self.quiet.start()

    def tearDown(self):
        self.local.shutdown()
        self.thread.join()
        self.local.server_close()
        self.quiet.stop()
        self.temporary.cleanup()

    def request(self, data=None, *, method="POST", path="/api/pdf-text", headers=None, raw=None, extra_headers=()):
        body = raw if raw is not None else json.dumps({"items": [text_item()]} if data is None else data).encode()
        fields = {"Host": "127.0.0.1:" + str(self.local.server_port), "Origin": self.origin,
                  "X-Figure-Token": self.local.token, "Content-Type": "application/json", "Content-Length": str(len(body))}
        for name, value in (headers or {}).items():
            if value is None:
                fields.pop(name, None)
            else:
                fields[name] = value
        connection = http.client.HTTPConnection("127.0.0.1", self.local.server_port, timeout=3)
        connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for name, value in [*fields.items(), *extra_headers]:
            connection.putheader(name, value)
        connection.endheaders(body if method == "POST" else None)
        response = connection.getresponse()
        status, raw_response, response_headers = response.status, response.read(), dict(response.getheaders())
        connection.close()
        return status, json.loads(raw_response), response_headers

    def test_capability_reports_native_availability(self):
        for available in (False, True):
            with self.subTest(available=available), mock.patch.object(type(self.local.pdf_text), "available", new_callable=mock.PropertyMock, return_value=available):
                status, data, _ = self.request(method="GET", path="/api/local")
                self.assertEqual(status, 200)
                self.assertIs(data["pdfTextOutlines"], available)
                self.assertEqual(data["token"], self.local.token)

    def test_authorized_request_returns_only_outlines_and_font_information(self):
        result = {"outlines": [{"id": "text-1", "lines": [{"width": 21, "path": "0 0 m\n1 0 l\nh"}]}], "substitutions": []}
        with mock.patch.object(self.local.pdf_text, "outline", return_value=result) as outline:
            status, data, headers = self.request()
            self.assertEqual((status, data), (200, result))
            outline.assert_called_once_with({"items": [text_item()]})
            self.assertEqual(headers["Cache-Control"], "no-store")
            self.assertIn("application/json", headers["Content-Type"])

    def test_origin_host_token_and_fetch_metadata_denials_do_not_invoke_helper(self):
        forbidden = [{"Origin": None}, {"Origin": "null"}, {"Origin": "https://foreign.example"},
                     {"Host": "foreign.example"}, {"Host": None}, {"X-Figure-Token": None},
                     {"X-Figure-Token": "wrong"}, {"X-Figure-Token": "é"}, {"Sec-Fetch-Site": "cross-site"}]
        with mock.patch.object(self.local.pdf_text, "outline") as outline:
            for headers in forbidden:
                with self.subTest(headers=headers):
                    self.assertEqual(self.request(headers=headers)[0], 403)
            for name, value in (("Host", "127.0.0.1:" + str(self.local.server_port)), ("Origin", self.origin), ("X-Figure-Token", self.local.token)):
                with self.subTest(duplicate=name):
                    self.assertEqual(self.request(extra_headers=[(name, value)])[0], 403)
            outline.assert_not_called()

    def test_body_limit_and_invalid_lengths_reject_before_helper(self):
        with mock.patch.object(self.local.pdf_text, "outline") as outline:
            for length in (None, "0", "-1", "invalid", str(server.MAX_PDF_TEXT_BODY + 1), "9" * 30):
                with self.subTest(length=length):
                    self.assertEqual(self.request(headers={"Content-Length": length}, raw=b"{}")[0], 413)
            self.assertEqual(self.request(extra_headers=[("Content-Length", "2")], raw=b"{}")[0], 413)
            outline.assert_not_called()

    def test_pdf_text_body_above_general_api_limit_is_supported(self):
        payload = {"items": [text_item(text="x" * (server.MAX_BODY + 1))]}
        with mock.patch.object(self.local.pdf_text, "outline", return_value={"outlines": [], "substitutions": []}) as outline:
            self.assertEqual(self.request(payload)[0], 200)
            outline.assert_called_once_with(payload)

    def test_wrong_content_type_transfer_encoding_and_invalid_json(self):
        with mock.patch.object(self.local.pdf_text, "outline") as outline:
            for headers in ({"Content-Type": "text/plain"}, {"Transfer-Encoding": "chunked"}):
                self.assertEqual(self.request(headers=headers)[0], 400)
            self.assertEqual(self.request(raw=b"not-json")[0], 400)
            outline.assert_not_called()

    def test_extra_file_and_command_fields_are_rejected_without_native_execution(self):
        payloads = [{"items": [], "path": "/tmp/font.ttf"}, {"items": [text_item(path="/etc/passwd")]},
                    {"items": [text_item(command="touch /tmp/never")]}, {"items": [text_item(fontSize=False)]},
                    {"items": [text_item(text="x" * 100001)]}]
        with mock.patch.object(self.local.pdf_text, "_executable") as executable:
            for payload in payloads:
                with self.subTest(keys=list(payload)):
                    self.assertIn(self.request(payload)[0], (400, 413))
            executable.assert_not_called()

    def test_native_errors_preserve_status_and_message(self):
        for status, message in ((422, "Color emoji has no vector outline."), (503, "Install Command Line Tools."), (413, "Text is too complex.")):
            with self.subTest(status=status), mock.patch.object(self.local.pdf_text, "outline", side_effect=PdfTextError(status, message)):
                actual_status, data, _ = self.request()
                self.assertEqual((actual_status, data), (status, {"error": message}))

    def test_unsupported_native_environment_has_actionable_error(self):
        with mock.patch("pdf_text.sys.platform", "linux"):
            status, data, _ = self.request()
            self.assertEqual(status, 503)
            self.assertIn("local macOS editor", data["error"])
            self.assertNotIn(str(self.root), data["error"])

    def test_pdf_post_route_is_not_a_get_export_or_arbitrary_command(self):
        with mock.patch.object(self.local.pdf_text, "outline") as outline:
            self.assertEqual(self.request(method="GET")[0], 404)
            self.assertEqual(self.request(path="/api/pdf-text/../../run")[0], 404)
            outline.assert_not_called()


if __name__ == "__main__":
    unittest.main()
