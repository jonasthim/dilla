"""Development-only network-isolated runner for untrusted YouTube extraction.

The worker runs in a bubblewrap network namespace. Its only network path is a
loopback HTTP CONNECT relay that reaches a short-lived host broker through a
private Unix socket. This module deliberately emits no proxy diagnostics.
"""

from __future__ import annotations

import ipaddress
import math
import os
import selectors
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import provider_harness


MAX_INPUT = 64 * 1024
MAX_STDERR = 64 * 1024
MAX_STDOUT = 2 * 1024 * 1024
MAX_CONNECT_HEADER = 16 * 1024
MAX_CONNECTIONS = 32
MAX_TUNNEL_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
READY_MESSAGE = b"DILLA-EGRESS-READY /1.0\r\n\r\n"
READY_ACK = b"DILLA-EGRESS-ACK /1.0\r\n\r\n"
DNS_TIMEOUT = 2.5
CONNECT_TIMEOUT = 4.0
IO_TIMEOUT = 10.0
MAX_ACCEPTED = 256
MAX_PENDING = 64 * 1024
BROKER_PORT = 3128
ALLOWED_SUFFIXES = ("youtube.com", "googlevideo.com", "ytimg.com")
ALLOWED_EXACT = frozenset(("youtube.com", "youtu.be"))


def _fail(kind: str) -> provider_harness.HarnessError:
    return provider_harness.HarnessError(kind)


def _valid_hostname(host: str) -> bool:
    if not host or len(host) > 253 or not host.isascii() or host.endswith("."):
        return False
    host = host.lower()
    if host not in ALLOWED_EXACT and not any(
        host.endswith("." + suffix) for suffix in ALLOWED_SUFFIXES
    ):
        return False
    labels = host.split(".")
    return all(
        0 < len(label) <= 63
        and label[0].isalnum()
        and label[-1].isalnum()
        and all(char.isalnum() or char == "-" for char in label)
        for label in labels
    )


def _parse_connect(header: bytes) -> str:
    """Return the validated hostname from one complete CONNECT request."""
    if len(header) > MAX_CONNECT_HEADER or not header.endswith(b"\r\n\r\n"):
        raise _fail("proxy request rejected")
    try:
        lines = header[:-4].decode("ascii").split("\r\n")
    except UnicodeDecodeError:
        raise _fail("proxy request rejected") from None
    if not lines or len(lines) > 34:
        raise _fail("proxy request rejected")
    request = lines[0].split(" ")
    if len(request) != 3 or request[0] != "CONNECT" or request[2] not in ("HTTP/1.0", "HTTP/1.1"):
        raise _fail("proxy request rejected")
    authority = request[1]
    # Reject userinfo, IP literals, IPv6 syntax, percent escapes, and ambiguous
    # authority spellings before policy checks.
    if authority.count(":") != 1 or "@" in authority or "[" in authority or "]" in authority or "%" in authority:
        raise _fail("proxy destination rejected")
    host, port = authority.rsplit(":", 1)
    if port != "443" or not _valid_hostname(host):
        raise _fail("proxy destination rejected")
    seen: set[str] = set()
    for line in lines[1:]:
        if not line or line[0] in " \t" or ":" not in line:
            raise _fail("proxy request rejected")
        name, value = line.split(":", 1)
        key = name.lower()
        if not name.isascii() or not name.replace("-", "").isalnum() or key in seen:
            raise _fail("proxy request rejected")
        seen.add(key)
        if key == "host":
            host_value = value.strip().lower()
            # FFmpeg's HTTP proxy client uses the proxy authority in Host even
            # for CONNECT. The CONNECT authority remains the sole destination.
            if host_value not in (host.lower(), host.lower() + ":443", "127.0.0.1:3128"):
                raise _fail("proxy request rejected")
        if key not in ("host", "proxy-connection", "connection", "user-agent"):
            raise _fail("proxy request rejected")
    return host.lower()


def _public_address(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise _fail("proxy resolution rejected") from None
    if isinstance(address, ipaddress.IPv6Address):
        if (
            address.ipv4_mapped is not None
            or address.sixtofour is not None
            or address.teredo is not None
            or address in ipaddress.IPv6Network("::/96")
            or address in ipaddress.IPv6Network("64:ff9b::/96")
            or address in ipaddress.IPv6Network("64:ff9b:1::/48")
        ):
            raise _fail("proxy resolution rejected")
    if (
        not address.is_global
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
        or address.is_loopback
        or address.is_link_local
        or address.is_private
    ):
        raise _fail("proxy resolution rejected")
    return address


def _resolve_public_addresses(
    host: str,
    *,
    deadline: float | None = None,
    stop_event: threading.Event | None = None,
) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    """Resolve in a bounded subprocess so libc DNS cannot strand a thread."""
    if not _valid_hostname(host):
        raise _fail("proxy destination rejected")
    resolver = (
        "import socket,sys; "
        "rows=socket.getaddrinfo(sys.argv[1],443,type=socket.SOCK_STREAM); "
        "print('\\n'.join(dict.fromkeys(row[4][0] for row in rows) if len(rows)<65 else []))"
    )
    remaining = DNS_TIMEOUT if deadline is None else min(DNS_TIMEOUT, deadline - time.monotonic())
    if remaining <= 0 or (stop_event is not None and stop_event.is_set()):
        raise _fail("proxy resolution failed")
    try:
        process = subprocess.Popen(
            [sys.executable, "-I", "-c", resolver, host],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin", "LANG": "C"},
        )
        end = time.monotonic() + remaining
        while True:
            if (stop_event is not None and stop_event.is_set()) or time.monotonic() >= end:
                process.terminate()
                try:
                    process.wait(timeout=0.1)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=0.2)
                raise _fail("proxy resolution failed")
            try:
                output, _ = process.communicate(timeout=min(0.1, end - time.monotonic()))
                break
            except subprocess.TimeoutExpired:
                continue
    except provider_harness.HarnessError:
        raise
    except (OSError, subprocess.TimeoutExpired):
        raise _fail("proxy resolution failed") from None
    if process.returncode != 0 or len(output) > 4096:
        raise _fail("proxy resolution failed")
    rows = output.decode("ascii", "ignore").splitlines()
    if not rows:
        raise _fail("proxy resolution failed")
    # A mixed public/private answer is rejected in full to prevent answer-order
    # tricks and rebinding between validation and connection.
    return [_public_address(row) for row in dict.fromkeys(rows)]


def _recv_header(sock: socket.socket) -> tuple[bytes, bytes]:
    sock.settimeout(IO_TIMEOUT)
    data = bytearray()
    while len(data) <= MAX_CONNECT_HEADER:
        chunk = sock.recv(min(2048, MAX_CONNECT_HEADER + 1 - len(data)))
        if not chunk:
            raise _fail("proxy request rejected")
        data.extend(chunk)
        end = data.find(b"\r\n\r\n")
        if end >= 0:
            boundary = end + 4
            if boundary != len(data):
                # Reject a body or pipelined tunnel bytes before the 200 reply.
                raise _fail("proxy request rejected")
            return bytes(data), b""
    raise _fail("proxy request rejected")


class _ByteBudget:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._used = 0

    def consume(self, amount: int) -> bool:
        with self._lock:
            if self._used + amount > MAX_TOTAL_BYTES:
                return False
            self._used += amount
            return True


def _bridge(
    left: socket.socket,
    right: socket.socket,
    budget: _ByteBudget,
    *,
    stop_event: threading.Event | None = None,
    deadline: float | None = None,
) -> None:
    left.setblocking(False)
    right.setblocking(False)
    sel = selectors.DefaultSelector()
    queues = {left: bytearray(), right: bytearray()}
    eof: set[socket.socket] = set()
    write_shutdown: set[socket.socket] = set()
    sel.register(left, selectors.EVENT_READ)
    sel.register(right, selectors.EVENT_READ)
    total = 0
    last_io = time.monotonic()
    try:
        while len(eof) < 2 or queues[left] or queues[right]:
            now = time.monotonic()
            if (stop_event is not None and stop_event.is_set()) or (deadline is not None and now >= deadline):
                return
            if now - last_io > IO_TIMEOUT:
                return
            events = sel.select(min(0.25, max(0.01, deadline - now) if deadline is not None else 0.25))
            for key, mask in events:
                source = key.fileobj
                destination = right if source is left else left
                if source not in eof and mask & selectors.EVENT_READ:
                    try:
                        chunk = source.recv(16 * 1024)
                    except BlockingIOError:
                        chunk = None
                    if chunk == b"":
                        eof.add(source)
                    elif chunk:
                        total += len(chunk)
                        if len(queues[destination]) + len(chunk) > MAX_PENDING:
                            return
                        if total > MAX_TUNNEL_BYTES or not budget.consume(len(chunk)):
                            return
                        queues[destination].extend(chunk)
                        last_io = time.monotonic()
                if queues[source] and mask & selectors.EVENT_WRITE:
                    try:
                        sent = source.send(queues[source][:16 * 1024])
                    except BlockingIOError:
                        sent = 0
                    if sent:
                        del queues[source][:sent]
                        last_io = time.monotonic()
            for endpoint in (left, right):
                peer = right if endpoint is left else left
                if endpoint in eof and not queues[peer] and peer not in write_shutdown:
                    try:
                        peer.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass
                    write_shutdown.add(peer)
                wanted = 0
                if endpoint not in eof and len(queues[peer]) <= MAX_PENDING - 16 * 1024:
                    wanted |= selectors.EVENT_READ
                if queues[endpoint]:
                    wanted |= selectors.EVENT_WRITE
                try:
                    if wanted:
                        if endpoint in sel.get_map():
                            sel.modify(endpoint, wanted)
                        else:
                            sel.register(endpoint, wanted)
                    elif endpoint in sel.get_map():
                        sel.unregister(endpoint)
                except (KeyError, ValueError):
                    pass
    except (OSError, TimeoutError):
        return
    finally:
        sel.close()


class _BoundedServer:
    """Small bounded accept loop; handlers are always daemon threads."""

    def __init__(self, listener: socket.socket, handler, *, slots: int = MAX_CONNECTIONS):
        self.listener = listener
        self.handler = handler
        self.slots = threading.BoundedSemaphore(slots)
        self.stop_event = threading.Event()
        self.active: set[socket.socket] = set()
        self.handlers: set[threading.Thread] = set()
        self.accepted = 0
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def start(self) -> None:
        self.listener.settimeout(0.25)
        self.thread.start()

    def _serve(self) -> None:
        while not self.stop_event.is_set():
            try:
                conn, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self.accepted += 1
            if self.accepted > MAX_ACCEPTED or not self.slots.acquire(blocking=False):
                conn.close()
                continue
            with self.lock:
                self.active.add(conn)
            handler = threading.Thread(target=self._handle, args=(conn,), daemon=True)
            with self.lock:
                self.handlers.add(handler)
            handler.start()

    def _handle(self, conn: socket.socket) -> None:
        try:
            self.handler(conn)
        except Exception:
            pass
        finally:
            try:
                conn.close()
            finally:
                with self.lock:
                    self.active.discard(conn)
                    self.handlers.discard(threading.current_thread())
                self.slots.release()

    def close(self) -> None:
        self.stop_event.set()
        try:
            self.listener.close()
        except OSError:
            pass
        with self.lock:
            active = list(self.active)
        for conn in active:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                conn.close()
            except OSError:
                pass
        join_deadline = time.monotonic() + DNS_TIMEOUT + 0.75
        self.thread.join(timeout=max(0, join_deadline - time.monotonic()))
        with self.lock:
            handlers = list(self.handlers)
        for handler in handlers:
            handler.join(timeout=max(0, join_deadline - time.monotonic()))


class _Broker:
    def __init__(self, socket_path: Path, deadline: float):
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(socket_path))
        self.listener.listen(MAX_CONNECTIONS)
        os.chmod(socket_path, 0o600)
        self.budget = _ByteBudget()
        self.deadline = deadline
        self.stop_event = threading.Event()
        self.ready_event = threading.Event()
        self.upstreams: set[socket.socket] = set()
        self.upstream_lock = threading.Lock()
        self.server = _BoundedServer(self.listener, self._handle)

    def start(self) -> None:
        self.server.start()

    def close(self) -> None:
        self.stop_event.set()
        with self.upstream_lock:
            upstreams = list(self.upstreams)
        for upstream in upstreams:
            try:
                upstream.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            upstream.close()
        self.server.close()

    def _handle(self, client: socket.socket) -> None:
        client.settimeout(IO_TIMEOUT)
        header, _ = _recv_header(client)
        if header == READY_MESSAGE:
            self.ready_event.set()
            client.sendall(READY_ACK)
            return
        host = _parse_connect(header)
        if self.stop_event.is_set() or time.monotonic() >= self.deadline:
            return
        addresses = _resolve_public_addresses(host, deadline=self.deadline, stop_event=self.stop_event)
        upstream: socket.socket | None = None
        for address in addresses:
            remaining = self.deadline - time.monotonic()
            if self.stop_event.is_set() or remaining <= 0:
                return
            candidate = socket.socket(address.version == 4 and socket.AF_INET or socket.AF_INET6, socket.SOCK_STREAM)
            candidate.settimeout(min(CONNECT_TIMEOUT, remaining))
            with self.upstream_lock:
                self.upstreams.add(candidate)
            try:
                candidate.connect((str(address), 443))
                upstream = candidate
                break
            except OSError:
                with self.upstream_lock:
                    self.upstreams.discard(candidate)
                candidate.close()
        if upstream is None:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        try:
            with upstream:
                client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                _bridge(client, upstream, self.budget, stop_event=self.stop_event, deadline=self.deadline)
        finally:
            with self.upstream_lock:
                self.upstreams.discard(upstream)


def _relay_handler(client: socket.socket) -> None:
    client.settimeout(IO_TIMEOUT)
    header, _ = _recv_header(client)
    _parse_connect(header)
    broker = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    broker.settimeout(IO_TIMEOUT)
    try:
        broker.connect("/run/egress.sock")
        broker.sendall(header)
        # Before a successful CONNECT response, bound and validate the status.
        response = bytearray()
        while len(response) <= 4096:
            chunk = broker.recv(1024)
            if not chunk:
                return
            response.extend(chunk)
            if b"\r\n\r\n" in response:
                boundary = response.find(b"\r\n\r\n") + 4
                initial = bytes(response[boundary:])
                client.sendall(response[:boundary])
                if not response.startswith(b"HTTP/1.1 200 "):
                    return
                if initial:
                    client.sendall(initial)
                _bridge(client, broker, _ByteBudget())
                return
        return
    finally:
        broker.close()


def _sandbox_main(argv: list[str]) -> int:
    """Entry point inside bwrap: start localhost relay, apply limits, run worker."""
    import resource

    # Python -c retains the command-line separator in sys.argv. It belongs to
    # bwrap's option grammar and must not be mistaken for the worker executable.
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        return 125
    timeout_seconds = int(os.environ.get("DILLA_CPU_LIMIT", "121"))
    try:
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        resource.setrlimit(resource.RLIMIT_CPU, (timeout_seconds, timeout_seconds + 1))
        resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024**2, 128 * 1024**2))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    except (OSError, ValueError):
        return 125
    home = Path("/tmp/home")
    home.mkdir(mode=0o700, exist_ok=True)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
    try:
        listener.bind(("127.0.0.1", BROKER_PORT))
        listener.listen(MAX_CONNECTIONS)
    except OSError:
        listener.close()
        return 125
    relay = _BoundedServer(listener, _relay_handler)
    relay.start()
    ready = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    ready.settimeout(1.0)
    try:
        ready.connect("/run/egress.sock")
        ready.sendall(READY_MESSAGE)
        if ready.recv(len(READY_ACK)) != READY_ACK:
            raise OSError("broker readiness acknowledgement missing")
    except OSError:
        relay.close()
        ready.close()
        return 125
    ready.close()
    child_env = {
        "HOME": str(home),
        "TMPDIR": "/tmp",
        "PATH": "/opt/dilla-tools:/usr/bin:/bin",
        "PYTHONPATH": "/opt/dilla-probe",
        "HTTP_PROXY": "http://127.0.0.1:3128",
        "HTTPS_PROXY": "http://127.0.0.1:3128",
        "http_proxy": "http://127.0.0.1:3128",
        "https_proxy": "http://127.0.0.1:3128",
        "ALL_PROXY": "http://127.0.0.1:3128",
        "all_proxy": "http://127.0.0.1:3128",
        "NO_PROXY": "",
        "no_proxy": "",
        "NODE_OPTIONS": "--disable-wasm-trap-handler --max-old-space-size=128",
        "SSL_CERT_FILE": "/etc/ssl/cert.pem",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    child: subprocess.Popen[bytes] | None = None

    def forward(signum, _frame) -> None:
        if child is not None:
            try:
                child.send_signal(signum)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    try:
        child = subprocess.Popen(argv, stdin=None, stdout=None, stderr=None, env=child_env, close_fds=True)
        return child.wait()
    finally:
        if child is not None and child.poll() is None:
            child.kill()
            try:
                child.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
        relay.close()


def _validate_tools_dir(tools_dir: Path | None) -> Path | None:
    if tools_dir is None:
        return None
    try:
        candidate = Path(tools_dir)
        expected = Path(__file__).resolve().parent / ".youtube-venv"
        if not candidate.is_absolute() or candidate != expected or candidate.is_symlink() or not candidate.is_dir():
            raise _fail("invalid tools path")
        resolved = candidate.resolve(strict=True)
        if resolved != expected or not resolved.is_dir():
            raise _fail("invalid tools path")
        return resolved
    except (OSError, RuntimeError):
        raise _fail("invalid tools path") from None


def _node_binary() -> Path:
    node = shutil.which("node")
    if not node:
        raise _fail("unavailable")
    try:
        path = Path(node).resolve(strict=True)
        if not path.is_file() or not os.access(path, os.X_OK):
            raise _fail("unavailable")
        return path
    except (OSError, RuntimeError):
        raise _fail("unavailable") from None


def _system_ca_bundle() -> Path:
    """Resolve OpenSSL's compiled system bundle, independent of host env overrides."""
    try:
        defaults = ssl.get_default_verify_paths()
        if not defaults.openssl_cafile:
            raise _fail("unavailable")
        bundle = Path(defaults.openssl_cafile).resolve(strict=True)
        if not bundle.is_file() or bundle.stat().st_size > 16 * 1024 * 1024:
            raise _fail("unavailable")
        home = Path.home().resolve()
        if bundle == home or home in bundle.parents:
            raise _fail("unavailable")
        return bundle
    except (OSError, RuntimeError):
        raise _fail("unavailable") from None


def _bwrap_args(socket_path: Path, tools_dir: Path | None, cpu_limit: int) -> list[str]:
    bwrap = shutil.which("bwrap")
    if not bwrap:
        raise _fail("unavailable")
    script_dir = Path(__file__).resolve().parent
    node_binary = _node_binary()
    ca_bundle = _system_ca_bundle()
    worker_script = script_dir / "youtube_probe.py"
    harness_script = script_dir / "provider_harness.py"
    if not worker_script.is_file() or not harness_script.is_file():
        raise _fail("unavailable")
    args = [
        bwrap,
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/usr",
        "/usr",
    ]
    for system_path in ("/lib", "/lib64"):
        if os.path.exists(system_path):
            args.extend(("--ro-bind", system_path, system_path))
    args.extend(("--dir", "/bin"))
    if os.path.islink("/bin"):
        args[-2:] = ["--symlink", os.readlink("/bin"), "/bin"]
    else:
        args[-2:] = ["--ro-bind", "/bin", "/bin"]
    # Mount only the selected Node executable, not its personal parent tree.
    args.extend(("--ro-bind", str(node_binary), "/usr/bin/node"))
    args.extend((
        "--dir", "/etc",
        "--dir", "/etc/ssl",
        "--ro-bind", str(ca_bundle), "/etc/ssl/cert.pem",
        "--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs",
    ))
    args.extend(("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run"))
    args.extend(("--dir", "/opt", "--dir", "/opt/dilla-probe"))
    args.extend(("--ro-bind", str(script_dir / "youtube_sandbox.py"), "/opt/dilla-probe/youtube_sandbox.py"))
    args.extend(("--ro-bind", str(worker_script), "/opt/dilla-probe/youtube_probe.py"))
    args.extend(("--ro-bind", str(harness_script), "/opt/dilla-probe/provider_harness.py"))
    if tools_dir is not None:
        args.extend(("--ro-bind", str(tools_dir), "/opt/dilla-tools"))
    else:
        args.extend(("--dir", "/opt/dilla-tools"))
    args.extend(("--bind", str(socket_path), "/run/egress.sock"))
    args.extend(
        (
            "--setenv", "HOME", "/tmp/home",
            "--setenv", "TMPDIR", "/tmp",
            "--setenv", "PATH", "/opt/dilla-tools:/usr/bin:/bin",
            "--setenv", "PYTHONPATH", "/opt/dilla-probe",
            "--setenv", "HTTP_PROXY", "http://127.0.0.1:3128",
            "--setenv", "HTTPS_PROXY", "http://127.0.0.1:3128",
            "--setenv", "http_proxy", "http://127.0.0.1:3128",
            "--setenv", "https_proxy", "http://127.0.0.1:3128",
            "--setenv", "ALL_PROXY", "http://127.0.0.1:3128",
            "--setenv", "all_proxy", "http://127.0.0.1:3128",
            "--setenv", "NO_PROXY", "",
            "--setenv", "no_proxy", "",
            "--setenv", "DILLA_CPU_LIMIT", str(cpu_limit),
            "--setenv", "NODE_OPTIONS", "--disable-wasm-trap-handler --max-old-space-size=128",
            "--setenv", "SSL_CERT_FILE", "/etc/ssl/cert.pem",
            "--setenv", "LANG", "C.UTF-8",
            "--setenv", "LC_ALL", "C.UTF-8",
            "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
            "/usr/bin/python3", "-I", "-c",
            "import sys; sys.path.insert(0, '/opt/dilla-probe'); from youtube_sandbox import _sandbox_main; raise SystemExit(_sandbox_main(sys.argv[1:]))",
            "--",
        )
    )
    return args


def run_isolated(
    argv: list[str],
    *,
    timeout: float,
    output_limit: int,
    tools_dir: Path | None = None,
    input_data: bytes | None = None,
) -> provider_harness.ProcessResult:
    """Run a trusted probe command with only allowlisted HTTPS egress."""
    if not argv or not all(isinstance(arg, str) for arg in argv):
        raise ValueError("argv must be a non-empty string sequence")
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 120:
        raise ValueError("timeout must be positive and no greater than 120 seconds")
    if not isinstance(output_limit, int) or not 0 <= output_limit <= MAX_STDOUT:
        raise ValueError("output_limit must be between 0 and 2 MiB")
    if not math.isfinite(timeout):
        raise ValueError("timeout and output_limit must be positive")
    if input_data is not None and (not isinstance(input_data, bytes) or len(input_data) > MAX_INPUT):
        raise ValueError("input_data must be bytes no larger than 64 KiB")
    validated_tools = _validate_tools_dir(tools_dir)
    if "\x00" in "".join(argv):
        raise ValueError("argv contains NUL")
    temp_root: tempfile.TemporaryDirectory[str] | None = None
    broker: _Broker | None = None
    process: subprocess.Popen[bytes] | None = None
    selector = selectors.DefaultSelector()
    stdout = bytearray()
    stderr_count = 0
    deadline = time.monotonic() + timeout
    try:
        temp_root = tempfile.TemporaryDirectory(prefix="youtube-egress-")
        root = Path(temp_root.name)
        socket_path = root / "egress.sock"
        broker = _Broker(socket_path, deadline)
        broker.start()
        bwrap_args = _bwrap_args(socket_path, validated_tools, max(2, int(timeout) + 1))
        try:
            process = subprocess.Popen(
                [*bwrap_args, *argv],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                start_new_session=True,
                env={"PATH": "/usr/bin:/bin", "LANG": "C"},
                bufsize=0,
            )
        except (FileNotFoundError, PermissionError, OSError):
            raise _fail("unavailable") from None
        assert process.stdout is not None and process.stderr is not None and process.stdin is not None
        for stream in (process.stdout, process.stderr, process.stdin):
            os.set_blocking(stream.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        payload = memoryview(input_data or b"")
        write_offset = 0
        if payload:
            selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            process.stdin.close()
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _fail("timeout")
            for key, _ in selector.select(min(remaining, 0.1)):
                if key.data == "stdin":
                    if write_offset >= len(payload):
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    try:
                        written = os.write(key.fd, payload[write_offset : write_offset + 4096])
                    except BrokenPipeError:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    write_offset += written
                    if write_offset >= len(payload):
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                    continue
                current = stdout if key.data == "stdout" else None
                chunk = os.read(key.fd, min(4096, output_limit + 1 - len(current)) if current is not None else 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if current is not None:
                    current.extend(chunk)
                    if len(current) > output_limit:
                        raise _fail("output limit")
                else:
                    # Stderr is drained separately and never retained. Stop a
                    # producer that exceeds its independent output budget.
                    stderr_count += len(chunk)
                    if stderr_count > MAX_STDERR:
                        raise _fail("stderr limit")
            if process.poll() is not None and not broker.ready_event.is_set():
                if not broker.ready_event.wait(timeout=min(0.25, max(0, deadline - time.monotonic()))):
                    raise _fail("unavailable")
            if process.poll() is not None and not selector.get_map():
                break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise _fail("timeout")
        try:
            returncode = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            raise _fail("timeout") from None
        if not broker.ready_event.is_set() and not broker.ready_event.wait(timeout=0.25):
            raise _fail("unavailable")
        return provider_harness.ProcessResult(returncode, bytes(stdout))
    except provider_harness.HarnessError:
        raise
    except Exception:
        # Internal errors are reduced to a static kind; finally still tears down
        # the process group, broker, relay, and temporary socket path.
        raise _fail("unavailable") from None
    finally:
        selector.close()
        if process is not None:
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except OSError:
                    pass
            if process.stdout is not None:
                try:
                    process.stdout.close()
                except OSError:
                    pass
            if process.stderr is not None:
                try:
                    process.stderr.close()
                except OSError:
                    pass
            provider_harness._terminate_and_reap(process)
        if broker is not None:
            broker.close()
        if temp_root is not None:
            temp_root.cleanup()
