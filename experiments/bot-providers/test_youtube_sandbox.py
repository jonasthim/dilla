from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import ipaddress
import threading
from pathlib import Path
from unittest.mock import patch

import provider_harness
import youtube_sandbox as sandbox


class BrokerPolicyTests(unittest.TestCase):
    def test_connect_allows_only_exact_youtube_policy_and_port_443(self):
        for host in (
            "youtube.com",
            "www.youtube.com",
            "youtu.be",
            "r3---sn.googlevideo.com",
            "i.ytimg.com",
        ):
            with self.subTest(host=host):
                self.assertEqual(
                    sandbox._parse_connect(f"CONNECT {host}:443 HTTP/1.1\r\n\r\n".encode()),
                    host,
                )
        for authority in (
            "youtube.com:80",
            "youtube.com.evil.invalid:443",
            "evil.youtube.com.invalid:443",
            "user@youtube.com:443",
            "127.0.0.1:443",
            "[2606:4700:4700::1111]:443",
            "youtube.com.:443",
        ):
            with self.subTest(authority=authority), self.assertRaises(provider_harness.HarnessError):
                sandbox._parse_connect(f"CONNECT {authority} HTTP/1.1\r\n\r\n".encode())

    def test_connect_rejects_non_connect_methods_malformed_headers_and_body(self):
        bad = (
            b"GET https://youtube.com/ HTTP/1.1\r\n\r\n",
            b"CONNECT youtube.com:443 HTTP/1.1\r\nProxy-Authorization: Basic abc\r\n\r\n",
            b"CONNECT youtube.com:443 HTTP/1.1\r\nHost: youtube.com\r\nHost: youtube.com\r\n\r\n",
            b"CONNECT youtube.com:443 HTTP/1.1\r\nHost: evil.invalid\r\n\r\n",
            b"CONNECT youtube.com:443 HTTP/1.1\r\n\r\nbody",
        )
        for request in bad:
            with self.subTest(request=request), self.assertRaises(provider_harness.HarnessError):
                sandbox._parse_connect(request)

    def test_all_dns_answers_must_be_public_and_transition_addresses_are_rejected(self):
        self.assertEqual(str(sandbox._public_address("142.250.72.14")), "142.250.72.14")
        for address in (
            "127.0.0.1",
            "10.0.0.5",
            "169.254.1.1",
            "224.0.0.1",
            "::1",
            "::ffff:8.8.8.8",
            "2002:0808:0808::1",
            "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
        ):
            with self.subTest(address=address), self.assertRaises(provider_harness.HarnessError):
                sandbox._public_address(address)

    def test_resolver_rejects_mixed_public_and_private_answer_set(self):
        class FakeResolver:
            returncode = 0

            def communicate(self, timeout):
                return b"142.250.72.14\n192.168.1.1\n", b""

        with patch.object(sandbox.subprocess, "Popen", return_value=FakeResolver()):
            with self.assertRaises(provider_harness.HarnessError) as caught:
                sandbox._resolve_public_addresses("youtube.com")
        self.assertEqual(caught.exception.kind, "proxy resolution rejected")

    def test_resolver_keeps_validated_public_addresses(self):
        class FakeResolver:
            returncode = 0

            def communicate(self, timeout):
                return b"142.250.72.14\n2606:4700:4700::1111\n", b""

        with patch.object(sandbox.subprocess, "Popen", return_value=FakeResolver()):
            addresses = sandbox._resolve_public_addresses("youtube.com")
        self.assertEqual([str(address) for address in addresses], ["142.250.72.14", "2606:4700:4700::1111"])

    def test_broker_connects_to_the_validated_numeric_address(self):
        class FakeClient:
            def __init__(self):
                self.sent = []

            def settimeout(self, timeout):
                pass

            def sendall(self, payload):
                self.sent.append(payload)

        class FakeUpstream:
            def __init__(self, family, socktype):
                self.target = None

            def settimeout(self, timeout):
                pass

            def connect(self, target):
                self.target = target

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                pass

            def close(self):
                pass

        broker = object.__new__(sandbox._Broker)
        broker.budget = sandbox._ByteBudget()
        broker.deadline = time.monotonic() + 5
        broker.stop_event = threading.Event()
        broker.upstreams = set()
        broker.upstream_lock = threading.Lock()
        client = FakeClient()
        upstreams = []

        def fake_socket(family, socktype):
            upstream = FakeUpstream(family, socktype)
            upstreams.append(upstream)
            return upstream

        with (
            patch.object(sandbox, "_recv_header", return_value=(b"CONNECT youtube.com:443 HTTP/1.1\r\n\r\n", b"")),
            patch.object(sandbox, "_resolve_public_addresses", return_value=[ipaddress.ip_address("142.250.72.14")]),
            patch.object(sandbox.socket, "socket", side_effect=fake_socket),
            patch.object(sandbox, "_bridge"),
        ):
            broker._handle(client)
        self.assertEqual(upstreams[0].target, ("142.250.72.14", 443))
        self.assertEqual(client.sent, [b"HTTP/1.1 200 Connection Established\r\n\r\n"])

    def test_bridge_handles_partial_writes_and_half_close(self):
        client, relay_left = socket.socketpair()
        relay_right, upstream = socket.socketpair()
        bridge = threading.Thread(
            target=sandbox._bridge,
            args=(relay_left, relay_right, sandbox._ByteBudget()),
            daemon=True,
        )
        bridge.start()
        payload = b"x" * (256 * 1024)
        def produce():
            client.sendall(payload)
            client.shutdown(socket.SHUT_WR)

        producer = threading.Thread(target=produce, daemon=True)
        producer.start()
        upstream.settimeout(2)
        received = bytearray()
        while True:
            chunk = upstream.recv(16 * 1024)
            if not chunk:
                break
            received.extend(chunk)
        self.assertEqual(bytes(received), payload)
        producer.join(timeout=1)
        self.assertFalse(producer.is_alive())
        upstream.sendall(b"response")
        upstream.shutdown(socket.SHUT_WR)
        response = bytearray()
        while True:
            chunk = client.recv(1024)
            if not chunk:
                break
            response.extend(chunk)
        self.assertEqual(bytes(response), b"response")
        bridge.join(timeout=1)
        self.assertFalse(bridge.is_alive())
        client.close()
        relay_left.close()
        relay_right.close()
        upstream.close()


class RunnerValidationTests(unittest.TestCase):
    def test_missing_bwrap_fails_closed(self):
        with patch.object(sandbox.shutil, "which", return_value=None):
            with self.assertRaises(provider_harness.HarnessError) as caught:
                sandbox.run_isolated(["/usr/bin/true"], timeout=1, output_limit=16)
        self.assertEqual(caught.exception.kind, "unavailable")

    def test_bwrap_namespace_startup_failure_is_reported_as_unavailable(self):
        with tempfile.TemporaryDirectory(prefix="fake-bwrap-") as directory:
            fake = Path(directory) / "bwrap"
            fake.write_text("#!/bin/sh\nexit 1\n")
            fake.chmod(0o700)
            real_which = shutil.which
            with patch.object(
                sandbox.shutil,
                "which",
                side_effect=lambda name: str(fake) if name == "bwrap" else real_which(name),
            ):
                with self.assertRaises(provider_harness.HarnessError) as caught:
                    sandbox.run_isolated(["/usr/bin/true"], timeout=1, output_limit=16)
        self.assertEqual(caught.exception.kind, "unavailable")

    def test_input_and_resource_bounds_are_validated(self):
        for value in (b"x" * (64 * 1024 + 1), "not bytes"):
            with self.subTest(value_type=type(value).__name__), self.assertRaises(ValueError):
                sandbox.run_isolated(["/usr/bin/true"], timeout=1, output_limit=16, input_data=value)
        for kwargs in (
            {"timeout": 0, "output_limit": 16},
            {"timeout": 121, "output_limit": 16},
            {"timeout": 1, "output_limit": sandbox.MAX_STDOUT + 1},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                sandbox.run_isolated(["/usr/bin/true"], **kwargs)

    def test_invalid_tools_directory_is_rejected(self):
        with self.assertRaises(provider_harness.HarnessError) as caught:
            sandbox.run_isolated(
                ["/usr/bin/true"], timeout=1, output_limit=16, tools_dir=Path("relative-tools")
            )
        self.assertEqual(caught.exception.kind, "invalid tools path")


class NamespaceRunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bwrap = shutil.which("bwrap")
        if not bwrap:
            raise unittest.SkipTest("namespace checks skipped: bwrap is not installed")
        try:
            result = subprocess.run(
                [
                    bwrap,
                    "--unshare-all",
                    "--die-with-parent",
                    "--ro-bind", "/usr", "/usr",
                    "--symlink", "usr/lib", "/lib",
                    "--symlink", "usr/lib64", "/lib64",
                    "--proc", "/proc",
                    "--dev", "/dev",
                    "--tmpfs", "/tmp",
                    "--", "/usr/bin/true",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=3,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            raise unittest.SkipTest("namespace checks skipped: bwrap unshare-all smoke check unavailable") from None
        if result.returncode != 0:
            message = (result.stderr or b"").lower()
            if any(
                reason in message
                for reason in (b"operation not permitted", b"permission denied", b"creating new namespace failed")
            ):
                raise unittest.SkipTest("namespace checks skipped: bwrap namespace creation is denied here")
            raise RuntimeError("bwrap namespace smoke failed for a reason other than namespace permission")

    def test_stdout_is_only_stdout_and_stderr_is_discarded(self):
        result = sandbox.run_isolated(
            ["/usr/bin/python3", "-c", "import sys; sys.stdout.buffer.write(b'OggS'); sys.stderr.write('private error')"],
            timeout=3,
            output_limit=16,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.output, b"OggS")

    def test_host_loopback_and_direct_public_network_are_unreachable(self):
        host_listener = socket.socket()
        host_listener.bind(("127.0.0.1", 0))
        host_listener.listen(1)
        host_port = host_listener.getsockname()[1]
        code = "\n".join(
            (
                "import socket,sys",
                "out=[]",
                "for target in [('127.0.0.1',int(sys.argv[1])),('1.1.1.1',443)]:",
                " try: socket.create_connection(target,timeout=.3); out.append('reachable')",
                " except OSError: out.append('blocked')",
                "print(','.join(out))",
            )
        )
        try:
            result = sandbox.run_isolated(
                ["/usr/bin/python3", "-c", code, str(host_port)], timeout=3, output_limit=64
            )
        finally:
            host_listener.close()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.output, b"blocked,blocked\n")

    def test_proxy_rejects_unapproved_hostnames_and_ip_literals(self):
        code = "\n".join(
            (
                "import socket,sys",
                "out=[]",
                "for authority in sys.argv[1:]:",
                " s=socket.create_connection(('127.0.0.1',3128),timeout=1)",
                " s.sendall(('CONNECT '+authority+' HTTP/1.1\\r\\n\\r\\n').encode())",
                " s.settimeout(1)",
                " out.append('closed' if not s.recv(1) else 'response')",
                " s.close()",
                "print(','.join(out))",
            )
        )
        result = sandbox.run_isolated(
            ["/usr/bin/python3", "-c", code, "evil.invalid:443", "127.0.0.1:443"],
            timeout=3,
            output_limit=64,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.output, b"closed,closed\n")

    def test_deadline_kills_worker_and_namespace(self):
        started = time.monotonic()
        with self.assertRaises(provider_harness.HarnessError) as caught:
            sandbox.run_isolated(
                ["/usr/bin/python3", "-c", "import time; print('started',flush=True); time.sleep(30)"],
                timeout=0.3,
                output_limit=64,
            )
        self.assertEqual(caught.exception.kind, "timeout")
        self.assertLess(time.monotonic() - started, 3)

    def test_child_cannot_read_unmounted_host_temporary_file(self):
        with tempfile.TemporaryDirectory(prefix="host-secret-") as directory:
            secret = Path(directory) / "sentinel"
            secret.write_text("not mounted")
            result = sandbox.run_isolated(
                ["/usr/bin/python3", "-c", "import os,sys; print(os.path.exists(sys.argv[1]))", str(secret)],
                timeout=3,
                output_limit=64,
            )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.output, b"False\n")


if __name__ == "__main__":
    unittest.main()
