# Deploying dillad

dillad is one static binary (`dillad`) plus one file beside it, `dilla_core_wasi.wasm`, the MLS
core it runs inside wazero. Everything else an instance needs, the TLS certificate, the TURN relay
and the LiveKit SFU, runs inside the same process. This page covers the three ways to run it (a
container image, a systemd unit, a Proxmox LXC helper), the TLS modes, and the backup and restore
runbook.

`dillad doctor --config=/etc/dilla/dilla.toml` checks the configuration, the database, the data
directory's mode and ownership, the wasi core, the clock, the certificate, the TURN relay, UDP
reachability and the blob tree, and prints one line per check. Run it after every change.

## 1. The TLS modes

`tls.mode` in `dilla.toml` is the one switch. `dillad init` writes `acme_tls_alpn`.

| Mode | Use it when | What it needs |
|---|---|---|
| `acme_tls_alpn` (default) | dillad is reachable from the internet on 443/tcp at `instance.domain`, and nothing else on the host owns 443. | `instance.domain` resolving to the host, `instance.public_ip`, `tls.agreed = true`. Issuance uses the TLS-ALPN-01 challenge on 443 itself, so no port 80 is needed. |
| `acme_dns` | 443 is not reachable from the internet while the certificate is issued (a home connection, a split-horizon network), or you want a wildcard. | The same, plus `tls.dns.provider` and `tls.dns.credentials_file`. Issuance uses the DNS-01 challenge, which needs no inbound connection. |
| `acme_ip` | The instance has no domain of its own and clients connect to an address. | A public IP the certificate authority can reach on 443/tcp (validation is TLS-ALPN-01). dillad forces the `shortlived` profile, the only one that permits IP names, so certificates are renewed far more often; `tls.renewal_window_ratio` sets when. |
| `behind_proxy` | A reverse proxy you already run terminates TLS. | dillad listens on `server.plain_listen` (`127.0.0.1:8080` by default) and trusts `X-Forwarded-For` only from `server.trusted_proxy_cidrs`, which must be non-empty. `instance.public_ip` and `tls.agreed` are not required. |

In every mode except `behind_proxy`, TURN shares 443 with the web server: a demultiplexer in front
of the TLS listener hands STUN to the relay and everything else to HTTPS. Only 443/tcp and
7882/udp (LiveKit's media port) need to be open.

### What the TURN relay can reach

The relay is restricted to the host's own SFU, by address and by port. It refuses a
`CreatePermission` or `ChannelBind` for any peer address that is not `livekit.node_ip` (plus, with
`livekit.advertise_internal_ip`, the host's interface addresses LiveKit also listens on, minus
`livekit.ips_excludes`), and it refuses all of them when LiveKit is off. On an admitted address the
relay socket then exchanges datagrams only with LiveKit's media port, `livekit.udp_port` (7882; with
`udp_port = 0`, LiveKit's 50000-60000 range), and never with another relay allocation: anything a
client sends elsewhere, and anything that arrives from elsewhere, is dropped and counted in
`dilla_turn_peer_drops_total`. Other UDP services on the admitted addresses, loopback included when
`livekit.node_ip` is unset, are not reachable through the relay, and one member cannot push traffic
into another member's relayed call. With `udp_port = 0` every port of that range on the admitted
addresses is reachable, so keep other services out of 50000-60000 there, or set a fixed `udp_port`.

The relay also bounds what one credential, and the whole instance, can hold: a TURN connection that
has not created an allocation within 30 seconds of connecting is closed, and so is one that has gone
61 minutes without an authenticated request on its allocation (longer than any allocation lives
without a refresh). Unauthenticated bytes, an `Allocate` refused at a quota, and the requests of a
revoked device or an expired credential do not keep a connection open. An `Allocate`
with `EVEN-PORT` or `RESERVATION-TOKEN` is refused with 508 (browsers never send either). At most
8192 relay allocations are live on the instance at once, whatever the devices; past that, an
`Allocate` is refused with 486, counted in `dilla_turn_capacity_refusals_total` and logged at WARN.
This is a fixed backstop until device enrolment per user is capped.

The relay offers UDP relays only. It refuses an RFC 6062 TCP allocation (`REQUESTED-TRANSPORT` TCP)
with STUN error 508, so no `Connect` can open a TCP connection to an admitted address. Browsers never
ask for one. Regression note: before this was fixed, pion's default relay generator served TCP
allocations, and any holder of a call credential could reach every TCP service on the admitted
addresses, loopback included. If you ran an instance built before that fix, check your TCP services
on those addresses.

### The `behind_proxy` TURN consequence

A TLS-terminating proxy cannot forward the TURN traffic that shares 443, so in `behind_proxy` mode
the relay has its own listener, `turn.listen`, and it is required while `turn.enabled` is true.
Either the operator publishes a second TCP port straight to dillad for TURN, or the UI shows the
explicit relay-unavailable dialog and the call is UDP-or-nothing. Decide this when you pick the
mode: a proxy in front of dillad is a convenient way to share 443 with other sites, and the price
is one more port to open, or calls that fail for people behind a UDP-blocking network.

dillad does not terminate TLS on `turn.listen`: the relay there is plain TURN over TCP (a recorded
deviation from the design, which puts TURN/TLS on the relay itself before the first public
release). Media stays DTLS-SRTP with SFrame end to end, but a relay credential's username
(`<expiry>:<device_id>:<issued>`), the allocation requests and the call timing cross the network in the
clear unless you put TLS in front of it: a TCP stream proxy that terminates TLS and forwards to
`turn.listen` (with `turn.proxy_protocol` if it sends a PROXY header). Tell clients where it is with
`turn.public_url`, which they are handed verbatim instead of `turn:<domain>:<turn.listen port>`:

```toml
[turn]
enabled = true
listen = "127.0.0.1:13478"
public_url = "turns:turn.example.org:5349?transport=tcp"
```

Set `turn.public_url` whenever the port the world reaches differs from `turn.listen`'s, TLS or not.

### TURN knobs for long calls

| key | default | what it bounds |
|---|---|---|
| `turn.credential_ttl` | `"1h"` (at least `"1m"`) | how long a relay credential handed out with a call can open a new allocation |
| `turn.max_allocation_age` | `"2h"` | how long one allocation keeps working after its credential was issued; never shorter than `credential_ttl` |
| `turn.allocations_per_device` | `4` (1–16) | live allocations per device; a browser needs about two per network it gathers on |

The credential's expiry is checked when an allocation is made, not on every refresh, so a relayed
call outlives its credential; `turn.max_allocation_age` is measured from the issue time each
credential carries, so changing `turn.credential_ttl` never lengthens an old credential's life, and
after it the browser re-allocates with the servers it re-fetched. A revoked, quarantined or
logged-out device loses its relay allocations at once. A user disabled by the running instance loses
them as soon as the call cut queue handles the user (at once while the SFU runs and the queue has
room), otherwise like a revocation written by `dillad admin`, which reaches a device holding an
allocation within about a minute (62 seconds at worst) while the database answers; the relay's own
lookup of a device on its next authenticated request can be up to 30 seconds late, as a "not barred"
answer is trusted for 30 seconds. The relay holds
its revocations in memory, so it refuses every credential issued before it started: after a restart
every client fetches a new one with its next call start. If the host's wall clock steps backwards, a
cut device's call start answers 429 until the clock passes the cut, and a step back past the moment
`dillad serve` started refuses every start until the clock passes it; keep the clock disciplined
(NTP slewing, not stepping). `dillad doctor` run from another host mints its relay probe on that
host's clock, which must be within 2 seconds of the server's. Watch `dilla_turn_allocations`, `dilla_turn_quota_refusals_total`,
`dilla_turn_relay_bytes_total` and the `turn_relay` leg of the admin diagnostics; raise
`turn.allocations_per_device` when refusals appear. `dilla_turn_cut_overflows_total` counts the
revocations that found the relay's revocation table full (65 536 live entries) and refused every
device's earlier credentials instead, each logged at WARN; any value above 0 means a mass relay
reconnect happened and is worth investigating. If `livekit.node_ip` is a public address the
host does not hold (behind NAT) and `livekit.advertise_internal_ip` is on, the relay does not admit
`node_ip` and `dillad serve` logs a warning saying so: relayed media pairs with the host's own
addresses instead.

### Behind a WireGuard tunnel (Pangolin): MTU and UDP 7882

Pangolin's `gerbil` and `newt` both default the tunnel MTU to **1280** (not the 1420 the design
assumed). WebRTC keeps RTP packets at most 1200 bytes, which fits with 36 bytes to spare over IPv4
and 16 over IPv6; raise `MTU` on both ends only together. The raw UDP forward for LiveKit's media
port is Traefik's UDP router in gerbil's network namespace, and Pangolin's installer defines no UDP
entry point, so add one with a session timeout well above LiveKit's 2-second keepalive (Traefik's
default is 3 seconds, and every expiry re-dials with a new source port):

```yaml
# Traefik static configuration
entryPoints:
  udp-7882:
    address: ":7882/udp"
    udp:
      timeout: 30s
```

and publish `7882:7882/udp` on the `gerbil` service. The 30-second value is pending the founder-path
measurement (follow-up card 6); the instance itself still publishes only 443/tcp and 7882/udp.

### LiveKit

dillad renders LiveKit's configuration itself from `[livekit]`; there is no LiveKit YAML to edit.
What it fixes, and the keys that change it:

- **Codecs.** Opus (no RED, no PCMU/PCMA), VP8 and H.264; dilla's clients publish H.264 only as
  Constrained Baseline with `packetization-mode=1`. (LiveKit cannot be limited to that profile in
  its own configuration without refusing H.264 altogether, so the restriction lives in the
  clients.) Every call is end-to-end encrypted frame by frame, so nothing else could be decrypted
  on the other side anyway. `livekit.vp9 = true` is refused at start: VP9 has no frame test vector
  yet and has not been measured through LiveKit. AV1 and H.265 are never offered.
- **Loopback only.** `livekit.bind_address` (default `127.0.0.1`) must be a loopback IP literal
  (`127.0.0.1`, `::1`); a hostname such as `localhost`, `0.0.0.0` or a LAN address is refused at
  start. Clients reach LiveKit only through dillad's `/rtc` proxy, which checks every join. A load
  rig or any other direct LiveKit client on another host reaches signalling through an ssh tunnel
  to loopback (`ssh -L 7880:127.0.0.1:7880 <host>`), with media direct on UDP — never by binding
  LiveKit to a LAN address.
- **No TCP fallback.** LiveKit's own TCP fallback is off and `livekit.tcp_port` stays 0: a client
  that cannot reach UDP 7882 relays through TURN/TLS on 443 instead.
- **STUN.** `livekit.stun_servers` defaults to `<instance.domain>:3478` and is never served: it only
  keeps LiveKit from advertising Google's and Twilio's STUN servers to clients, which use the ICE
  servers dillad's calls route hands them.
- **Webhooks.** LiveKit reports joins, leaves and publications to dillad on
  `livekit.webhook_listen` (default `127.0.0.1:7883`), which must be a loopback address; it is
  signed with LiveKit's own API key. A non-default value while `livekit.enabled = false` is
  refused: nothing would listen there.
- **Host limits.** `livekit.limit_num_tracks` and `livekit.limit_bytes_per_sec` (bytes, not bits)
  are LiveKit's node-wide join gates, unset by default. They refuse new joins once reached, so size
  them generously: one 25-person voice call is about 600 forwarded tracks.
- **Publish caps.** `livekit.max_audio_bitrate_kbps` (64) and `livekit.max_share_bitrate_kbps`
  (2500) are handed to clients with every call token.
- **Which addresses LiveKit offers, and `ips_excludes`.** LiveKit opens its media socket
  (`udp_port`) on each address of the host's up interfaces (loopback only when `node_ip` is
  loopback, and never `::1`), skipping those inside `livekit.ips_excludes`, and builds its host
  candidates only from those sockets. `node_ip` is then offered for each of them, beside the local address with
  `advertise_internal_ip = true` (the default) or instead of it with `false`. So `ips_excludes` can
  drop an address but never adds one: if it covers every address the SFU has, LiveKit offers no
  candidate at all and every call fails, and `dillad serve` refuses to start (exit 78) with a message
  saying so. Use it with host networking or systemd to keep addresses such as `docker0`, WireGuard or
  Tailscale out of the candidates, and never on the address `node_ip` is, or the only address left.
- **Docker with a bridge network.** Do NOT exclude the bridge range: the container's `172.x`
  address is its only address, and the socket on it is where Docker delivers the published 7882/udp.
  Set `livekit.node_ip` to the public address and leave `ips_excludes` empty. With the default
  `advertise_internal_ip = true` clients also see the `172.x` candidate, which they cannot reach and
  skip after a failed check; the relay, inside the same container, pairs with it on the bridge. With
  `advertise_internal_ip = false` only `node_ip` is offered; the relay then reaches the SFU through
  the host's port mapping (a hairpin through `node_ip`), which works only if the host lets a
  container reach its own published port on the public address. This recipe is derived from
  LiveKit's source (mediatransportutil `rtcconfig/webrtc_config.go`, `transport/createmux.go`,
  livekit/ice `gather.go`) and has not been measured on a real bridge network. Check it on yours:
  open `chrome://webrtc-internals` during a call and confirm a remote `host` candidate on
  `node_ip:7882` and a connected pair, then repeat with the browser forced to the relay
  (`iceTransportPolicy: "relay"`, or UDP to 7882 blocked) and confirm the call still connects.
- **Logs and metrics.** LiveKit's and pion's logs appear in dillad's own log (pion's only at
  ERROR) with a fixed set of fields — no SDP, no addresses, ids cut to eight characters — at most
  20 lines in a burst and 5 a second per message, with one "LiveKit log lines suppressed" line
  every 10 seconds counting the rest. LiveKit's `livekit_*` metrics appear on dillad's `/metrics`
  beside `dilla_*`, without protocol version, country or other client-written values; the SDK label
  keeps only LiveKit's enum names.
- **If LiveKit stops.** The in-process SFU cannot be restarted inside a running dillad: the
  `livekit` readiness gate turns red and dillad exits with status 69 (`EX_UNAVAILABLE`), and the
  systemd unit or the container's restart policy starts it again.

## 2. Compose

The image is `ghcr.io/jonasthim/dilla/dillad`, built for linux/amd64 and linux/arm64 on distroless
`static-debian13:nonroot`. It runs as UID/GID 65532, has no shell and no package manager, and
exposes exactly 443/tcp and 7882/udp. `deploy/compose.yaml` is the reference file.

```sh
mkdir dilla && cd dilla
mkdir data
# The data directory must be owned 65532:65532 on the host. distroless has no shell, so nothing
# can chown it at start, and a root-owned directory makes the container exit with a permission error.
sudo chown -R 65532:65532 ./data
cp /path/to/deploy/compose.yaml .

# One-shot init: creates the database, the instance keys, the TURN and LiveKit secrets and
# data/dilla.toml, then prints the bootstrap invite link. It is printed once and stored nowhere.
docker run --rm -v "$PWD/data:/var/lib/dilla" ghcr.io/jonasthim/dilla/dillad:latest \
  init --data-dir=/var/lib/dilla --domain=chat.example.org --public-ip=203.0.113.10 --agree-tos

# compose.yaml mounts ./dilla.toml; init wrote it into the data directory, owned 65532.
sudo mv ./data/dilla.toml ./dilla.toml

docker compose up -d
docker compose ps        # "healthy" after the first check; the check runs `dillad doctor --quiet`
docker compose logs -f dillad
```

The traps, in the order people meet them:

- **Bind-mount ownership.** `sudo chown -R 65532:65532 ./data` before the first start, as above.
  The same goes for a directory restored from a backup.
- **`network_mode: host` cannot bind 443.** Docker sets `net.ipv4.ip_unprivileged_port_start`
  only for private networks, so a host-networked container running as UID 65532 fails with
  "permission denied" on 443. Keep the bridged network and the `ports:` mapping, or, if you must use
  host networking, add `sysctls: { net.ipv4.ip_unprivileged_port_start: "0" }`.
- **Only 443/tcp and 7882/udp are published.** A firewall in front of the host must allow both.
- **Keep `turn.relay_ip = "auto"`.** init writes it, and serve binds the relay on the container's
  own address. The public IP is not an address of a bridged container, so setting it there makes
  every relay allocation fail; `dillad doctor` then shows the `turn` leg red with a fix naming
  `turn.relay_ip`.
- **Update deliberately.** The CA bundle in the image is fixed when the image is built; pin the
  image by digest and pull a new build rather than floating `:latest`.

## 3. systemd

`deploy/dilla.service` is a `Type=notify` unit: dillad sends `READY=1` once it is listening, so
`systemctl start` returns when the instance is up, and `TimeoutStartSec=300s` leaves room for
certificate issuance and a migration. It runs as the `dillad` user with only
`CAP_NET_BIND_SERVICE`, keeps its state in `/var/lib/dillad` (mode 0700) and reads
`/etc/dilla/dilla.toml`.

```sh
sudo install -m 0755 dillad-linux-amd64 /usr/local/bin/dillad
# Beside the binary: dillad looks for the wasi core in the directory its own executable is in.
sudo install -m 0644 dilla_core_wasi.wasm /usr/local/bin/dilla_core_wasi.wasm
sudo install -m 0644 deploy/dilla.service /etc/systemd/system/dilla.service
sudo useradd --system --user-group --no-create-home --home-dir /var/lib/dillad --shell /usr/sbin/nologin dillad

sudo /usr/local/bin/dillad init --data-dir=/var/lib/dillad \
  --domain=chat.example.org --public-ip=203.0.113.10 --agree-tos
# init wrote /var/lib/dillad/dilla.toml; the unit reads /etc/dilla/dilla.toml.
sudo install -d -m 0755 /etc/dilla
sudo install -m 0640 -o root -g dillad /var/lib/dillad/dilla.toml /etc/dilla/dilla.toml
sudo rm /var/lib/dillad/dilla.toml
sudo chown -R dillad:dillad /var/lib/dillad

sudo systemctl daemon-reload
sudo systemctl enable --now dilla
sudo -u dillad /usr/local/bin/dillad doctor --config=/etc/dilla/dilla.toml
journalctl -o cat -u dilla | jq .
```

Two directives are absent on purpose, and each has a comment in the unit:

- `MemoryDenyWriteExecute` is not set. wazero's compiler back end writes and then executes
  generated machine code, so the option would make the MLS path fail at runtime, not at start.
  Do not add it from a generic hardening template.
- `WatchdogSec` is not set. dillad reports readiness and nothing more over the notify socket, so a
  watchdog would make systemd abort a healthy service.

Exit status 78 means `dilla.toml` is wrong; the unit does not restart on it
(`RestartPreventExitStatus=78`), so read `journalctl -u dilla`, fix the file and start it again.

### Proxmox

`deploy/proxmox-lxc.sh` does the systemd install above inside a new unprivileged Debian 13
container (nesting on, 2 GiB of memory, an 8 GiB disk). Run it as root on the Proxmox host, from a
directory that also holds `dilla.service`:

```sh
link=$(./proxmox-lxc.sh --domain chat.example.org --public-ip 203.0.113.10 --agree-tos)
```

stdout is the bootstrap invite link and nothing else; every progress line goes to stderr. It
downloads `dillad-linux-<arch>` and `dilla_core_wasi.wasm` from `--release-url`, or takes local
copies with `--binary` and `--core`. Forward 443/tcp and 7882/udp from the host to the container.
A NATed container does not hold the public IP either, so leave `turn.relay_ip = "auto"` as init
wrote it: the relay binds the container's own address.

## 4. Backup and restore

Backups hold no end-to-end-encrypted plaintext: they contain ciphertext, server-readable channel content, revealed report envelopes, TLS material and the instance keys.

That sentence is the whole threat model of the archive. It cannot be read as messages from
end-to-end-encrypted conversations, but it does hold everything that lets someone impersonate the
instance (the TLS material and the instance keys) and the content of every channel the server can
read. Store it like a private key.

```sh
# Take a backup, as the user that owns the data directory. It may run beside `dillad serve`.
sudo -u dillad dillad backup --config=/etc/dilla/dilla.toml --include-blobs --out=/srv/backups/dilla-$(date -u +%F).tar.gz

# Verify it without writing anything: the manifest and every member's size and SHA-256.
dillad backup verify --from=/srv/backups/dilla-2026-10-01.tar.gz

# Restore. Stop the service first: a restore refuses while a serve or a backup holds the directory.
sudo systemctl stop dilla
sudo -u dillad dillad restore --config=/etc/dilla/dilla.toml --from=/srv/backups/dilla-2026-10-01.tar.gz --dry-run
sudo -u dillad dillad restore --config=/etc/dilla/dilla.toml --from=/srv/backups/dilla-2026-10-01.tar.gz
sudo systemctl start dilla
```

`--include-blobs` is the default; `--include-blobs=false` leaves the attachment files out. A backup
with a missing blob file is refused unless `--allow-gaps` names the gaps in its manifest, and
`restore` refuses such an archive, or one from another instance, without `--force`.

Run `restore --dry-run` first, then without it. The dry run verifies the archive end to end and
prints what the restore would do, writing nothing. The real restore keeps the entries it replaces
in `<data_dir>/.old-<hex>` unless you pass `--remove-old`.

### The 24-hour heal window

A restored database is older than what the clients remember, so every group on it is
epoch-unknown. The restore ends every live call, purges unused KeyPackages, and bumps the
instance generation so each client notices and resyncs. A member then heals a group by uploading
its member-signed GroupInfo and handshake tail. The window for that is 24 hours from the next
`dillad serve` start: a group that has heard from no member by then is closed, and the channel
owner's device re-creates it. Start the instance promptly after a restore and expect clients to
show a resync notice while they catch up.

In Compose, run the same verbs with `docker compose run --rm dillad backup ...` or
`docker compose run --rm dillad restore ...` against the stopped service. Mount a directory for
`--out` and `--from`, and own it 65532:65532.
