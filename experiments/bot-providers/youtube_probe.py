#!/usr/bin/env python3
"""Development-only, isolated YouTube metadata and short audio probe."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import provider_harness
from provider_harness import HarnessError, ProcessResult


SCRIPT_DIR = Path(__file__).resolve().parent
TOOLS_DIR = SCRIPT_DIR / ".youtube-venv"
PYTHON = "/opt/dilla-tools/bin/python"
NODE = "/usr/bin/node"
FFMPEG = "/usr/bin/ffmpeg"
PROBE_DIR = "/opt/dilla-probe"
MAX_SEARCH_TEXT = 200
MAX_SEARCH_RESULTS = 5
MAX_TRACKS = 500
MAX_TITLE = 500
MAX_DURATION = 24 * 60 * 60
MAX_METADATA_OUTPUT = 2 * 1024 * 1024
MAX_SAMPLE_OUTPUT = 512 * 1024
YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
PLAYLIST_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class ProbeError(Exception):
    """An intentionally sanitized probe failure."""


def _has_control(text: str) -> bool:
    return any(ord(char) < 0x20 or ord(char) == 0x7F for char in text)


def normalize_input(value: str) -> tuple[str, str]:
    """Return (kind, canonical yt-dlp input) for the deliberately small input grammar."""
    if not isinstance(value, str):
        raise ProbeError("invalid input")
    value = value.strip()
    if not value or len(value) > MAX_SEARCH_TEXT or _has_control(value):
        raise ProbeError("invalid input")

    if value.startswith(("https://", "http://", "//")):
        if "#" in value:
            raise ProbeError("unsupported URL")
        try:
            parsed = urlsplit(value)
            host = parsed.hostname
            if parsed.scheme != "https" or host not in {
                "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"
            }:
                raise ProbeError("unsupported URL")
            if parsed.port is not None or parsed.netloc.lower() != host:
                raise ProbeError("unsupported URL")
            if parsed.username is not None or parsed.password is not None or parsed.fragment:
                raise ProbeError("unsupported URL")
            pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
            keys = [key for key, _ in pairs]
            if len(keys) != len(set(keys)):
                raise ProbeError("ambiguous URL parameters")

            if host == "youtu.be" and parsed.path.count("/") == 1:
                video_id = parsed.path[1:]
                if YOUTUBE_ID.fullmatch(video_id) and not pairs:
                    return "video", f"https://www.youtube.com/watch?v={video_id}"
            if parsed.path == "/watch" and host != "youtu.be":
                params = dict(pairs)
                video_id = params.get("v", "")
                if set(params) == {"v"} and YOUTUBE_ID.fullmatch(video_id):
                    return "video", f"https://www.youtube.com/watch?v={video_id}"
            if parsed.path == "/playlist" and host != "youtu.be":
                params = dict(pairs)
                playlist_id = params.get("list", "")
                if set(params) == {"list"} and PLAYLIST_ID.fullmatch(playlist_id):
                    return "playlist", f"https://www.youtube.com/playlist?list={playlist_id}"
            if host != "youtu.be" and re.fullmatch(r"/shorts/[A-Za-z0-9_-]{11}", parsed.path):
                video_id = parsed.path.rsplit("/", 1)[1]
                if not pairs:
                    return "video", f"https://www.youtube.com/watch?v={video_id}"
        except (ValueError, UnicodeError):
            raise ProbeError("invalid URL") from None
        raise ProbeError("unsupported URL")

    # Any URL-like or yt-dlp-specific syntax must be rejected rather than
    # passed through as a search query.
    lowered = value.lower()
    if (
        "://" in value
        or lowered.startswith(("ytsearch", "youtube:", "file:", "ftp:"))
        or re.match(r"^(?:www\.)?(?:youtube\.com|youtu\.be)(?:/|$)", lowered)
        or re.match(r"^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:/|\?|$)", lowered)
    ):
        raise ProbeError("search text is not supported")
    if len(value) > MAX_SEARCH_TEXT:
        raise ProbeError("search text is too long")
    return "search", f"ytsearch{MAX_SEARCH_RESULTS}:{value}"


def _base_yt_dlp_args(*, audio: bool = False) -> list[str]:
    argv = [
        PYTHON,
        "-m",
        "yt_dlp",
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-remote-components",
        "--no-flat-playlist",
        "--js-runtimes",
        f"node:{NODE}",
        "--no-warnings",
        "--no-progress",
        "--color",
        "never",
        "--socket-timeout",
        "10",
        "--extractor-retries",
        "1",
        "--playlist-end",
        str(MAX_TRACKS + 1),
        "--simulate",
        "--dump-single-json",
    ]
    if audio:
        argv.extend(["--format", "bestaudio"])
    return argv


def run_isolated(
    argv: list[str],
    *,
    timeout: float,
    output_limit: int,
    tools_dir: Path | None = None,
    input_data: bytes | None = None,
) -> ProcessResult:
    """Lazy adapter keeps unit tests independent of the isolation worker."""
    from youtube_sandbox import run_isolated as isolated_run

    return isolated_run(
        argv,
        timeout=timeout,
        output_limit=output_limit,
        tools_dir=tools_dir,
        input_data=input_data,
    )


def _metadata(canonical: str, *, audio: bool = False) -> dict:
    argv = [*_base_yt_dlp_args(audio=audio), canonical]
    try:
        result = run_isolated(
            argv,
            timeout=120,
            output_limit=MAX_METADATA_OUTPUT,
            tools_dir=TOOLS_DIR,
        )
    except HarnessError as error:
        raise ProbeError(f"isolated extraction failed: {error.kind}") from None
    except Exception as error:
        # Do not surface exception text: providers and runners can include URLs.
        raise ProbeError("isolated extraction unavailable") from None
    if result.returncode != 0:
        raise ProbeError("metadata extraction failed")
    try:
        data = json.loads(result.output)
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
        raise ProbeError("invalid metadata response") from None
    if not isinstance(data, dict):
        raise ProbeError("invalid metadata response")
    return data


def _descriptor(entry: object) -> dict[str, object]:
    if not isinstance(entry, dict):
        raise ProbeError("playlist contains an unavailable or incomplete video")
    extractor = entry.get("extractor_key") or entry.get("ie_key")
    video_id = entry.get("id")
    title = entry.get("title")
    duration = entry.get("duration")
    availability = entry.get("availability")
    if (
        extractor != "Youtube"
        or not isinstance(video_id, str)
        or not YOUTUBE_ID.fullmatch(video_id)
        or not isinstance(title, str)
        or not title.strip()
        or len(title) > MAX_TITLE
        or _has_control(title)
        or isinstance(duration, bool)
        or not isinstance(duration, (int, float))
        or (isinstance(duration, float) and not math.isfinite(duration))
        or duration <= 0
        or duration > MAX_DURATION
        or (
            availability is not None
            and (not isinstance(availability, str) or availability not in {"public", "unlisted"})
        )
    ):
        raise ProbeError("video metadata is unavailable or incomplete")
    return {"id": video_id, "title": title, "duration": duration}


def _tracks(data: dict, kind: str) -> list[dict[str, object]]:
    if kind == "video":
        entry_type = data.get("_type")
        if (entry_type is not None and not isinstance(entry_type, str)) or entry_type in {
            "playlist", "multi_video"
        } or "entries" in data:
            raise ProbeError("expected one video")
        return [_descriptor(data)]

    if data.get("_type") != "playlist" or not isinstance(data.get("entries"), list):
        raise ProbeError("expected a complete result list")
    entries = data["entries"]
    count = data.get("playlist_count")
    if isinstance(count, bool) or not isinstance(count, int):
        raise ProbeError("result count is unavailable")
    if count > MAX_TRACKS or len(entries) > MAX_TRACKS:
        raise ProbeError("result list exceeds 500 videos")
    if count != len(entries) or not entries:
        raise ProbeError("result list is incomplete")
    if kind == "search" and count > MAX_SEARCH_RESULTS:
        raise ProbeError("search result limit exceeded")
    return [_descriptor(entry) for entry in entries]


def resolve(value: str) -> dict[str, object]:
    kind, canonical = normalize_input(value)
    data = _metadata(canonical)
    tracks = _tracks(data, kind)
    return {"count": len(tracks), "tracks": tracks}


_FFMPEG_SCRIPT = r"""
import os, selectors, subprocess, sys, time
url = sys.stdin.buffer.read(65537)
if len(url) > 65536 or not url:
    raise SystemExit(2)
url = url.decode('ascii', 'strict')
argv = ['/usr/bin/ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-i', url, '-map', '0:a:0', '-vn', '-t', '10', '-ac', '2', '-ar', '48000',
        '-map_metadata', '-1',
        '-c:a', 'libopus', '-application', 'audio', '-frame_duration', '20',
        '-b:a', '96k', '-vbr', 'off', '-dtx', '0', '-f', 'ogg', 'pipe:1']
try:
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, close_fds=True)
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + 50
    output = bytearray()
    while selector.get_map():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError
        for key, _ in selector.select(min(remaining, 0.1)):
            chunk = os.read(key.fd, min(16384, 512 * 1024 + 1 - len(output)))
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            output.extend(chunk)
            if len(output) > 512 * 1024:
                raise OverflowError
    rc = proc.wait(timeout=max(0, deadline - time.monotonic()))
except Exception:
    try:
        proc.kill()
        proc.communicate(timeout=1)
    except Exception:
        pass
    raise SystemExit(3)
if rc != 0 or not output:
    raise SystemExit(4)
sys.stdout.buffer.write(output)
"""


def _media_url(data: dict) -> str:
    try:
        url = data["url"]
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        if (
            not isinstance(url, str)
            or len(url) > 16_384
            or not url.isascii()
            or _has_control(url)
            or parsed.scheme != "https"
            or parsed.username is not None
            or parsed.password is not None
            or not (host == "googlevideo.com" or host.endswith(".googlevideo.com"))
            or data.get("extractor_key") != "Youtube"
        ):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise ProbeError("selected audio format is unavailable") from None
    return url


def sample(value: str) -> bytes:
    kind, canonical = normalize_input(value)
    if kind != "video":
        raise ProbeError("sample requires one video URL or ID")
    data = _metadata(canonical, audio=True)
    _descriptor(data)
    url = _media_url(data)
    try:
        result = run_isolated(
            [PYTHON, "-c", _FFMPEG_SCRIPT],
            timeout=60,
            output_limit=MAX_SAMPLE_OUTPUT,
            input_data=url.encode("ascii"),
        )
    except HarnessError as error:
        raise ProbeError(f"isolated sample failed: {error.kind}") from None
    except Exception:
        raise ProbeError("isolated sample unavailable") from None
    if result.returncode != 0 or not result.output.startswith(b"OggS"):
        raise ProbeError("audio sample extraction failed")
    return result.output


def write_sample(data: bytes) -> None:
    if sys.stdout.isatty():
        raise ProbeError("refusing to write binary audio to a terminal")
    if not data or len(data) > MAX_SAMPLE_OUTPUT:
        raise ProbeError("invalid audio sample")
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    metadata = commands.add_parser("metadata", help="resolve YouTube titles and durations")
    metadata.add_argument("input")
    sample_parser = commands.add_parser("sample", help="write one bounded Opus audio sample")
    sample_parser.add_argument("input")
    args = parser.parse_args(argv)
    try:
        if args.command == "metadata":
            print(json.dumps(resolve(args.input), ensure_ascii=False, separators=(",", ":")))
        else:
            write_sample(sample(args.input))
        return 0
    except ProbeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
