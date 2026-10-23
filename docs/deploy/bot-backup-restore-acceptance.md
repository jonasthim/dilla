# Dilla Bot backup and restore acceptance

This is a staging release gate for a coordinated, cold Dilla + Bot snapshot. Run it on a disposable
instance with no real community members or provider credentials. The server archive contains
instance keys and server-readable content; the Bot archive contains the runtime credential and the
key that decrypts its local database. Store both as secrets.

The offline Bot archive and queue evidence is `go test ./cmd/dillabot -run 'TestColdBotArchiveRoundTripKeepsKeyAndSQLiteSidecarsDoctorReady|TestNewMusicSupervisorRestoresPersistedStateWithoutStartingAudio|TestRestoreMusicSupervisorsCreatesPausedVoiceQueuesOnly' -count=1`. Server-side stale-snapshot send refusal is covered by `go test ./internal/ds -run '^TestManagedBotSendAcceptReplayAndResolveAreDurable$' -count=1`:

- The cold archive round trip preserves `database.key`, `state.db`, and SQLite `-wal`, `-shm`, and
  `-journal` files byte for byte with mode `0600`; the restored state directory remains `0700` and
  `dillabot doctor` accepts it.
- Queue restoration retains the current track as paused and does not resolve or start a provider.
- A managed Bot message encrypted at the restored epoch is refused while the group remains
  `epoch_unknown`; the fixture verifies no additional application message was stored.

The round-trip test uses opaque fixture bytes, not a production encrypted database or real service
account. The doctor checks local files and permissions; it does not contact dillad or prove the
installation is reconciled.

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

The offline fixture tests and this procedure do not establish that a live host's paired server and
Bot archives are atomic, that a particular released schema restores successfully, or that a
particular production Bot archive contains the stale MLS snapshot represented by the fixture. The
live staging procedure above has not yet been run. Those remain release acceptance gaps; do not
describe them as verified until the staging evidence is recorded.
