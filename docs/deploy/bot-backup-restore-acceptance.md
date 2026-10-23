# Dilla Bot backup and restore acceptance

This is a staging release gate for a coordinated, cold Dilla + Bot snapshot. Run it on a disposable
instance with no real community members or provider credentials. The server archive contains
instance keys and server-readable content; the Bot archive contains the runtime credential and the
key that decrypts its local database. Store both as secrets.

Local evidence is partial. These commands check the server restore lifecycle, Bot local state and
paused queue startup, and the server's stale-generation send refusal. They do not restore the server
and a Bot archive from one installation together.

- `go test ./cmd/dillad -run 'TestRestoreBumpsTheGenerationAndArmsTheHeal|TestServeAdmitsABackupRefusesARestoreAndFinishesOneAtStart' -count=1` checks the server restore generation and heal window.
- `go test ./cmd/dillabot -run 'TestColdBotArchiveRoundTripKeepsKeyAndSQLiteSidecarsDoctorReady|TestNewMusicSupervisorRestoresPersistedStateWithoutStartingAudio|TestRestoreMusicSupervisorsCreatesPausedVoiceQueuesOnly' -count=1` checks Bot archive files and paused queue startup.
- `go test ./internal/ds -run '^TestManagedBotSendAcceptReplayAndResolveAreDurable$' -count=1` directly invokes the delivery service's restore hook and checks that a stale-generation Bot message is refused without adding an application message.

The real local testhost path is `restore_heal_from_tail.scn`, run with `dilla-testhost` and
`dilla-testkit` on disposable data. It writes and restores the server archive through the host's
production backup/restore operations, then heals the group with an active member and verifies
messages flow in both directions. That scenario uses human test clients, not a managed Bot.

Run record, 2026-10-23: the testhost scenario passed on unique loopback ports `60527` and `51867`
with data under a disk-backed `TMPDIR`. The focused Go commands above passed (`cmd/dillabot`,
`internal/ds`, and `cmd/dillad`); `cargo test -p dilla-testkit --lib --locked` passed 95 tests.
The generated testhost invite stayed in the local process environment and was not included in the
record. The first Go attempt used `/tmp`, which was a full tmpfs; rerunning with disk-backed
`TMPDIR` succeeded.

The existing offline checks establish:

- The cold archive fixture round trip preserves `database.key`, `state.db`, and SQLite `-wal`, `-shm`, and
  `-journal` files byte for byte with mode `0600`; the restored state directory remains `0700` and
  `dillabot doctor` accepts it.
- Queue tests retain the current track as paused and do not resolve or start a provider; they use an in-memory native-state seam.
- The stale-send test refuses a Bot message request while the group is `epoch_unknown` and verifies no additional application message was stored. It calls `DS.OnRestore` directly; it does not submit from a restored Bot process.

The cold archive test uses opaque fixture bytes, not a production encrypted database or real
service account. The doctor checks local files and permissions; it does not contact dillad or prove
the installation is reconciled. The queue fixture does not create a queue in that archive.

## Staging procedure

Use an isolated staging host with `dilla` and `dillabot` installed and working. Set `ARCHIVE_DIR` to a
directory on separate backup storage. The test must stop both writers before taking either
archive so the two files describe one coordinated point in time.

```sh
ARCHIVE_DIR=/srv/backups/dilla-staging
sudo install -d -m 0700 -o dillad -g dillad "$ARCHIVE_DIR"
sudo systemctl stop dillabot
sudo systemctl stop dilla

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
server="$ARCHIVE_DIR/dilla-$stamp.tar.gz"
bot="$ARCHIVE_DIR/dillabot-$stamp.tar.gz"

sudo -u dillad dillad backup --config=/etc/dilla/dilla.toml --include-blobs --out="$server"
sudo dillad backup verify --from="$server"

# Check every installation's state files and key before archiving. This must
# print 0600 for database.key and each present state.db sidecar.
sudo find /var/lib/dillabot -mindepth 2 -maxdepth 2 -type f \
  \( -name database.key -o -name 'state.db*' \) -printf '%m %p\n' | sort
sudo sh -c 'umask 077; tar -C / -czf "$1" etc/dillabot var/lib/dillabot' sh "$bot"
sudo chmod 0600 "$server" "$bot"
sudo tar -tzf "$bot" | sort

# Start the restored baseline only after both snapshots have completed.
sudo systemctl start dilla
sudo systemctl start dillabot
```

Record the file listings and hashes (`sha256sum "$server" "$bot"`) in the staging change record.
Confirm the Bot listing includes each active installation's `database.key`, `state.db`, and any
present `state.db-wal`, `state.db-shm`, or `state.db-journal`, along with `/etc/dillabot/bot.toml`
and `runtime.token`. An absent sidecar is expected when SQLite has none; never synthesize one.

For the restore leg, stop both services again, preserve the live staging directories as rollback
copies, then restore the server archive first while both services remain stopped:

```sh
ARCHIVE_DIR=/srv/backups/dilla-staging
server="$(ls -1t "$ARCHIVE_DIR"/dilla-*.tar.gz | head -n 1)"
stamp="${server##*/dilla-}"
stamp="${stamp%.tar.gz}"
bot="$ARCHIVE_DIR/dillabot-$stamp.tar.gz"
test -s "$server" && test -s "$bot"

sudo systemctl stop dillabot
sudo systemctl stop dilla
sudo -u dillad dillad restore --config=/etc/dilla/dilla.toml --from="$server" --dry-run
sudo -u dillad dillad restore --config=/etc/dilla/dilla.toml --from="$server"
sudo tar --same-owner -C / -xzf "$bot"

# Check the restored DB key and state files before allowing the Bot to start.
sudo find /var/lib/dillabot -mindepth 2 -maxdepth 2 -type f \
  \( -name database.key -o -name 'state.db*' \) -printf '%m %p\n' | sort
sudo -u dillabot dillabot doctor --config=/etc/dillabot/bot.toml
sudo systemctl start dilla
```

Verify the server is healthy and its instance generation is newer than the one recorded before the
restore. Keep `dillabot` stopped while doing this. Then start it and inspect its journal:

```sh
since="$(date --iso-8601=seconds)"
sudo systemctl start dillabot
sudo journalctl -u dillabot --since "$since" --no-pager
```

Acceptance requires the restored installation to report `bot installation identity and membership
reconciled` with `ready=true` before operators permit Bot-triggered sends or playback. A
`ready=false`, degraded reconciliation, missing key, or doctor failure is a stop condition: stop
`dillabot`, keep the queue paused, and investigate. Do not manually resume a restored music queue
or provoke a Bot action while it is still reconciling. Keep at least one staging MLS group with
active members online so its restored epoch can heal; verify clients resync and the group becomes
usable before testing an outbound Bot action. No outbound action may be observed before that point.

## Evidence boundary

The local tests do not establish that a live host's paired server and Bot archives are atomic, that
a particular released schema restores successfully, or that a production Bot process restored from
that paired archive refrains from sending until the group's MLS state is reconciled. The testhost
scenario proves the server group can heal and then carry traffic, but it does not use the Bot's
restored MLS snapshot. There is currently no Bot action trigger in the local harness that submits an
outbound message from that restored snapshot. The paired staging procedure above has not been run;
keep this as an open release acceptance gate.
