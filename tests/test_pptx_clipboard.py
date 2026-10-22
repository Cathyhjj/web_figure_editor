"""Native clipboard bridge tests; mocks never modify the system clipboard."""
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pptx_clipboard as bridge


class ClipboardTransportTests(unittest.TestCase):
    def setUp(self):
        self.executable = mock.patch.object(bridge, "_executable", return_value=Path("/private/helper"))
        self.executable.start()
        self.run_patch = mock.patch.object(bridge, "_run", return_value=(0, b"PK\x03\x04package"))
        self.run = self.run_patch.start()

    def tearDown(self):
        self.run_patch.stop()
        self.executable.stop()

    def test_returns_only_captured_bytes_and_passes_no_optional_request(self):
        self.assertEqual(bridge.read_powerpoint_clipboard(), b"PK\x03\x04package")
        self.run.assert_called_once_with(["/private/helper"], b"", 15, bridge.MAX_CLIPBOARD_BYTES)

    def test_preview_hash_is_validated_and_normalized_before_native_read(self):
        digest = hashlib.sha256(b"browser PNG").hexdigest()
        bridge.read_powerpoint_clipboard(digest.upper())
        self.assertEqual(self.run.call_args.args[1], digest.encode("ascii"))
        for value in ("", "a" * 63, "g" * 64, "a" * 64 + "\n", "../file", 12, False):
            with self.subTest(value=value):
                self.run.reset_mock()
                with self.assertRaisesRegex(ValueError, "SHA-256"):
                    bridge.read_powerpoint_clipboard(value)
                self.run.assert_not_called()

    def test_no_office_or_mismatched_preview_returns_none(self):
        self.run.return_value = (10, b"")
        self.assertIsNone(bridge.read_powerpoint_clipboard())
        self.assertIsNone(bridge.read_powerpoint_clipboard("a" * 64))

    def test_stale_read_size_and_ambiguity_have_actionable_errors(self):
        for code, text in ((20, "changed"), (21, "100 MB"), (23, "multiple")):
            with self.subTest(code=code):
                self.run.return_value = (code, b"")
                with self.assertRaisesRegex(ValueError, text):
                    bridge.read_powerpoint_clipboard()

    def test_failure_and_invalid_native_responses_are_rejected(self):
        for result in ((22, b""), (1, b"unexpected"), (0, b""), (10, b"unexpected")):
            with self.subTest(result=result):
                self.run.return_value = result
                with self.assertRaises(ValueError):
                    bridge.read_powerpoint_clipboard()
        with mock.patch.object(bridge, "MAX_CLIPBOARD_BYTES", 3):
            self.run.return_value = (0, b"four")
            with self.assertRaises(ValueError):
                bridge.read_powerpoint_clipboard()


class HelperProcessTests(unittest.TestCase):
    def test_output_bound_is_checked_before_read(self):
        def spawn(command, stdin, stdout, stderr):
            process = mock.Mock(returncode=0)
            process.communicate.side_effect = lambda payload, timeout: stdout.write(b"12345")
            return process
        with mock.patch.object(bridge.subprocess, "Popen", side_effect=spawn):
            with self.assertRaisesRegex(ValueError, "100 MB"):
                bridge._run(["helper"], b"", 1, 4)

    def test_timeout_kills_and_reaps_the_process(self):
        process = mock.Mock()
        process.communicate.side_effect = [subprocess.TimeoutExpired("helper", 1), None]
        with mock.patch.object(bridge.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(ValueError, "timed out"):
                bridge._run(["helper"], b"", 1, 4)
        process.kill.assert_called_once()
        self.assertEqual(process.communicate.call_count, 2)

    def test_missing_executable_has_no_native_error_details(self):
        with mock.patch.object(bridge.subprocess, "Popen", side_effect=OSError("private path")):
            with self.assertRaises(ValueError) as error:
                bridge._run(["helper"], b"", 1, 4)
        self.assertNotIn("private path", str(error.exception))
        self.assertIn("Command Line Tools", str(error.exception))

    def test_native_stderr_is_not_returned(self):
        def spawn(command, stdin, stdout, stderr):
            process = mock.Mock(returncode=22)
            def communicate(payload, timeout):
                stderr.write(b"private clipboard data")
            process.communicate.side_effect = communicate
            return process
        with mock.patch.object(bridge.subprocess, "Popen", side_effect=spawn):
            self.assertEqual(bridge._run(["helper"], b"", 1, 4), (22, b""))


class HelperCompilationTests(unittest.TestCase):
    def test_availability_only_checks_prerequisites_and_never_reads_clipboard(self):
        with mock.patch.object(bridge.sys, "platform", "linux"), mock.patch.object(bridge, "_run") as run:
            self.assertFalse(bridge.clipboard_available())
            with self.assertRaisesRegex(ValueError, "macOS"):
                bridge._executable()
            run.assert_not_called()
        with mock.patch.object(bridge.sys, "platform", "darwin"), mock.patch.object(Path, "is_file", return_value=False):
            self.assertFalse(bridge.clipboard_available())

    def test_cache_is_keyed_by_source_and_retains_private_directory(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source.swift"
            source.write_text("first source")
            cache = {}
            def compile_helper(command, payload, timeout, output_limit):
                Path(command[-1]).write_bytes(b"executable")
                self.assertEqual(timeout, 120)
                self.assertEqual(payload, b"")
                self.assertEqual(Path(command[-1]).parent.stat().st_mode & 0o777, 0o700)
                return 0, b""
            try:
                with mock.patch.object(bridge, "_SOURCE", source), mock.patch.object(bridge, "_compiled", cache), \
                     mock.patch.object(bridge, "clipboard_available", return_value=True), \
                     mock.patch.object(bridge, "_run", side_effect=compile_helper) as run:
                    self.assertFalse(bridge.clipboard_ready())
                    run.assert_not_called()
                    first = bridge._executable()
                    self.assertTrue(bridge.clipboard_ready())
                    self.assertEqual(bridge._executable(), first)
                    self.assertEqual(run.call_count, 1)
                    source.write_text("second source")
                    self.assertFalse(bridge.clipboard_ready())
                    self.assertEqual(run.call_count, 1)
                    self.assertNotEqual(bridge._executable(), first)
                    self.assertTrue(bridge.clipboard_ready())
                    self.assertEqual(run.call_count, 2)
            finally:
                for directory, _ in cache.values():
                    directory.cleanup()

    def test_compile_failure_is_reported_and_not_cached(self):
        cache = {}
        with mock.patch.object(bridge, "_compiled", cache), \
             mock.patch.object(bridge, "clipboard_available", return_value=True), \
             mock.patch.object(bridge, "_run", return_value=(1, b"")):
            with self.assertRaisesRegex(ValueError, "could not compile"):
                bridge._executable()
        self.assertEqual(cache, {})


class HelperWarmupTests(unittest.TestCase):
    def test_start_schedules_one_daemon_compile_without_reading_clipboard(self):
        with mock.patch.object(bridge, "_warmup_started", False), \
             mock.patch.object(bridge, "clipboard_available", return_value=True), \
             mock.patch.object(bridge.threading, "Thread") as thread, \
             mock.patch.object(bridge, "_executable") as compile_helper, \
             mock.patch.object(bridge, "read_powerpoint_clipboard") as read:
            bridge.start_clipboard_helper()
            bridge.start_clipboard_helper()
            thread.assert_called_once()
            self.assertTrue(thread.call_args.kwargs["daemon"])
            thread.return_value.start.assert_called_once()
            compile_helper.assert_not_called()
            thread.call_args.kwargs["target"]()
            compile_helper.assert_called_once()
            read.assert_not_called()

    def test_failed_warmup_stays_unready_and_does_not_retry_automatically(self):
        cache = {}
        with mock.patch.object(bridge, "_warmup_started", False), \
             mock.patch.object(bridge, "_compiled", cache), \
             mock.patch.object(bridge, "clipboard_available", return_value=True), \
             mock.patch.object(bridge.threading, "Thread") as thread, \
             mock.patch.object(bridge, "_run", return_value=(1, b"")) as run:
            bridge.start_clipboard_helper()
            thread.call_args.kwargs["target"]()
            self.assertFalse(bridge.clipboard_ready())
            self.assertEqual(cache, {})
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.args[0][1], "swiftc")
            bridge.start_clipboard_helper()
            thread.assert_called_once()

    def test_readiness_never_waits_for_in_progress_compilation(self):
        lock = mock.Mock()
        lock.acquire.return_value = False
        with mock.patch.object(bridge, "clipboard_available", return_value=True), \
             mock.patch.object(bridge, "_compile_lock", lock), \
             mock.patch.object(bridge, "_executable") as compile_helper:
            self.assertFalse(bridge.clipboard_ready())
        lock.acquire.assert_called_once_with(blocking=False)
        lock.release.assert_not_called()
        compile_helper.assert_not_called()

    def test_unavailable_platform_does_not_start_warmup_or_report_ready(self):
        with mock.patch.object(bridge, "clipboard_available", return_value=False), \
             mock.patch.object(bridge.threading, "Thread") as thread, \
             mock.patch.object(bridge, "_executable") as compile_helper:
            bridge.start_clipboard_helper()
            self.assertFalse(bridge.clipboard_ready())
        thread.assert_not_called()
        compile_helper.assert_not_called()

    def test_missing_cached_executable_or_source_is_not_ready(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source.swift"
            source.write_bytes(b"source")
            cache = {hashlib.sha256(b"source").hexdigest(): (None, Path(root) / "missing")}
            with mock.patch.object(bridge, "clipboard_available", return_value=True), \
                 mock.patch.object(bridge, "_SOURCE", source), \
                 mock.patch.object(bridge, "_compiled", cache):
                self.assertFalse(bridge.clipboard_ready())
                source.unlink()
                self.assertFalse(bridge.clipboard_ready())


if __name__ == "__main__":
    unittest.main()
