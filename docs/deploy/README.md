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

### The `behind_proxy` TURN consequence

A TLS-terminating proxy cannot forward the TURN traffic that shares 443, so in `behind_proxy` mode
the relay has its own listener, `turn.listen`, and it is required while `turn.enabled` is true.
Either the operator publishes a second TCP port straight to dillad for TURN, or the UI shows the
explicit relay-unavailable dialog and the call is UDP-or-nothing. Decide this when you pick the
mode: a proxy in front of dillad is a convenient way to share 443 with other sites, and the price
is one more port to open, or calls that fail for people behind a UDP-blocking network.

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
