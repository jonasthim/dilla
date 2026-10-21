import json
import unittest
from unittest.mock import patch

import youtube_probe
from provider_harness import HarnessError, ProcessResult


def video(video_id="abcdefghijk", title="A title", duration=12.5):
    return {
        "extractor_key": "Youtube",
        "id": video_id,
        "title": title,
        "duration": duration,
        "availability": "public",
    }


def flat_video(video_id="abcdefghijk", title="A title", duration=None):
    return {
        "_type": "url",
        "ie_key": "Youtube",
        "id": video_id,
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "title": title,
        "duration": duration,
        "description": "thumbnail and snippet fields are intentionally discarded" * 20,
        "thumbnails": [{"url": "https://i.ytimg.com/vi/example/hqdefault.jpg"}] * 10,
    }


class YouTubeInputTests(unittest.TestCase):
    def test_canonicalizes_supported_inputs(self):
        cases = {
            "abcdefghijk": ("search", "ytsearch5:abcdefghijk"),
            "https://youtu.be/abcdefghijk": ("video", "https://www.youtube.com/watch?v=abcdefghijk"),
            "https://m.youtube.com/shorts/abcdefghijk": ("video", "https://www.youtube.com/watch?v=abcdefghijk"),
            "https://youtube.com/playlist?list=PL_123": ("playlist", "https://www.youtube.com/playlist?list=PL_123"),
            "lofi study music": ("search", "ytsearch5:lofi study music"),
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(youtube_probe.normalize_input(source), expected)

    def test_rejects_url_confusion_and_unsafe_search_text(self):
        bad = [
            "http://youtube.com/watch?v=abcdefghijk",
            "https://youtube.com.evil.test/watch?v=abcdefghijk",
            "https://user@youtube.com/watch?v=abcdefghijk",
            "https://youtube.com/watch?v=abcdefghijk&v=zzzzzzzzzzz",
            "https://youtube.com/watch?v=abcdefghijk#fragment",
            "https://youtube.com/watch?v=abcdefghijk#",
            "https://youtube.com/embed/abcdefghijk",
            "https://youtu.be/short",
            "ytsearch1:lofi",
            "youtube.com/watch?v=abcdefghijk",
            "www.youtube.com/playlist?list=PL_123",
            "https://youtube.com:8443/watch?v=abcdefghijk",
            "https://example.com/video",
            "example.com/video",
            "hello\n--exec",
            "\nlofi",
            "lofi\n",
            "\tlofi",
            "lofi\x85",
        ]
        for source in bad:
            with self.subTest(source=source), self.assertRaises(youtube_probe.ProbeError):
                youtube_probe.normalize_input(source)

    def test_trims_ordinary_outer_spaces_and_keeps_internal_search_spaces(self):
        self.assertEqual(youtube_probe.normalize_input("  lofi study music  "), ("search", "ytsearch5:lofi study music"))


class YouTubeMetadataTests(unittest.TestCase):
    def setUp(self):
        self.call = patch.object(youtube_probe, "run_isolated").start()
        self.addCleanup(patch.stopall)

    def metadata_result(self, data, returncode=0):
        self.call.return_value = ProcessResult(returncode, json.dumps(data).encode())

    def test_video_resolve_uses_isolation_and_returns_descriptors_only(self):
        self.metadata_result(video())
        result = youtube_probe.resolve("https://youtu.be/abcdefghijk")
        self.assertEqual(result, {"count": 1, "tracks": [{"id": "abcdefghijk", "title": "A title", "duration": 12.5}]})
        argv = self.call.call_args.args[0]
        self.assertIn("--ignore-config", argv)
        self.assertIn("--no-plugin-dirs", argv)
        self.assertIn("--no-remote-components", argv)
        self.assertIn("--flat-playlist", argv)
        self.assertNotIn("--no-flat-playlist", argv)
        self.assertIn("--js-runtimes", argv)
        self.assertEqual(argv[-1], "https://www.youtube.com/watch?v=abcdefghijk")
        self.assertLessEqual(self.call.call_args.kwargs["timeout"], 120)
        self.assertLessEqual(self.call.call_args.kwargs["output_limit"], 2 * 1024 * 1024)
        self.assertEqual(self.call.call_args.kwargs["tools_dir"], youtube_probe.SCRIPT_DIR / ".youtube-venv")

    def test_search_and_complete_playlist_are_expanded(self):
        search = {
            "_type": "playlist",
            "playlist_count": 2,
            "entries": [flat_video(), flat_video("lmnopqrstuv", "B", 4)],
        }
        self.metadata_result(search)
        resolved = youtube_probe.resolve("lofi")
        self.assertEqual(resolved["count"], 2)
        self.assertEqual(resolved["tracks"][0], {"id": "abcdefghijk", "title": "A title"})
        self.assertEqual(resolved["tracks"][1]["duration"], 4)
        self.assertTrue(self.call.call_args.args[0][-1].startswith("ytsearch5:"))
        self.assertEqual(self.call.call_args.kwargs["output_limit"], 2 * 1024 * 1024)

        playlist = {
            "_type": "playlist",
            "playlist_count": 2,
            "entries": [flat_video(), flat_video("lmnopqrstuv", "B", 4)],
        }
        self.metadata_result(playlist)
        self.assertEqual(youtube_probe.resolve("https://youtube.com/playlist?list=PL_123")["count"], 2)

    def test_playlist_overflow_or_incomplete_expansion_fails_atomically(self):
        for data in (
            {"_type": "playlist", "playlist_count": 501, "entries": [video()] * 501},
            {"_type": "playlist", "playlist_count": 3, "entries": [video()]},
            {"_type": "playlist", "playlist_count": 2, "entries": [video(), None]},
        ):
            with self.subTest(count=data.get("playlist_count")):
                self.metadata_result(data)
                with self.assertRaises(youtube_probe.ProbeError):
                    youtube_probe.resolve("https://youtube.com/playlist?list=PL_123")

    def test_hostile_descriptor_and_raw_runner_error_are_sanitized(self):
        hostile = video()
        hostile["extractor_key"] = "Generic"
        self.metadata_result(hostile)
        with self.assertRaises(youtube_probe.ProbeError) as caught:
            youtube_probe.resolve("https://youtube.com/watch?v=abcdefghijk")
        self.assertNotIn("https://", str(caught.exception))

        self.call.side_effect = HarnessError("timeout", b"https://signed.invalid/token?secret=x")
        with self.assertRaises(youtube_probe.ProbeError) as caught:
            youtube_probe.resolve("https://youtube.com/watch?v=abcdefghijk")
        self.assertNotIn("signed.invalid", str(caught.exception))

        malformed_availability = video()
        malformed_availability["availability"] = []
        self.metadata_result(malformed_availability)
        with self.assertRaises(youtube_probe.ProbeError):
            youtube_probe.resolve("https://youtube.com/watch?v=abcdefghijk")

        for field, value in (("_type", []), ("duration", 10**500)):
            malformed = video()
            malformed[field] = value
            self.metadata_result(malformed)
            with self.assertRaises(youtube_probe.ProbeError):
                youtube_probe.resolve("https://youtube.com/watch?v=abcdefghijk")

    def test_bad_exit_and_invalid_json_are_sanitized(self):
        self.call.return_value = ProcessResult(1, b"secret response https://private.invalid")
        with self.assertRaises(youtube_probe.ProbeError) as caught:
            youtube_probe.resolve("https://youtube.com/watch?v=abcdefghijk")
        self.assertNotIn("private.invalid", str(caught.exception))

        self.call.return_value = ProcessResult(0, b"not json")
        with self.assertRaises(youtube_probe.ProbeError):
            youtube_probe.resolve("abcdefghijk")

    def test_sample_keeps_url_in_memory_and_returns_bounded_binary(self):
        data = video()
        data["url"] = "https://rr1---sn.googlevideo.com/signed?secret=hidden"
        data["acodec"] = "opus"
        self.metadata_result(data)
        sample_bytes = b"OggS" + b"\x00" * 300
        self.call.side_effect = [ProcessResult(0, json.dumps(data).encode()), ProcessResult(0, sample_bytes)]
        self.assertEqual(youtube_probe.sample("https://youtube.com/watch?v=abcdefghijk"), sample_bytes)
        ffmpeg_call = self.call.call_args_list[-1]
        argv = ffmpeg_call.args[0]
        self.assertEqual(argv[0], "/usr/bin/python3")
        self.assertNotIn(data["url"], argv)
        self.assertEqual(ffmpeg_call.kwargs["input_data"], data["url"].encode())
        self.assertLessEqual(ffmpeg_call.kwargs["timeout"], 60)
        self.assertLessEqual(ffmpeg_call.kwargs["output_limit"], 512 * 1024)
        script = argv[2]
        for flag in ("/usr/bin/ffmpeg", "'-t', '10'", "'-ac', '2'", "'-ar', '48000'", "'-frame_duration', '20'", "'-b:a', '96k'", "'-vbr', 'off'", "'-dtx', '0'", "'-map_metadata', '-1'", "512 * 1024", "'pipe:1'"):
            self.assertIn(flag, script)

        non_ascii = dict(data, url="https://rr1---sn.googlevideo.com/é")
        with self.assertRaises(youtube_probe.ProbeError):
            youtube_probe._media_url(non_ascii)

    def test_sample_refuses_tty_and_never_falls_back_after_runner_error(self):
        with patch.object(youtube_probe.sys, "stdout") as stdout:
            stdout.isatty.return_value = True
            with self.assertRaises(youtube_probe.ProbeError):
                youtube_probe.write_sample(b"OggS")

        self.call.side_effect = HarnessError("unavailable", b"details")
        with patch.object(youtube_probe.provider_harness, "run_bounded") as local_runner:
            with self.assertRaises(youtube_probe.ProbeError):
                youtube_probe.resolve("https://youtube.com/watch?v=abcdefghijk")
            local_runner.assert_not_called()


if __name__ == "__main__":
    unittest.main()
