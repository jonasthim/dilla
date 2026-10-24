# YouTube provider process sandbox

`PCMStarter` and `NewMetadataResolver` use the package-embedded Python worker,
host Python 3, and bubblewrap. Production images must install Python 3 and
bubblewrap and allow the service account to create user, mount, PID, and network
namespaces. `Bubblewrap` and `Python` paths may be supplied explicitly; blank
values use `PATH` lookup. If a dependency or namespace is unavailable, startup
returns `ErrSandboxUnavailable` and does not fall back to a host process.

Configure absolute executable paths for yt-dlp, FFmpeg, and Node. The sandbox
mounts the read-only system runtime trees, public CA certificates, and only the
configured tool paths outside those trees (or the dedicated `.youtube-venv`
containing yt-dlp). It does not mount `/home`, provider credentials, browser
profiles, or private TLS keys.
The extractor receives a clean environment and runs with argv; no shell is used.

The worker runs in a bubblewrap network namespace without host interfaces. It
can reach its loopback HTTP proxy, which forwards CONNECT requests over a private
Unix socket to the Go broker. The broker permits port 443 only on
`youtube.com`, `youtu.be`, and subdomains of `youtube.com`, `googlevideo.com`,
and `ytimg.com`. It resolves each hostname on the host, rejects the complete
answer set if any address is non-public, then connects to a validated numeric
address to avoid a second DNS lookup. Proxy variables are only for reaching the
broker; the network namespace supplies direct-egress isolation.

PCM output is streamed and capped at 512 MiB by default; callers can lower that
limit. Each CONNECT tunnel is capped at 512 MiB and all tunnels in one process
share a 1 GiB budget. PCM sessions end on context cancellation or after at most
24 hours by default. Metadata runs have a two-minute cap and bounded output.

`OpusStarter` accepts an already-resolved YouTube video track and explicitly
bridges its sandboxed 44.1 kHz stereo PCM into the existing bounded Opus runtime.
It returns the sample source without creating a LiveKit publisher or opening a
voice call; an owning playback lifecycle must make that separate decision.

The tests launch fake extractor and FFmpeg processes in the real local
bubblewrap namespace, confirm direct public-network access fails, check the
broker hostname/IP policy, and verify argument, cancellation, and output bounds.
They do not contact YouTube or qualify live playback. Production deployment
still needs host-level namespace and tool-version qualification.
