#!/usr/bin/env bash
# Rootless integration tests for install-bot.sh. Host commands are stubbed and
# release assets come from a local file:// directory.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$HERE/install-bot.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STUBS="$TMP/stubs"
mkdir -p "$STUBS"
LOG="$TMP/calls.log"
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "ok   $*"; }
cat >"$STUBS/id" <<'STUB'
#!/bin/sh
if [ "$1" = -u ]; then echo 0; exit 0; fi
[ "${STUB_ACCOUNT_EXISTS:-}" = 1 ]
STUB
cat >"$STUBS/useradd" <<'STUB'
#!/bin/sh
echo "useradd $*" >>"$BOT_TEST_LOG"
STUB
cat >"$STUBS/install" <<'STUB'
#!/bin/sh
echo "install $*" >>"$BOT_TEST_LOG"
args=""
while [ "$#" -gt 0 ]; do
	case "$1" in
	-o | -g) shift 2 ;;
	*) args="$args '$1'"; shift ;;
esac
done
eval exec /usr/bin/install $args
STUB
cat >"$STUBS/chown" <<'STUB'
#!/bin/sh
echo "chown $*" >>"$BOT_TEST_LOG"
STUB
cat >"$STUBS/runuser" <<'STUB'
echo "runuser $*" >>"$BOT_TEST_LOG"
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
shift
case "$1" in
*/dillabot) shift; exec "$FAKE_BOT" "$@" ;;
*) exec "$@" ;;
esac
STUB
cat >"$STUBS/systemctl" <<'STUB'
echo "systemctl $*" >>"$BOT_TEST_LOG"
if [ "$1" = start ] && [ -n "${BOT_TEST_FAIL_START_FIRST:-}" ]; then
	n=0; [ ! -f "$BOT_TEST_START_COUNT" ] || n="$(cat "$BOT_TEST_START_COUNT")"
	n=$((n + 1)); echo "$n" >"$BOT_TEST_START_COUNT"
	[ "$n" -gt 1 ] || exit 1
fi
if [ "$1" = is-active ]; then [ "${BOT_TEST_ACTIVE:-1}" = 1 ]; fi
STUB
cat >"$STUBS/dillad" <<'STUB'
#!/bin/sh
echo "dillad $*" >>"$BOT_TEST_LOG"
[ "$1" = admin ] && [ "$2" = bot-runtime ] && [ "$3" = create ] || exit 2
for arg in "$@"; do case "$arg" in --out=*) out="${arg#*=}" ;; esac; done
printf 'dbr_c29tZS1sb25nLXJhbmRvbS10ZXN0LXZhbHVl\n' >"$out"
echo 'created bot runtime 01010101010101010101010101010101; secret written to protected file'
STUB
cat >"$STUBS/fake-bot" <<'STUB'
#!/bin/sh
[ "$1" = doctor ] || exit 2
if [ -n "${BOT_TEST_DOCTOR_FAIL_AFTER_FIRST:-}" ]; then
	n=0; [ ! -f "$BOT_TEST_DOCTOR_COUNT" ] || n="$(cat "$BOT_TEST_DOCTOR_COUNT")"
	n=$((n + 1)); echo "$n" >"$BOT_TEST_DOCTOR_COUNT"
	[ "$n" -lt 2 ] || exit 1
fi
echo 'runtime_credential OK'
echo 'native_helper OK'
echo 'wasi_identity_module OK'
echo 'state_directory OK'
STUB
chmod +x "$STUBS"/*

ROOT="$TMP/root"
mkdir -p "$ROOT/etc/dilla" "$ROOT/usr/local/bin" "$ROOT/etc/ssl/certs"
chmod 0750 "$ROOT/etc/dilla"
printf 'server config\n' >"$ROOT/etc/dilla/dilla.toml"
cp "$STUBS/dillad" "$ROOT/usr/local/bin/dillad"
chmod +x "$ROOT/usr/local/bin/dillad"
FAKE_BOT="$STUBS/fake-bot"
export FAKE_BOT
REL="$TMP/release"
mkdir -p "$REL"
printf 'bot-binary\n' >"$REL/dillabot-linux-amd64"
printf 'native-helper\n' >"$REL/dilla-bot-core-linux-amd64"
printf 'module\n' >"$REL/dilla_core_wasi.wasm"
(cd "$REL" && sha256sum dillabot-linux-amd64 dilla-bot-core-linux-amd64 dilla_core_wasi.wasm >SHA256SUMS)

BASE="--base-url=https://chat.example.org --instance-id=01010101010101010101010101010101 --dillad-config=$ROOT/etc/dilla/dilla.toml --release-url=file://$REL"
# shellcheck disable=SC2086
if PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" BOT_TEST_LOG="$LOG" "$INSTALL" $BASE --check-args >"$TMP/out" 2>"$TMP/err"; then
	[ ! -s "$LOG" ] || fail "--check-args ran a host command"
	[ ! -e "$ROOT/etc/systemd/system/dillabot.service" ] || fail "--check-args wrote files"
	pass "--check-args validates without host changes"
else fail "--check-args rejected valid arguments: $(cat "$TMP/err")"; fi

reject_args() { # NAME ARGUMENTS...
	name="$1"; shift
	if PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" BOT_TEST_LOG="$LOG" "$INSTALL" "$@" --check-args >"$TMP/out" 2>"$TMP/err"; then
		fail "$name was accepted"
	fi
	[ ! -s "$LOG" ] || fail "$name ran a host command"
	pass "$name is refused before host changes"
}
# The origin is constrained to an HTTPS authority and the id must be a nonzero
# canonical 16-byte hex string so neither value can corrupt generated TOML.
# shellcheck disable=SC2086
reject_args "an instance ID of all zeroes" $BASE --instance-id=00000000000000000000000000000000
# shellcheck disable=SC2086
reject_args "a server URL with a path" $BASE --base-url=https://chat.example.org/v1
# shellcheck disable=SC2086
reject_args "a nonnumeric server URL port" $BASE --base-url=https://chat.example.org:admin
# Full local assets are accepted with checksums without requiring a release tag.
# shellcheck disable=SC2086
if PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" BOT_TEST_LOG="$LOG" "$INSTALL" $BASE --binary="$REL/dillabot-linux-amd64" --helper="$REL/dilla-bot-core-linux-amd64" --module="$REL/dilla_core_wasi.wasm" --sums="$REL/SHA256SUMS" --check-args >"$TMP/out" 2>"$TMP/err"; then
	pass "local assets with SHA256SUMS need no release tag"
else fail "local assets with checksums were rejected: $(cat "$TMP/err")"; fi
# shellcheck disable=SC2086
reject_args "local assets without checksums" $BASE --binary="$REL/dillabot-linux-amd64" --helper="$REL/dilla-bot-core-linux-amd64" --module="$REL/dilla_core_wasi.wasm"

# shellcheck disable=SC2086
if PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" BOT_TEST_LOG="$LOG" "$INSTALL" $BASE >"$TMP/out" 2>"$TMP/err"; then :; else fail "guided install failed: $(cat "$TMP/err")"; fi
[ -x "$ROOT/usr/local/bin/dillabot" ] || fail "dillabot binary missing"
[ -x "$ROOT/usr/local/libexec/dilla-bot-core" ] || fail "native helper missing"
[ -s "$ROOT/usr/local/lib/dilla/dilla_core_wasi.wasm" ] || fail "WASI module missing"
[ "$(stat -c %a "$ROOT/etc/dillabot/runtime.token")" = 600 ] || fail "runtime credential mode is not 0600"
[ "$(stat -c %a "$ROOT/etc/dillabot")" = 750 ] || fail "Bot config directory mode is not 0750"
[ "$(stat -c %a "$ROOT/etc/dillabot/bot.toml")" = 640 ] || fail "bot config mode is not 0640"
[ "$(stat -c %a "$ROOT/var/lib/dillabot")" = 700 ] || fail "state directory mode is not 0700"
[ "$(stat -c %a "$ROOT/etc/dilla")" = 750 ] || fail "server config directory mode was changed"
grep -q 'install -m 0600 -o dillabot -g dillabot .*runtime.token' "$LOG" || fail "runtime credential ownership flags are wrong"
grep -q 'install -m 0640 -o root -g dillabot .*bot.toml' "$LOG" || fail "Bot config ownership flags are wrong"
grep -q 'useradd --system --user-group --no-create-home --home-dir /var/lib/dillabot --shell /usr/sbin/nologin dillabot' "$LOG" || fail "dedicated service user was not created"
[ "$(cat "$ROOT/etc/dillabot/bot.toml")" = "$(cat <<CONFIG
base_url = "https://chat.example.org"
instance_id = "01010101010101010101010101010101"
runtime_credential_file = "$ROOT/etc/dillabot/runtime.token"
helper_executable = "/usr/local/libexec/dilla-bot-core"
wasi_module = "/usr/local/lib/dilla/dilla_core_wasi.wasm"
state_dir = "/var/lib/dillabot"
reconcile_interval = "30s"
CONFIG
)" ] || fail "Bot config content differs from expected"
cmp -s "$HERE/dillabot.service" "$ROOT/etc/systemd/system/dillabot.service" || fail "installed systemd unit differs from deploy/dillabot.service"
grep -q '^DevicePolicy=closed$' "$ROOT/etc/systemd/system/dillabot.service" || fail "Bot unit does not restrict device access"
if grep -Eq '^(PrivateDevices|RestrictSUIDSGID)=yes$' "$ROOT/etc/systemd/system/dillabot.service"; then fail "Bot unit blocks the nested YouTube sandbox"; fi
grep -q '^dillad admin bot-runtime create --config=' "$LOG" || fail "runtime credential was not created via dillad admin"
grep -q '^systemctl enable --now dillabot$' "$LOG" || fail "service was not enabled"
if grep -q 'dbr_' "$LOG" "$TMP/err" "$TMP/out"; then fail "runtime credential leaked to output"; fi
pass "guided install verifies assets, protects files, creates runtime credential and enables unit"

# Upgrade uses a fresh release but leaves credentials, config and encrypted state untouched.
mkdir -m 0700 "$ROOT/var/lib/dillabot/install-sentinel"
printf 'encrypted-state-marker\n' >"$ROOT/var/lib/dillabot/install-sentinel/keep"
chmod 0600 "$ROOT/var/lib/dillabot/install-sentinel/keep"
CONFIG_BEFORE="$(sha256sum "$ROOT/etc/dillabot/bot.toml")"
CREDENTIAL_BEFORE="$(sha256sum "$ROOT/etc/dillabot/runtime.token")"
STATE_BEFORE="$(sha256sum "$ROOT/var/lib/dillabot/install-sentinel/keep")"
REL2="$TMP/release2"
mkdir -p "$REL2"
printf 'bot-binary-v2\n' >"$REL2/dillabot-linux-amd64"
printf 'native-helper-v2\n' >"$REL2/dilla-bot-core-linux-amd64"
printf 'module-v2\n' >"$REL2/dilla_core_wasi.wasm"
(cd "$REL2" && sha256sum dillabot-linux-amd64 dilla-bot-core-linux-amd64 dilla_core_wasi.wasm >SHA256SUMS)
if PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" BOT_TEST_LOG="$LOG" BOT_TEST_DATE_COUNT="$TMP/date-count" STUB_ACCOUNT_EXISTS=1 "$INSTALL" --upgrade --release-url="file://$REL2" >"$TMP/out" 2>"$TMP/err"; then :; else fail "Bot upgrade failed: $(cat "$TMP/err")"; fi
[ "$(cat "$ROOT/usr/local/bin/dillabot")" = bot-binary-v2 ] || fail "upgrade did not replace dillabot"
[ "$(sha256sum "$ROOT/etc/dillabot/bot.toml")" = "$CONFIG_BEFORE" ] || fail "upgrade changed bot.toml"
[ "$(sha256sum "$ROOT/etc/dillabot/runtime.token")" = "$CREDENTIAL_BEFORE" ] || fail "upgrade changed runtime credential"
[ "$(sha256sum "$ROOT/var/lib/dillabot/install-sentinel/keep")" = "$STATE_BEFORE" ] || fail "upgrade changed Bot state"
BACKUPS=("$ROOT"/var/backups/dillabot/*)
[ "${#BACKUPS[@]}" -eq 1 ] || fail "upgrade did not retain one pre-upgrade backup"
[ -s "${BACKUPS[0]}/state/install-sentinel/keep" ] || fail "pre-upgrade backup omitted Bot state"
[ "$(stat -c %a "${BACKUPS[0]}")" = 700 ] || fail "pre-upgrade backup directory is not private"
grep -q '^systemctl start dillabot$' "$LOG" || fail "active service was not restarted after upgrade"
[ "$(grep -c '^dillad admin bot-runtime create ' "$LOG")" = 1 ] || fail "upgrade unexpectedly created another runtime credential"
pass "upgrade preserves config, credential and state with a root-only rollback copy"

# A failed upgraded doctor restores old binaries and state, then restarts the prior service.
REL3="$TMP/release3"
mkdir -p "$REL3"
printf 'bot-binary-v3\n' >"$REL3/dillabot-linux-amd64"
printf 'native-helper-v3\n' >"$REL3/dilla-bot-core-linux-amd64"
printf 'module-v3\n' >"$REL3/dilla_core_wasi.wasm"
(cd "$REL3" && sha256sum dillabot-linux-amd64 dilla-bot-core-linux-amd64 dilla_core_wasi.wasm >SHA256SUMS)
if PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" BOT_TEST_LOG="$LOG" BOT_TEST_DATE_COUNT="$TMP/date-count" BOT_TEST_DOCTOR_COUNT="$TMP/doctor-count" BOT_TEST_DOCTOR_FAIL_AFTER_FIRST=1 STUB_ACCOUNT_EXISTS=1 "$INSTALL" --upgrade --release-url="file://$REL3" >"$TMP/out" 2>"$TMP/err"; then fail "upgrade with failed doctor succeeded"; fi
[ "$(cat "$ROOT/usr/local/bin/dillabot")" = bot-binary-v2 ] || fail "failed upgrade did not restore previous binary"
[ "$(cat "$ROOT/usr/local/libexec/dilla-bot-core")" = native-helper-v2 ] || fail "failed upgrade did not restore previous helper"
[ "$(cat "$ROOT/usr/local/lib/dilla/dilla_core_wasi.wasm")" = module-v2 ] || fail "failed upgrade did not restore previous WASI module"
cmp -s "$HERE/dillabot.service" "$ROOT/etc/systemd/system/dillabot.service" || fail "failed upgrade did not restore previous unit"
[ "$(cat "$ROOT/var/lib/dillabot/install-sentinel/keep")" = encrypted-state-marker ] || fail "failed upgrade did not restore Bot state"
grep -q 'restored the previous files and state' "$TMP/err" || fail "failed upgrade did not report rollback: $(cat "$TMP/err")"
pass "doctor failure rolls back Bot binaries and local state"

# A service start failure also restores the old files before starting the prior service.
REL4="$TMP/release4"
mkdir -p "$REL4"
printf 'bot-binary-v4\n' >"$REL4/dillabot-linux-amd64"
printf 'native-helper-v4\n' >"$REL4/dilla-bot-core-linux-amd64"
printf 'module-v4\n' >"$REL4/dilla_core_wasi.wasm"
(cd "$REL4" && sha256sum dillabot-linux-amd64 dilla-bot-core-linux-amd64 dilla_core_wasi.wasm >SHA256SUMS)
if PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" BOT_TEST_LOG="$LOG" BOT_TEST_DATE_COUNT="$TMP/date-count" BOT_TEST_START_COUNT="$TMP/start-count" BOT_TEST_FAIL_START_FIRST=1 STUB_ACCOUNT_EXISTS=1 "$INSTALL" --upgrade --release-url="file://$REL4" >"$TMP/out" 2>"$TMP/err"; then fail "upgrade with failed service start succeeded"; fi
[ "$(cat "$ROOT/usr/local/bin/dillabot")" = bot-binary-v2 ] || fail "start failure did not restore previous binary"
[ "$(cat "$ROOT/var/lib/dillabot/install-sentinel/keep")" = encrypted-state-marker ] || fail "start failure did not restore Bot state"
grep -q 'upgraded Bot service did not remain active' "$TMP/err" || fail "start failure did not report rollback"
[ "$(cat "$TMP/start-count")" = 2 ] || fail "old service was not started after rollback"
pass "service start failure rolls back Bot files and state"

# A second guided first-install run must preserve the existing secret/state and refuse.
BEFORE="$(sha256sum "$ROOT/etc/dillabot/runtime.token")"
# shellcheck disable=SC2086
if PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" BOT_TEST_LOG="$LOG" "$INSTALL" $BASE >"$TMP/out" 2>"$TMP/err"; then fail "rerun replaced an existing bot install"; fi
[ "$(sha256sum "$ROOT/etc/dillabot/runtime.token")" = "$BEFORE" ] || fail "refused rerun changed credential"
grep -q 'files or state already exist' "$TMP/err" || fail "rerun refusal was not explained"
pass "rerun refuses without replacing Bot credential"

# A tampered release artifact is rejected before account, state or service changes.
BAD="$TMP/bad-release"
cp -a "$REL" "$BAD"
printf 'tamper' >>"$BAD/dillabot-linux-amd64"
BADROOT="$TMP/bad-root"
mkdir -p "$BADROOT/etc/dilla" "$BADROOT/usr/local/bin"
printf 'server config\n' >"$BADROOT/etc/dilla/dilla.toml"
cp "$ROOT/usr/local/bin/dillad" "$BADROOT/usr/local/bin/dillad"
# shellcheck disable=SC2086
if PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$BADROOT" BOT_TEST_LOG="$LOG" "$INSTALL" --base-url=https://chat.example.org --instance-id=01010101010101010101010101010101 --dillad-config="$BADROOT/etc/dilla/dilla.toml" --release-url="file://$BAD" >"$TMP/out" 2>"$TMP/err"; then fail "tampered asset was installed"; fi
[ ! -e "$BADROOT/usr/local/bin/dillabot" ] || fail "checksum failure installed binary"
[ ! -e "$BADROOT/etc/systemd/system/dillabot.service" ] || fail "checksum failure installed service"
grep -q 'checksum mismatch' "$TMP/err" || fail "checksum failure was not reported"
pass "checksum failure changes no service files"
