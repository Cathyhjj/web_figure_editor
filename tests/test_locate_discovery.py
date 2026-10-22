"""Source discovery checks; all Spotlight and Finder calls are mocked."""

import hashlib
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class LocateDiscoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.root = self.base / "editor"
        self.root.mkdir()
        self.home = self.base / "home"
        self.home.mkdir()
        self.locator = server.Locator(self.root)
        self.data = b"original image bytes"
        self.asset = {"id": "asset-1", "name": "panel.png", "relativePath": "Study/panel.png",
                      "fingerprint": hashlib.sha256(self.data).hexdigest()}
        self.run = self.enterContext(mock.patch.object(server.subprocess, "run"))
        self.run.return_value = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        self.enterContext(mock.patch.object(server.Path, "home", return_value=self.home))
        self.enterContext(mock.patch.object(server.sys, "platform", "darwin"))

    def make_image(self, relative, contents=None):
        image = self.home / relative
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(self.data if contents is None else contents)
        return image

    def indexed(self, *paths):
        self.run.return_value = subprocess.CompletedProcess([], 0,
            stdout="".join(str(path) + "\0" for path in paths), stderr="")

    def file_flags(self, flags=0):
        """Model macOS flags even when these tests run on another platform."""
        original_stat = Path.stat

        def metadata(path, *args, **kwargs):
            result = original_stat(path, *args, **kwargs)
            values = {key: getattr(result, key) for key in dir(result) if key.startswith("st_")}
            values["st_flags"] = flags
            return SimpleNamespace(**values)

        return mock.patch.object(Path, "stat", metadata)

    def test_exact_component_filter_excludes_similar_names_and_wrong_folders(self):
        image = self.make_image("project/Study/panel.png")
        similar = self.make_image("project/Study/panel.png.backup.png")
        wrong_folder = self.make_image("project/OtherStudy/panel.png")
        missing = self.home / "missing/Study/panel.png"
        self.indexed(similar, wrong_folder, missing, image, image)
        self.assertEqual(self.locator.indexed_sources(self.asset), [image])
        self.run.assert_called_once_with(
            ["/usr/bin/mdfind", "-0", "-onlyin", str(self.home), "-name", "panel.png"],
            capture_output=True, text=True, check=True, timeout=3)

    def test_quoted_unicode_names_are_passed_as_one_argument(self):
        name = 'panel "café".png'
        image = self.make_image("project/Study/" + name)
        self.indexed(image)
        asset = {**self.asset, "name": name, "relativePath": "Study/" + name}
        self.assertEqual(self.locator.indexed_sources(asset), [image])
        self.assertEqual(self.run.call_args.args[0][-2:], ["-name", name])

    def test_unique_matching_file_reveals_and_is_remembered_without_picker(self):
        image = self.make_image("project/Study/panel.png")

        def native(argv, **kwargs):
            if argv[0] == "/usr/bin/mdfind":
                return subprocess.CompletedProcess(argv, 0, stdout=str(image) + "\0")
            self.assertEqual(argv, ["/usr/bin/open", "-R", str(image)])
            return subprocess.CompletedProcess(argv, 0)

        self.run.side_effect = native
        with self.file_flags():
            self.assertEqual(self.locator.locate(self.asset), {"status": "revealed"})
        self.assertEqual([call.args[0][0] for call in self.run.call_args_list],
                         ["/usr/bin/mdfind", "/usr/bin/open"])
        self.assertTrue(self.locator.cache_path.is_file())
        reloaded = server.Locator(self.root)
        self.run.reset_mock()
        self.assertEqual(reloaded.locate(self.asset), {"status": "revealed"})
        self.run.assert_called_once_with(["/usr/bin/open", "-R", str(image)],
                                         capture_output=True, check=True, timeout=10)

    def test_unique_changed_source_is_revealed_without_content_read_or_picker(self):
        image = self.make_image("project/Study/panel.png", b"changed image bytes")
        self.indexed(image)
        with mock.patch.object(self.locator, "matches_fingerprint") as fingerprint:
            self.assertEqual(self.locator.locate(self.asset), {"status": "revealed"})
        fingerprint.assert_not_called()
        self.assertEqual([call.args[0][0] for call in self.run.call_args_list],
                         ["/usr/bin/mdfind", "/usr/bin/open"])
        self.assertEqual(self.run.call_args.args[0], ["/usr/bin/open", "-R", str(image)])

    def test_identical_copies_in_different_folders_are_not_guessed(self):
        first = self.make_image("first/Study/panel.png")
        second = self.make_image("second/Study/panel.png")
        self.indexed(first, second)
        with self.file_flags(), self.assertRaises(server.LocateError) as raised:
            self.locator.locate(self.asset)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual([call.args[0][0] for call in self.run.call_args_list], ["/usr/bin/mdfind"])

    def test_unique_cloud_only_candidate_is_revealed_without_reading_contents(self):
        image = self.make_image("cloud/Study/panel.png")
        self.indexed(image)
        flag = getattr(stat, "SF_DATALESS", 0x40000000)
        with self.file_flags(flag), mock.patch.object(server.stat, "SF_DATALESS", flag, create=True), \
                mock.patch.object(Path, "open", side_effect=AssertionError("Cloud content must not be read")):
            self.assertEqual(self.locator.locate(self.asset), {"status": "revealed"})
        self.assertEqual([call.args[0][0] for call in self.run.call_args_list],
                         ["/usr/bin/mdfind", "/usr/bin/open"])
        self.assertEqual(self.run.call_args.args[0], ["/usr/bin/open", "-R", str(image)])

    def test_unique_candidate_without_fingerprint_is_discovered_directly(self):
        image = self.make_image("project/Study/panel.png")
        self.indexed(image)
        asset = {key: value for key, value in self.asset.items() if key != "fingerprint"}
        with mock.patch.object(self.locator, "matches_fingerprint") as fingerprint:
            self.assertEqual(self.locator.discover_source(asset), image)
        fingerprint.assert_not_called()

    def test_unindexed_downloaded_html_is_revealed_and_remembered(self):
        name = "Rhenium-methyl-dimer-IBO-50-interactive (2).html"
        image = self.make_image("Downloads/" + name, b"<!doctype html><canvas></canvas>")
        asset = {"id": "downloaded-html", "name": name,
                 "fingerprint": hashlib.sha256(image.read_bytes()).hexdigest()}
        with mock.patch.object(self.locator, "matches_fingerprint") as fingerprint:
            self.assertEqual(self.locator.locate(asset), {"status": "revealed"})
        fingerprint.assert_not_called()
        self.assertEqual(self.run.call_args.args[0], ["/usr/bin/open", "-R", str(image)])
        self.assertIn(str(image), self.locator.locations.values())

    def test_unindexed_folder_import_keeps_its_relative_path(self):
        image = self.make_image("Desktop/Study/panel.png")
        self.make_image("Downloads/OtherStudy/panel.png")
        self.assertEqual(self.locator.discover_source(self.asset), image)

    def test_direct_lookup_does_not_walk_unrelated_subfolders(self):
        self.make_image("Downloads/Unrelated/Study/panel.png")
        self.assertIsNone(self.locator.discover_source(self.asset))

    def test_direct_lookup_still_works_when_spotlight_is_unavailable(self):
        image = self.make_image("Downloads/Study/panel.png")
        self.run.side_effect = subprocess.TimeoutExpired("mdfind", 3)
        self.assertEqual(self.locator.discover_source(self.asset), image)

    def test_indexed_and_unindexed_identical_copies_remain_ambiguous(self):
        indexed = self.make_image("project/Study/panel.png")
        self.make_image("Downloads/Study/panel.png")
        self.indexed(indexed)
        with self.file_flags(), self.assertRaises(server.LocateError) as raised:
            self.locator.discover_source(self.asset)
        self.assertEqual(raised.exception.status, 409)

    def test_indexed_and_direct_result_for_same_file_is_deduplicated(self):
        image = self.make_image("Downloads/Study/panel.png")
        self.indexed(image)
        with mock.patch.object(self.locator, "matches_fingerprint") as fingerprint:
            self.assertEqual(self.locator.discover_source(self.asset), image)
        fingerprint.assert_not_called()

    def test_direct_copies_use_fingerprint_disambiguation(self):
        self.make_image("Downloads/Study/panel.png", b"unrelated image")
        image = self.make_image("Desktop/Study/panel.png")
        with self.file_flags():
            self.assertEqual(self.locator.discover_source(self.asset), image)

    def test_direct_cloud_candidates_are_not_read_or_guessed(self):
        self.make_image("Downloads/Study/panel.png")
        self.make_image("Desktop/Study/panel.png")
        flag = getattr(stat, "SF_DATALESS", 0x40000000)
        with self.file_flags(flag), mock.patch.object(server.stat, "SF_DATALESS", flag, create=True), \
                mock.patch.object(Path, "open", side_effect=AssertionError("Cloud content must not be read")), \
                self.assertRaises(server.LocateError) as raised:
            self.locator.discover_source(self.asset)
        self.assertEqual(raised.exception.status, 409)

    def test_excess_index_results_do_not_allow_direct_subset_to_appear_unique(self):
        self.make_image("Downloads/Study/panel.png")
        self.run.return_value = subprocess.CompletedProcess([], 0, stdout="x" * (128 * 1024 + 1))
        with mock.patch.object(self.locator, "matches_fingerprint") as fingerprint:
            self.assertIsNone(self.locator.discover_source(self.asset))
        fingerprint.assert_not_called()

    def test_unique_fingerprint_disambiguates_different_local_copies(self):
        first = self.make_image("first/Study/panel.png", b"unrelated same-name image")
        second = self.make_image("second/Study/panel.png")
        self.indexed(first, second)
        with self.file_flags():
            self.assertEqual(self.locator.discover_source(self.asset), second)

    def test_multiple_cloud_candidates_are_not_read_or_guessed(self):
        first = self.make_image("first/Study/panel.png")
        second = self.make_image("second/Study/panel.png")
        self.indexed(first, second)
        flag = getattr(stat, "SF_DATALESS", 0x40000000)
        with self.file_flags(flag), mock.patch.object(server.stat, "SF_DATALESS", flag, create=True), \
                mock.patch.object(Path, "open", side_effect=AssertionError("Cloud content must not be read")), \
                self.assertRaises(server.LocateError) as raised:
            self.locator.discover_source(self.asset)
        self.assertEqual(raised.exception.status, 409)

    def test_partial_fingerprint_check_never_establishes_unique_source(self):
        first = self.make_image("first/Study/panel.png")
        second = self.make_image("second/Study/panel.png")
        self.indexed(first, second)
        with self.file_flags(), mock.patch.object(self.locator, "matches_fingerprint", side_effect=[True, None]), \
                self.assertRaises(server.LocateError) as raised:
            self.locator.discover_source(self.asset)
        self.assertEqual(raised.exception.status, 409)

    def test_unreadable_candidate_does_not_make_another_match_unambiguous(self):
        first = self.make_image("first/Study/panel.png")
        second = self.make_image("second/Study/panel.png")
        self.indexed(first, second)
        original_open = Path.open

        def read_local(path, *args, **kwargs):
            if path == second:
                raise PermissionError("Candidate is not readable")
            return original_open(path, *args, **kwargs)

        with self.file_flags(), mock.patch.object(Path, "open", read_local), \
                self.assertRaises(server.LocateError) as raised:
            self.locator.discover_source(self.asset)
        self.assertEqual(raised.exception.status, 409)

    def test_combined_hash_budget_keeps_large_candidate_sets_ambiguous(self):
        first = self.make_image("first/Study/panel.png")
        second = self.make_image("second/Study/panel.png")
        self.indexed(first, second)
        with self.file_flags(), mock.patch.object(server, "MAX_SOURCE_BYTES", len(self.data)), \
                mock.patch.object(self.locator, "matches_fingerprint", return_value=True) as fingerprint, \
                self.assertRaises(server.LocateError) as raised:
            self.locator.discover_source(self.asset)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(fingerprint.call_count, 1)

    def test_unavailable_or_timed_out_index_returns_no_source(self):
        for error in (FileNotFoundError(), subprocess.TimeoutExpired("mdfind", 3),
                      subprocess.CalledProcessError(1, "mdfind")):
            with self.subTest(error=type(error).__name__):
                self.run.side_effect = error
                self.assertIsNone(self.locator.discover_source(self.asset))

    def test_excess_results_never_establish_uniqueness_from_a_subset(self):
        images = [self.make_image(f"project-{number}/Study/panel.png") for number in range(17)]
        self.indexed(*images)
        with mock.patch.object(self.locator, "matches_fingerprint") as fingerprint:
            self.assertIsNone(self.locator.discover_source(self.asset))
        fingerprint.assert_not_called()
        self.run.return_value = subprocess.CompletedProcess([], 0, stdout="x" * (128 * 1024 + 1))
        self.assertIsNone(self.locator.discover_source(self.asset))

    def test_unresolved_source_returns_not_found_without_native_picker(self):
        with self.assertRaises(server.LocateError) as raised:
            self.locator.locate(self.asset)
        self.assertEqual(raised.exception.status, 404)
        self.assertEqual([call.args[0][0] for call in self.run.call_args_list], ["/usr/bin/mdfind"])
        self.assertFalse(self.locator.cache_path.exists())


if __name__ == "__main__":
    unittest.main()
