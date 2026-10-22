#!/usr/bin/env bash
# Tests for deploy/install.sh, with no network, no systemd and no root.
#
# install.sh runs against a temporary root (DILLA_INSTALL_ROOT), downloads from a
# file:// "release", and finds stubs first on PATH for everything that would
# touch the host: id, uname, getent, useradd, chown, systemctl, runuser and
# apt-get. The dillad it installs is a fake that writes the dilla.toml layout
# the real `dillad init` writes (the [instance], [server], [tls], [turn] and
# [livekit] tables) and prints a doctor report the test chooses.
#
# With DILLA_TEST_DILLAD=/path/to/dillad, the two happy-path installs run the
# real binary's init instead, and the edited file must pass the real config
# leg of `dillad doctor` (strict decoding plus Validate).
#
# Usage: bash deploy/install_test.sh   (exit 0 when every case passes)
#
# SC2016: the stub bodies are written single-quoted on purpose, to expand when the stub runs.
# SC2086, SC2089, SC2090: argument lists and "|"-joined problem lists are split on purpose.
# shellcheck disable=SC2016,SC2086,SC2089,SC2090
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$HERE/install.sh"
UNIT="$HERE/dilla.service"
MEDIA_UNIT="$HERE/dilla-media.service"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASSED=0
FAILED=0

pass() {
	PASSED=$((PASSED + 1))
	printf 'ok   %s\n' "$1"
}
fail() {
	FAILED=$((FAILED + 1))
	printf 'FAIL %s\n' "$1"
	shift
	for line in "$@"; do printf '     %s\n' "$line"; done
}

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || {
	echo "install_test: neither curl nor wget is installed; the file:// release cannot be fetched" >&2
	exit 1
}

# ---------------------------------------------------------------- stubs ----
STUBS="$TMP/stubs"
mkdir -p "$STUBS"
LOG="$TMP/calls.log"
stub() {
	printf '#!/bin/sh\n%s\n' "$2" >"$STUBS/$1"
	chmod 0755 "$STUBS/$1"
}
stub id 'if [ "$#" -eq 1 ] && [ "$1" = "-u" ]; then echo "${STUB_UID:-0}"; exit 0; fi; exit 1'
stub uname 'if [ "$1" = "-m" ]; then echo "${STUB_ARCH:-x86_64}"; else echo Linux; fi'
stub getent 'echo "getent $*" >>"'"$LOG"'"; exit 2'
stub useradd 'echo "useradd $*" >>"'"$LOG"'"'
stub chown 'echo "chown $*" >>"'"$LOG"'"'
stub apt-get 'echo "apt-get $*" >>"'"$LOG"'"'
stub sleep 'exit 0'
# systemctl models the two services in $DILLA_INSTALL_ROOT/stub: dilla-media's MainPID, a
# $ROOT/proc/<pid>/exe that is a hard link to the binary it started from (so it keeps that inode
# when install.sh renames a new file over /usr/local/bin/dillad, as /proc/<pid>/exe does), the
# media.json a web3.12+ `dillad media` writes before READY, and which process holds turn.listen.
cat >"$STUBS/systemctl" <<STUB
#!/bin/sh
echo "systemctl \$*" >>"$LOG"
STUB
cat >>"$STUBS/systemctl" <<'STUB'
[ "${STUB_SYSTEMCTL_FAIL:-}" != 1 ] || exit 1
# dillad media writes media.json at 0600.
umask 077
R="${DILLA_INSTALL_ROOT:-}"
S="$R/stub"
mkdir -p "$S"
BIN="$R/usr/local/bin/dillad"
DATA="$R/var/lib/dillad"
CONF="$R/etc/dilla/dilla.toml"
hdr() { sed -n "s/^# fake-$1 //p" "$2" 2>/dev/null | head -n 1; }
level() { l="$(hdr level "$1")"; echo "${l:-0}"; }
is_v2() { grep -q "^# fake dillad v2 for" "$1"; }
turn_conf() {
	awk '/^\[/ { inside = ($0 == "[turn]") } inside && /^  enabled = true$/ { e = 1 } inside && /^  listen = .[^\047]/ { l = 1 } END { exit !(e && l) }' "$CONF" 2>/dev/null
}
media_pid() { cat "$S/media.pid" 2>/dev/null || echo 0; }
media_active() { [ "$(media_pid)" -gt 0 ]; }
media_json_current() { [ -f "$DATA/media.json" ] && grep -q "\"pid\":$(media_pid)," "$DATA/media.json"; }
# The running media process binds turn.listen once nobody else holds it.
media_takes_turn() {
	media_active && media_json_current && [ ! -e "$S/api.turn" ] && turn_conf || return 0
	[ "$(hdr caps "$R/proc/$(media_pid)/exe")" = '"turn"' ] || return 0
	sed -i 's/"capabilities":\[\]/"capabilities":["turn"]/' "$DATA/media.json"
	[ ! -f "$S/media.self" ] || sed -i 's/"capabilities":\[\]/"capabilities":["turn"]/' "$S/media.self"
	return 0
}
# media_start: STUB_MEDIA_RUNS names the binary the new process runs instead of the installed one
# (a restart that leaves the old SFU in place). A web3.12+ process writes media.json and answers
# GET /media/self on media.sock, which $S/media.self stands for.
media_start() {
	media_active && return 0
	n=$(($(cat "$S/pidseq" 2>/dev/null || echo 4000) + 1))
	echo "$n" >"$S/pidseq"
	# FAKE_MEDIA_PROBE_FAIL or STUB_MEDIA_START_FAIL: the SFU never becomes ready. A release that
	# refuses dilla.toml (FAKE_V2_CONFIG_FAIL) exits 78 at once.
	if [ -n "${FAKE_MEDIA_PROBE_FAIL:-}${STUB_MEDIA_START_FAIL:-}" ] || { [ -n "${FAKE_V2_CONFIG_FAIL:-}" ] && is_v2 "$BIN"; }; then
		return 1
	fi
	runs="${STUB_MEDIA_RUNS:-$BIN}"
	mkdir -p "$R/proc/$n"
	ln -f "$runs" "$R/proc/$n/exe" 2>/dev/null || cp "$runs" "$R/proc/$n/exe"
	echo "$n" >"$S/media.pid"
	if [ "$(level "$runs")" -ge 2 ]; then
		rm -f "$DATA/media.json"
		printf '{"version":"%s","media_level":%s,"capabilities":[],"pid":%s,"started":"2026-10-22T08:00:00Z"}\n' \
			"$(hdr version "$runs")" "$(level "$runs")" "$n" >"$DATA/media.json"
		cp "$DATA/media.json" "$S/media.self"
		media_takes_turn
		# STUB_MEDIA_JSON_FIFO: a compromised dillad leaves a FIFO where media.json belongs.
		if [ -n "${STUB_MEDIA_JSON_FIFO:-}" ]; then
			rm -f "$DATA/media.json"
			mkfifo "$DATA/media.json"
		fi
	fi
}
media_stop() {
	p="$(media_pid)"
	rm -f "$S/media.pid" "$S/media.self"
	[ "$p" -gt 0 ] || return 0
	rm -rf "${R:?}/proc/$p"
	# A clean stop removes its own media.json.
	if [ -f "$DATA/media.json" ] && grep -q "\"pid\":$p," "$DATA/media.json" 2>/dev/null; then rm -f "$DATA/media.json"; fi
}
# api_start VERB: models dillad serve. With FAKE_SCHEMA (a file holding the database schema
# version) the new release (fake v2) migrates to STUB_RESTART_MIGRATES_TO at start and then fails
# when STUB_FAIL_V2 is set; the old one (v1, highest migration 16) refuses a newer schema. With
# FAKE_V2_CONFIG_FAIL, v2 refuses the config before it migrates anything. STUB_SYSTEMCTL_FAIL=restart
# fails `systemctl restart dilla`; STUB_API_RETRY_OK fails the first one but systemd's own
# Restart=on-failure brings dilla up (serve exited 69).
api_start() {
	ok=1
	if [ "${STUB_SYSTEMCTL_FAIL:-}" = restart ] && [ "$1" = restart ]; then ok=0; fi
	if [ -n "${FAKE_V2_CONFIG_FAIL:-}" ] && is_v2 "$BIN"; then ok=0; fi
	if [ "$ok" -eq 1 ] && [ -n "${FAKE_SCHEMA:-}" ]; then
		if is_v2 "$BIN"; then
			[ -z "${STUB_RESTART_MIGRATES_TO:-}" ] || echo "$STUB_RESTART_MIGRATES_TO" >"$FAKE_SCHEMA"
			[ -z "${STUB_FAIL_V2:-}" ] || ok=0
		elif [ "$(cat "$FAKE_SCHEMA")" -gt 16 ]; then
			echo "serve: database schema $(cat "$FAKE_SCHEMA") is newer than this binary's highest migration 16: refusing to start" >&2
			ok=0
		fi
	fi
	if [ -n "${STUB_API_RETRY_OK:-}" ] && [ ! -e "$S/api.retried" ]; then
		touch "$S/api.retried"
		echo active >"$S/dilla.state"
		return 1
	fi
	if [ "$ok" -eq 0 ]; then
		echo failed >"$S/dilla.state"
		return 1
	fi
	echo active >"$S/dilla.state"
	# Who binds turn.listen (R-UP11): serve leaves it to a dilla-media whose valid media.json is of
	# a level that serves TURN; otherwise serve binds it.
	rm -f "$S/api.turn"
	if turn_conf; then
		if [ "$(level "$BIN")" -ge 2 ] && media_json_current && grep -q '"media_level":[2-9]' "$DATA/media.json" &&
			[ "$(hdr caps "$R/proc/$(media_pid)/exe")" = '"turn"' ]; then
			media_takes_turn
		else
			touch "$S/api.turn"
		fi
	fi
}
# STUB_MEDIA_INACTIVE: dilla-media was stopped before this install.sh run (run clears the marker).
if [ -n "${STUB_MEDIA_INACTIVE:-}" ] && [ ! -e "$S/inactive.done" ]; then
	touch "$S/inactive.done"
	media_stop
fi
verb="$1"
shift
case "$verb" in
show) if media_active; then media_pid; else echo 0; fi ;;
is-active)
	[ "${1:-}" != --quiet ] || shift
	case "$1" in
	dilla-media) media_active ;;
	dilla) [ "$(cat "$S/dilla.state" 2>/dev/null || echo active)" = active ] ;;
	esac
	;;
start | restart | stop | enable | disable)
	now=0
	if [ "${1:-}" = --now ]; then
		now=1
		shift
	fi
	rc=0
	for unit in "$@"; do
		case "$verb:$now:$unit" in
		start:*:dilla-media | enable:1:dilla-media) media_start || rc=1 ;;
		restart:*:dilla-media)
			media_stop
			media_start || rc=1
			;;
		stop:*:dilla-media | disable:1:dilla-media) media_stop ;;
		start:*:dilla | enable:1:dilla)
			if [ "$(cat "$S/dilla.state" 2>/dev/null)" != active ]; then api_start start || rc=1; fi
			;;
		restart:*:dilla) api_start restart || rc=1 ;;
		stop:*:dilla | disable:1:dilla)
			echo inactive >"$S/dilla.state"
			rm -f "$S/api.turn"
			media_takes_turn
			;;
		esac
	done
	exit "$rc"
	;;
esac
exit $?
STUB
chmod 0755 "$STUBS/systemctl"
# runuser -u dillad -- cmd args: run cmd args.
stub runuser 'echo "runuser $*" >>"'"$LOG"'"; while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift
# The real-binary config test has no media process: simulate only its readiness probe.
if [ -n "${STUB_MEDIA_PROBE_SUCCESS:-}" ] && [ "${2:-}" = media ] && [ "${3:-}" = --probe ]; then exit 0; fi
exec "$@"'

# The fake dillad. $1 is the verb.
FAKE="$TMP/fake-dillad"
cat >"$FAKE" <<'FAKE'
#!/bin/sh
# fake dillad for deploy/install_test.sh
# What this fake is (make_fake rewrites these lines): its version, its media level (0 for a
# web3.11 or older dillad, which knows no `version --json` and no `media --idle`), the oldest SFU
# level it works with, and its media capabilities as JSON array items.
# fake-version 0.1.0-web3.11
# fake-level 0
# fake-min 0
# fake-caps none
echo "dillad $*" >>"${FAKE_LOG:?}"
hdr() { sed -n "s/^# fake-$1 //p" "$0" | head -n 1; }
verb="$1"
shift
# A newer release that refuses the installed dilla.toml refuses it in every verb that loads it.
if [ "$verb" != version ] && [ -n "${FAKE_V2_CONFIG_FAIL:-}" ] && grep -q "^# fake dillad v2 for" "$0"; then
	echo "config: auth.methods must include totp or passkey" >&2
	exit 78
fi
case "$verb" in
init)
	for a in "$@"; do
		case "$a" in
		--config=*) cfg="${a#*=}" ;;
		--data-dir=*) dir="${a#*=}" ;;
		--domain=*) domain="${a#*=}" ;;
		--public-ip=*) ip="${a#*=}" ;;
		esac
	done
	# Like the real one: the config goes to --config, an existing one is refused, and every file
	# is created under umask 077 (the real dillad sets it itself).
	[ -n "$cfg" ] || { echo "init: --config is required" >&2; exit 2; }
	[ -e "$cfg" ] && { echo "init: $cfg already exists; pass --overwrite-config to replace it" >&2; exit 73; }
	umask 077
	mkdir -p "$dir"
	chmod 0700 "$dir"
	: >"$dir/dilla.db"
	mkdir "$dir/blobs"
	printf 'secret-turn-0123456789abcdef0123456789abcdef' >"$dir/turn.secret"
	printf 'secret-livekit-0123456789abcdef0123456789ab' >"$dir/livekit.secret"
	chmod 0600 "$dir/turn.secret" "$dir/livekit.secret"
	cat >"$cfg" <<EOF
# dilla.toml — dillad instance configuration.

[instance]
  # REQUIRED. Public DNS name this instance answers on.
  domain = '$domain'
  # REQUIRED unless tls.mode = "behind_proxy". IPv4/IPv6 literal.
  public_ip = '$ip'
  # State root. systemd StateDirectory=dilla.
  data_dir = '$dir'
  discovery = 'public'

[server]
  listen = ':443'
  plain_listen = '127.0.0.1:8080'
  trusted_proxy_cidrs = []
  read_header_timeout = '10s'

[tls]
  mode = 'acme_tls_alpn'
  email = ''
  agreed = true

  [tls.dns]
    provider = ''
    resolvers = []

[turn]
  enabled = true
  listen = ''
  realm = '$domain'
  shared_secret_file = '$dir/turn.secret'
  relay_ip = 'auto'

[livekit]
  enabled = true
  mode = 'in_process'
  udp_port = 7882
  tcp_port = 0
  node_ip = '$ip'
  api_secret_file = '$dir/livekit.secret'
EOF
	chmod 0600 "$cfg"
	if [ -n "${FAKE_INIT_BAD:-}" ]; then
		# A layout install.sh does not know: no livekit.udp_port.
		grep -v 'udp_port' "$cfg" >"$cfg.x"
		cat "$cfg.x" >"$cfg"
		rm -f "$cfg.x"
	fi
	echo "dillad init: wrote $cfg"
	echo "bootstrap invite (valid 24 hours, one use): https://$domain/i/SECRETINVITECODE"
	echo "this link is printed once and is not stored anywhere; the database holds only its SHA-256"
	;;
doctor)
	if [ -n "${FAKE_DOCTOR:-}" ]; then
		cat "$FAKE_DOCTOR"
	else
		printf 'OK    config       parsed and validated\nOK    wasi         abi_version=9\nWARN  udp          not probed\n'
	fi
	exit "${FAKE_DOCTOR_EXIT:-0}"
	;;
media)
	case "$1" in
	--probe)
		[ -z "${FAKE_MEDIA_PROBE_FAIL:-}" ] || exit 69
		;;
	--rooms)
		# FAKE_ROOMS_FAIL: the sidecar cannot be reached. FAKE_ROOMS: a file holding what the
		# real command prints for live rooms (default "no live rooms").
		[ -z "${FAKE_ROOMS_FAIL:-}" ] || { echo "media rooms: sidecar unreachable" >&2; exit 69; }
		if [ -n "${FAKE_ROOMS:-}" ]; then cat "$FAKE_ROOMS"; else echo "no live rooms"; fi
		;;
	--idle)
		# FAKE_IDLE: the exit status (0 idle, 1 busy, 69 cannot tell). web3.11 has no --idle.
		[ "$(hdr level)" -ge 2 ] || { echo "flag provided but not defined: -idle" >&2; exit 64; }
		exit "${FAKE_IDLE:-0}"
		;;
	--self)
		# What the RUNNING media process answers on media.sock (the stub's media.self), not this
		# binary's own idea. FAKE_SELF_DOWN: nothing answers; FAKE_SELF_BAD: a hostile answer.
		[ "$(hdr level)" -ge 2 ] || { echo "flag provided but not defined: -self" >&2; exit 64; }
		[ -z "${FAKE_SELF_DOWN:-}" ] || exit 69
		if [ -n "${FAKE_SELF_BAD:-}" ]; then
			printf '{"version":"0.1.0-web3.13;touch /pwned","media_level":"9","capabilities":["$(id)"],"pid":%s}\n' "$(cat "${DILLA_INSTALL_ROOT:-}/stub/media.pid" 2>/dev/null)"
			exit 0
		fi
		cat "${DILLA_INSTALL_ROOT:-}/stub/media.self" 2>/dev/null || exit 69
		;;
	*) exit 64 ;;
	esac
	;;
version)
	if [ "${1:-}" = --json ]; then
		[ "$(hdr level)" -ge 2 ] || { echo "flag provided but not defined: -json" >&2; exit 64; }
		caps="$(hdr caps)"
		[ "$caps" != none ] || caps=""
		printf '{"version":"%s","revision":"fake","wire":[2],"schema":21,"media_level":%s,"min_sfu_media_level":%s,"media_capabilities":[%s]}\n' \
			"$(hdr version)" "$(hdr level)" "$(hdr min)" "$caps"
	else
		echo "dillad $(hdr version) (go1.25 linux/amd64) revision=fake CGO_ENABLED=0"
	fi
	;;
migrate)
	# v1's highest migration is 16, v2's is 17. The database's version is in $FAKE_SCHEMA (16
	# when unset), as `dillad migrate status` prints it.
	sub="$1"
	shift
	target=16
	grep -q "^# fake dillad v2 for" "$0" && target=17
	current=16
	if [ -n "${FAKE_SCHEMA:-}" ] && [ -e "$FAKE_SCHEMA" ]; then current="$(cat "$FAKE_SCHEMA")"; fi
	case "$sub" in
	status) echo "current $current, target $target" ;;
	down)
		to=""
		force=""
		for a in "$@"; do
			case "$a" in
			--to=*) to="${a#*=}" ;;
			--i-know-what-i-am-doing) force=1 ;;
			esac
		done
		[ -n "$force" ] || { echo "dillad migrate down: --i-know-what-i-am-doing is required" >&2; exit 64; }
		[ -z "${FAKE_DOWN_FAIL:-}" ] || { echo "migrate down --to=$to: failed" >&2; exit 70; }
		[ "$current" -le "$target" ] || { echo "migrate down: unknown migration $current" >&2; exit 70; }
		echo "$to" >"$FAKE_SCHEMA"
		echo "migrated to $to (target $target)"
		;;
	*) exit 64 ;;
	esac
	;;
*) exit 64 ;;
esac
FAKE
chmod 0755 "$FAKE"

# make_fake OUT VERSION LEVEL MIN CAPS [v2]: a fake dillad of that release. "v2" marks the newer
# schema (migration 17) that the migration cases need.
make_fake() {
	sed -e "s/^# fake-version .*/# fake-version $2/" -e "s/^# fake-level .*/# fake-level $3/" \
		-e "s/^# fake-min .*/# fake-min $4/" -e "s/^# fake-caps .*/# fake-caps $5/" "$FAKE" >"$1"
	[ "${6:-}" != v2 ] || sed -i 's/^# fake dillad for/# fake dillad v2 for/' "$1"
	chmod 0755 "$1"
}

# release_json BINARY: what release.yml makes of the binary's `version --json` (R-UP2), or nothing
# for a binary that has none (web3.11 and older).
release_json() {
	j="$(FAKE_LOG=/dev/null "$1" version --json 2>/dev/null)" || return 0
	v="$(printf '%s' "$j" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
	rest="$(printf '%s' "$j" | sed -e 's/^{"version":"[^"]*","revision":"[^"]*",//' -e 's/}$//')"
	printf '{"format":1,"tag":"v%s","version":"%s",%s,"sfu_restart":"when-idle"}\n' "$v" "$v" "$rest"
}

# A release directory: the three assets under their release names, release.json when the binary
# has `version --json`, and SHA256SUMS over all of them.
# make_release DIR [BINARY]
make_release() {
	mkdir -p "$1"
	cp "${2:-$FAKE}" "$1/dillad-linux-amd64"
	cp "${2:-$FAKE}" "$1/dillad-linux-arm64"
	printf '\0asm fake core %s\n' "$1" >"$1/dilla_core_wasi.wasm"
	cp "$INSTALL" "$1/install.sh" 2>/dev/null || : >"$1/install.sh"
	assets="dillad-linux-amd64 dillad-linux-arm64 dilla_core_wasi.wasm install.sh"
	release_json "$1/dillad-linux-amd64" >"$1/release.json"
	if [ -s "$1/release.json" ]; then assets="$assets release.json"; else rm -f "$1/release.json"; fi
	(cd "$1" && sha256sum $assets >SHA256SUMS)
}

# The releases: web3.11 (REL, the base fake: no release.json), web3.12 (NEW: media level 2, works
# with level 1, serves TURN in dilla-media), a compatible web3.13 (C13: level 2, needs 2) and an
# incompatible one (I13: level 3, needs 3), and a web3.10 whose SFU no rule recognises.
REL="$TMP/release"
make_release "$REL"
make_fake "$TMP/fake-v2" 0.1.0-web3.12 2 1 '"turn"' v2
NEW="$TMP/new-release"
make_release "$NEW" "$TMP/fake-v2"
make_fake "$TMP/fake-c13" 0.1.0-web3.13 2 2 '"turn"' v2
C13="$TMP/c13-release"
make_release "$C13" "$TMP/fake-c13"
make_fake "$TMP/fake-i13" 0.1.0-web3.13 3 3 '"turn"' v2
I13="$TMP/i13-release"
make_release "$I13" "$TMP/fake-i13"
make_fake "$TMP/fake-w10" 0.1.0-web3.10 0 0 none
W10="$TMP/w10-release"
make_release "$W10" "$TMP/fake-w10"
# The media unit install.sh writes for a dillad older than web3.12, which sends no READY=1.
sed -e '/^# READY: /d' -e '/^NotifyAccess=main$/d' -e 's/^Type=notify$/Type=simple/' \
	-e 's/^TimeoutStartSec=60s$/TimeoutStartSec=30s/' "$MEDIA_UNIT" >"$TMP/dilla-media.simple.service"

# run NAME ARGS... : runs install.sh against a fresh root unless ROOT is set;
# leaves OUT, ERR and RC.
CASE=0
run() {
	CASE=$((CASE + 1))
	if [ -z "${KEEP_ROOT:-}" ]; then
		ROOT="$TMP/root$CASE"
		mkdir -p "$ROOT"
	fi
	: >"$LOG"
	rm -f "$ROOT/stub/inactive.done" "$ROOT/stub/api.retried"
	RC=0
	env PATH="${EXTRA_PATH:+$EXTRA_PATH:}$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" FAKE_LOG="$LOG" \
		${RUN_TIMEOUT:+timeout "$RUN_TIMEOUT"} sh "${RUN_SCRIPT:-$INSTALL}" "$@" >"$TMP/out" 2>"$TMP/err" || RC=$?
	OUT="$(cat "$TMP/out")"
	ERR="$(cat "$TMP/err")"
}

mode_of() { stat -c %a "$1" 2>/dev/null || echo missing; }
# count LINE: how many calls in the log are exactly LINE ("systemctl restart dilla" is not
# "systemctl restart dilla-media").
count() { grep -cx -- "$1" "$LOG" || true; }
# line_of LINE [N]: the log line number of the Nth call that is exactly LINE (empty when none).
line_of() { grep -nx -- "$1" "$LOG" | sed -n "${2:-1}p" | cut -d: -f1; }
# What `dillad media --rooms` prints while calls are live.
printf 'room-a\t2 participants\n  alice\n  bob\nroom-b\t0 participants\nroom-c\t1 participants\n  carol\n' >"$TMP/rooms.live"
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac }
# toml_get FILE TABLE KEY: the raw value text of KEY in [TABLE].
toml_get() {
	[ -f "$1" ] || return 0
	awk -v t="[$2]" -v k="$3" '
		{ line = $0; sub(/^[ \t]+/, "", line) }
		line ~ /^\[/ { inside = (line == t); next }
		inside && index(line, k " = ") == 1 { print substr(line, length(k) + 4); exit }
	' "$1"
}
expect_rc() { # NAME WANT
	if [ "$RC" -eq "$2" ]; then return 0; fi
	fail "$1" "exit status $RC, want $2" "stderr: $ERR"
	return 1
}
expect_refusal() { # NAME NEEDLE
	if [ "$RC" -eq 0 ]; then
		fail "$1" "install.sh exited 0, want a refusal" "stderr: $ERR"
	elif ! has "$ERR" "$2"; then
		fail "$1" "stderr does not say \"$2\"" "stderr: $ERR"
	elif [ -n "$OUT" ]; then
		fail "$1" "stdout = \"$OUT\", want nothing"
	else
		pass "$1"
	fi
}

PROXY_BASE="--behind-proxy --domain chat.example.org --listen 0.0.0.0:8080 --trusted-proxy 10.0.0.0/24 --trusted-proxy=10.0.1.7/32"
PROXY_ARGS="$PROXY_BASE --node-ip 203.0.113.10"
PUBLIC_ARGS="--public --domain chat.example.org --public-ip 203.0.113.10 --agree-tos"
URL="--release-url file://$REL"

# ------------------------------------------------------ argument parsing ----
run --help
if expect_rc "--help exits 0" 0 && has "$ERR$OUT" "usage: install.sh" && has "$ERR$OUT" "--behind-proxy" && has "$ERR$OUT" "--upgrade"; then
	pass "--help prints the usage"
else
	fail "--help prints the usage" "out: $OUT" "err: $ERR"
fi

run --domain chat.example.org
expect_refusal "no mode is refused" "--behind-proxy or --public"

# shellcheck disable=SC2086
run $PROXY_ARGS --public --public-ip 203.0.113.10 --agree-tos
expect_refusal "both modes are refused" "only one of"

run --bogus
expect_refusal "an unknown option is refused" "unknown option --bogus"

run --behind-proxy --domain
expect_refusal "a flag without its value is refused" "--domain needs a value"

run --behind-proxy --domain chat.example.org --trusted-proxy 10.0.0.0/24
expect_refusal "behind-proxy without --listen is refused" "--listen"

run --behind-proxy --domain chat.example.org --listen 0.0.0.0:8080
expect_refusal "behind-proxy without --trusted-proxy is refused" "--trusted-proxy"

run --behind-proxy --listen 0.0.0.0:8080 --trusted-proxy 10.0.0.0/24
expect_refusal "behind-proxy without --domain is refused" "--domain"

run --behind-proxy --domain chat.example.org --listen 8080 --trusted-proxy 10.0.0.0/24
expect_refusal "a --listen without a port is refused" "--listen"

run --behind-proxy --domain chat.example.org --listen 0.0.0.0:8080 --trusted-proxy "10.0.0.0/24'"
expect_refusal "a --trusted-proxy that is no CIDR is refused" "--trusted-proxy"

run --behind-proxy --domain "chat.example.org'" --listen 0.0.0.0:8080 --trusted-proxy 10.0.0.0/24
expect_refusal "a --domain with a quote is refused" "--domain"

run --public --domain chat.example.org --public-ip 203.0.113.10
expect_refusal "public without --agree-tos is refused" "--agree-tos"

run --public --domain chat.example.org --agree-tos
expect_refusal "public without --public-ip is refused" "--public-ip"

run --public --domain chat.example.org --public-ip 203.0.113.10 --agree-tos --listen 0.0.0.0:8080
expect_refusal "public with a behind-proxy flag is refused" "--listen"

# shellcheck disable=SC2086
run $PUBLIC_ARGS --udp-port 70000
expect_refusal "a --udp-port out of range is refused" "--udp-port"

# shellcheck disable=SC2086
run $PUBLIC_ARGS --version v1.2.3 --check-args
if expect_rc "--check-args accepts a valid public install" 0 && [ -z "$OUT" ] && [ ! -e "$ROOT/usr" ] && [ ! -s "$LOG" ]; then
	pass "--check-args validates and touches nothing"
else
	fail "--check-args validates and touches nothing" "out: $OUT" "log: $(cat "$LOG")"
fi

# shellcheck disable=SC2086
STUB_UID=1000 run $PUBLIC_ARGS $URL
expect_refusal "a non-root run is refused" "as root"

# shellcheck disable=SC2086
STUB_ARCH=riscv64 run $PUBLIC_ARGS $URL
expect_refusal "an unsupported architecture is refused" "riscv64"

# ------------------------------------------------------------ checksums ----
BAD="$TMP/bad-release"
make_release "$BAD"
printf 'tampered' >>"$BAD/dillad-linux-amd64"
# shellcheck disable=SC2086
run $PUBLIC_ARGS --release-url "file://$BAD"
expect_refusal "a tampered binary is refused" "checksum"
if [ -e "$ROOT/usr/local/bin/dillad" ] || [ -e "$ROOT/var/lib/dillad" ] || has "$(cat "$LOG")" "init"; then
	fail "a checksum refusal installs nothing" "$(find "$ROOT" | sed -n '1,20p')"
else
	pass "a checksum refusal installs nothing"
fi

BADCORE="$TMP/bad-core"
make_release "$BADCORE"
printf 'x' >>"$BADCORE/dilla_core_wasi.wasm"
# shellcheck disable=SC2086
run $PUBLIC_ARGS --release-url "file://$BADCORE"
expect_refusal "a tampered core is refused" "checksum"

NOLINE="$TMP/no-line"
make_release "$NOLINE"
grep -v 'dilla_core_wasi.wasm' "$NOLINE/SHA256SUMS" >"$NOLINE/SHA256SUMS.new"
mv "$NOLINE/SHA256SUMS.new" "$NOLINE/SHA256SUMS"
# shellcheck disable=SC2086
run $PUBLIC_ARGS --release-url "file://$NOLINE"
expect_refusal "SHA256SUMS without a line for the core is refused" "dilla_core_wasi.wasm"

# shellcheck disable=SC2086
STUB_ARCH=aarch64 run $PUBLIC_ARGS --release-url "file://$TMP/nowhere"
expect_refusal "a release that cannot be fetched is refused" "download"

# Offline: local files checked against a SHA256SUMS they do not match.
# shellcheck disable=SC2086
run $PUBLIC_ARGS --binary "$BAD/dillad-linux-amd64" --core "$REL/dilla_core_wasi.wasm" --sums "$REL/SHA256SUMS"
expect_refusal "an offline binary that does not match --sums is refused" "checksum"

# ------------------------------------------------- behind_proxy install ----
check_common_install() { # NAME
	name="$1"
	problems=""
	[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
	[ "$OUT" = "https://chat.example.org/i/SECRETINVITECODE" ] || problems="$problems|stdout = \"$OUT\", want exactly the invite link"
	has "$ERR" "SECRETINVITECODE" && problems="$problems|the invite code reached stderr"
	has "$ERR" "secret-turn-" && problems="$problems|the TURN secret reached stderr"
	has "$ERR" "secret-livekit-" && problems="$problems|the LiveKit secret reached stderr"
	cmp -s "$ROOT/usr/local/bin/dillad" "${EXPECT_BIN:-$FAKE}" || problems="$problems|/usr/local/bin/dillad is not the release binary"
	cmp -s "$ROOT/usr/local/bin/dilla_core_wasi.wasm" "${EXPECT_REL:-$REL}/dilla_core_wasi.wasm" || problems="$problems|the core is not beside the binary"
	cmp -s "$ROOT/etc/systemd/system/dilla.service" "$UNIT" || problems="$problems|the installed unit differs from deploy/dilla.service"
	# web3.11 (the base fake) sends no READY=1, so its unit is the Type=simple variant.
	cmp -s "$ROOT/etc/systemd/system/dilla-media.service" "${EXPECT_MEDIA_UNIT:-$TMP/dilla-media.simple.service}" || problems="$problems|the media unit differs from the one for this release: $(diff "${EXPECT_MEDIA_UNIT:-$TMP/dilla-media.simple.service}" "$ROOT/etc/systemd/system/dilla-media.service" | tr '\n' ' ')"
	grep -q '^PartOf=' "$MEDIA_UNIT" && problems="$problems|deploy/dilla-media.service has PartOf (R-UP5)"
	grep -q '^PartOf=' "$ROOT/etc/systemd/system/dilla-media.service" && problems="$problems|the media unit install.sh wrote has PartOf (R-UP5)"
	cmp -s "$ROOT/etc/systemd/system/dilla-media-refresh.service" "$HERE/dilla-media-refresh.service" || problems="$problems|the refresh service differs from deploy/dilla-media-refresh.service"
	cmp -s "$ROOT/etc/systemd/system/dilla-media-refresh.timer" "$HERE/dilla-media-refresh.timer" || problems="$problems|the refresh timer differs from deploy/dilla-media-refresh.timer"
	cmp -s "$ROOT/usr/local/libexec/dilla-media-refresh" "$HERE/dilla-media-refresh.sh" || problems="$problems|the refresh script differs from deploy/dilla-media-refresh.sh"
	[ "$(mode_of "$ROOT/usr/local/libexec/dilla-media-refresh")" = 755 ] || problems="$problems|the refresh script mode $(mode_of "$ROOT/usr/local/libexec/dilla-media-refresh"), want 755"
	[ "$(mode_of "$ROOT/etc/dilla/dilla.toml")" = 640 ] || problems="$problems|dilla.toml mode $(mode_of "$ROOT/etc/dilla/dilla.toml"), want 640"
	[ "$(mode_of "$ROOT/var/lib/dillad")" = 700 ] || problems="$problems|/var/lib/dillad mode $(mode_of "$ROOT/var/lib/dillad"), want 700"
	[ "$(mode_of "$ROOT/usr/local/bin/dillad")" = 755 ] || problems="$problems|dillad mode $(mode_of "$ROOT/usr/local/bin/dillad"), want 755"
	[ ! -e "$ROOT/var/lib/dillad/dilla.toml" ] || problems="$problems|init's dilla.toml was left in the data directory"
	# Every file under the data directory is owner-only whatever the umask (R17), each offender named.
	for offender in $(find "$ROOT/var/lib/dillad" -type f ! -perm 0600 2>/dev/null); do
		problems="$problems|$offender mode $(mode_of "$offender"), want 600"
	done
	for offender in $(find "$ROOT/var/lib/dillad" -type d ! -perm 0700 2>/dev/null); do
		problems="$problems|$offender mode $(mode_of "$offender"), want 700"
	done
	calls="$(cat "$LOG")"
	has "$calls" "useradd --system --user-group --no-create-home --home-dir /var/lib/dillad --shell /usr/sbin/nologin dillad" || problems="$problems|no dillad system user was created"
	has "$calls" "chown root:dillad $ROOT/etc/dilla/dilla.toml" || problems="$problems|dilla.toml is not root:dillad"
	has "$calls" "chown -R dillad:dillad $ROOT/var/lib/dillad" || problems="$problems|the data directory is not dillad's"
	has "$calls" "systemctl daemon-reload" || problems="$problems|no daemon-reload"
	has "$calls" "systemctl enable --now dilla" || problems="$problems|the service was not enabled and started"
	has "$calls" "systemctl enable --now dilla-media" || problems="$problems|the media service was not enabled and started"
	has "$calls" "doctor --config=$ROOT/etc/dilla/dilla.toml" || problems="$problems|doctor did not run against /etc/dilla/dilla.toml"
	has "$calls" "apt-get" && problems="$problems|apt-get ran although curl and ca-certificates were present"
	if [ -z "$problems" ]; then pass "$name"; else
		old_ifs="$IFS"
		IFS='|'
		# shellcheck disable=SC2086
		fail "$name" $problems
		IFS="$old_ifs"
	fi
}

# The CA bundle the apt check looks for, so no package is installed.
seed_root() {
	CASE=$((CASE + 1))
	ROOT="$TMP/root$CASE"
	mkdir -p "$ROOT/etc/ssl/certs"
	echo bundle >"$ROOT/etc/ssl/certs/ca-certificates.crt"
}

seed_root
# shellcheck disable=SC2086
KEEP_ROOT=1 run $PROXY_ARGS --public-ip 203.0.113.10 --udp-port 7999 $URL
check_common_install "a behind-proxy install prints only the link and installs per §3"
T="$ROOT/etc/dilla/dilla.toml"
want_toml() { # TABLE KEY WANT
	got="$(toml_get "$T" "$1" "$2")"
	if [ "$got" = "$3" ]; then return 0; fi
	TOML_PROBLEMS="$TOML_PROBLEMS|$1.$2 = $got, want $3"
}
TOML_PROBLEMS=""
want_toml tls mode "'behind_proxy'"
want_toml tls agreed false
want_toml server plain_listen "'0.0.0.0:8080'"
want_toml server trusted_proxy_cidrs "['10.0.0.0/24', '10.0.1.7/32']"
want_toml server listen "':443'"
want_toml turn enabled false
want_toml livekit udp_port 7999
want_toml livekit mode "'sidecar'"
want_toml livekit node_ip "'203.0.113.10'"
want_toml instance public_ip "'203.0.113.10'"
want_toml instance domain "'chat.example.org'"
if [ -z "$TOML_PROBLEMS" ]; then pass "behind-proxy: dilla.toml carries the mode's keys"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "behind-proxy: dilla.toml carries the mode's keys" $TOML_PROBLEMS
	IFS='
'
fi
if has "$ERR" "Pangolin" && has "$ERR" "SSO" && has "$ERR" "WebSocket" && has "$ERR" "7999/udp"; then
	pass "behind-proxy: the Pangolin next steps are printed"
else
	fail "behind-proxy: the Pangolin next steps are printed" "stderr: $ERR"
fi

# Re-run without --upgrade: refused, nothing touched.
cp "$T" "$TMP/toml.before" 2>/dev/null || : >"$TMP/toml.before"
# shellcheck disable=SC2086
KEEP_ROOT=1 run $PROXY_ARGS $URL
expect_refusal "a second install over an instance is refused" "--upgrade"
if cmp -s "$T" "$TMP/toml.before" && ! has "$(cat "$LOG")" "init"; then
	pass "the refused re-run left the config alone and ran no init"
else
	fail "the refused re-run left the config alone and ran no init" "log: $(cat "$LOG")"
fi

# --upgrade: new binary and core, config and data untouched, no init.
# The installed web3.11 SFU is level 1 (from /proc/<pid>/exe version) and web3.12 works with level
# 1, so this is the compatible case (R-UP3): dilla restarts once and dilla-media never.
ls -la "$ROOT/var/lib/dillad" >"$TMP/data.before" 2>&1 || :
FAKE_ROOMS="$TMP/rooms.live" KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC: $ERR"
[ -z "$OUT" ] || problems="$problems|stdout = \"$OUT\", want nothing on an upgrade"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/fake-v2" || problems="$problems|the binary was not replaced"
cmp -s "$ROOT/usr/local/bin/dilla_core_wasi.wasm" "$NEW/dilla_core_wasi.wasm" || problems="$problems|the core was not replaced"
cmp -s "$T" "$TMP/toml.before" || problems="$problems|the upgrade changed dilla.toml"
ls -la "$ROOT/var/lib/dillad" >"$TMP/data.after" 2>&1 || :
cmp -s "$TMP/data.before" "$TMP/data.after" || problems="$problems|the upgrade changed the data directory"
has "$(cat "$LOG")" "dillad init" && problems="$problems|the upgrade ran init"
[ "$(count 'systemctl restart dilla')" -eq 1 ] || problems="$problems|dilla restarted $(count 'systemctl restart dilla') times, want 1"
[ "$(count 'systemctl restart dilla-media')" -eq 0 ] || problems="$problems|dilla-media was restarted"
has "$(cat "$LOG")" "systemctl stop dilla-media" && problems="$problems|dilla-media was stopped"
has "$(cat "$LOG")" "media --rooms" && problems="$problems|the live-call check ran although the SFU stays"
has "$(cat "$LOG")" "doctor --config=" || problems="$problems|the upgrade did not run doctor"
has "$ERR" "decision: keep dilla-media running" || problems="$problems|the decision is not logged: $ERR"
has "$ERR" "(media level 1, from the SHA-256 of $ROOT/proc/" && has "$ERR" "which is $ROOT/usr/local/bin/dillad)" || problems="$problems|the level did not come from the running executable's SHA-256"
has "$ERR" "keeps v0.1.0-web3.11 until its calls end" || problems="$problems|the report does not say which binary the SFU runs: $ERR"
has "$(cat "$LOG")" "systemctl enable --now dilla-media-refresh.timer" || problems="$problems|the refresh timer was not enabled"
cmp -s "$ROOT/etc/systemd/system/dilla-media.service" "$MEDIA_UNIT" || problems="$problems|the media unit is not deploy/dilla-media.service"
cmp -s "$ROOT/usr/local/libexec/dilla-media-refresh" "$HERE/dilla-media-refresh.sh" || problems="$problems|the refresh script is not deploy/dilla-media-refresh.sh"
if [ -z "$problems" ]; then pass "a compatible --upgrade with live rooms restarts dilla once, dilla-media never, and is not refused"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "a compatible --upgrade with live rooms restarts dilla once, dilla-media never, and is not refused" $problems
	IFS='
'
fi

# The live-call preflight: a downgrade to web3.11 has no release.json, so it restarts the SFU, and
# --upgrade asks `dillad media --rooms` as the service user, just before it changes anything. The
# target release differs from the installed one, so "untouched" is visible.
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-preflight"
cp "$ROOT/etc/dilla/dilla.toml" "$TMP/toml.pre-preflight"
untouched() { # prints a problem list, empty when nothing was touched
	cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/pre-preflight" || printf '|the binary was replaced'
	cmp -s "$ROOT/etc/dilla/dilla.toml" "$TMP/toml.pre-preflight" || printf '|dilla.toml changed'
	# Asking systemd (is-active, show) changes nothing; any other systemctl call does.
	grep systemctl "$LOG" | grep -Evq '^systemctl (is-active|show) ' && printf '|systemctl ran: %s' "$(grep systemctl "$LOG" | tr '\n' ';')"
	has "$(cat "$LOG")" "migrate down" && printf '|migrate ran'
	return 0
}
FAKE_ROOMS="$TMP/rooms.live" KEEP_ROOT=1 run --upgrade --release-url "file://$REL"
problems="$(untouched)"
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want a refusal"
has "$ERR" "room-a" && has "$ERR" "2 participants" && has "$ERR" "room-c" && has "$ERR" "1 participants" || problems="$problems|the rooms and counts are not listed"
has "$ERR" "room-b" && problems="$problems|an empty room is listed"
has "$ERR" "alice" && problems="$problems|identities are listed"
has "$ERR" "--restart-sfu" || problems="$problems|the override is not named"
has "$ERR" "has no release.json" || problems="$problems|the restart decision does not say why: $ERR"
has "$(cat "$LOG")" "runuser -u dillad -- $ROOT/usr/local/bin/dillad media --rooms --config=" || problems="$problems|media --rooms did not run as the service user: $(cat "$LOG")"
[ -z "$OUT" ] || problems="$problems|stdout = \"$OUT\", want nothing"
if [ -z "$problems" ]; then pass "a downgrade (no release.json) with live rooms refuses and touches nothing"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "a downgrade (no release.json) with live rooms refuses and touches nothing" $problems
	IFS='
'
fi

FAKE_ROOMS_FAIL=1 KEEP_ROOT=1 run --upgrade --release-url "file://$REL"
problems="$(untouched)"
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want a refusal"
has "$ERR" "could not list the live rooms" || problems="$problems|the failure is not named: $ERR"
if [ -z "$problems" ]; then pass "--upgrade refuses when the live-room check itself fails"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "--upgrade refuses when the live-room check itself fails" $problems
	IFS='
'
fi

FAKE_ROOMS_FAIL=1 KEEP_ROOT=1 run --upgrade --yes --release-url "file://$REL"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC: $ERR"
has "$ERR" "warning" && has "$ERR" "--yes" || problems="$problems|no warning about the override"
cmp -s "$ROOT/usr/local/bin/dillad" "$FAKE" || problems="$problems|the binary was not replaced"
cmp -s "$ROOT/etc/systemd/system/dilla-media.service" "$TMP/dilla-media.simple.service" || problems="$problems|the media unit is not the Type=simple one web3.11 needs"
has "$(cat "$LOG")" "systemctl disable --now dilla-media-refresh.timer" || problems="$problems|the refresh timer was left on for a dillad without media --idle"
if [ -z "$problems" ]; then pass "--upgrade --yes proceeds when the live-room check fails, with a warning"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "--upgrade --yes proceeds when the live-room check fails, with a warning" $problems
	IFS='
'
fi

# A stopped media service has no rooms, so there are no live calls: the upgrade says so and
# proceeds without --restart-sfu.
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
STUB_MEDIA_INACTIVE=1 FAKE_ROOMS_FAIL=1 KEEP_ROOT=1 run --upgrade --release-url "file://$REL"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC: $ERR"
has "$(cat "$LOG")" "systemctl is-active --quiet dilla-media" || problems="$problems|dilla-media's state was not asked: $(cat "$LOG")"
has "$(cat "$LOG")" "media --rooms" && problems="$problems|media --rooms ran although dilla-media is stopped"
has "$ERR" "dilla-media is not running" || problems="$problems|the reason is not said: $ERR"
has "$ERR" "warning" && problems="$problems|a warning although nothing was overridden"
cmp -s "$ROOT/usr/local/bin/dillad" "$FAKE" || problems="$problems|the binary was not replaced"
if [ -z "$problems" ]; then pass "--upgrade proceeds without --restart-sfu when dilla-media is stopped (no live calls)"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "--upgrade proceeds without --restart-sfu when dilla-media is stopped (no live calls)" $problems
	IFS='
'
fi

# Back on the newer release for the cases below.
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-preflight"
cp "$ROOT/etc/dilla/dilla.toml" "$TMP/toml.pre-preflight"
FAKE_ROOMS="$TMP/rooms.live" KEEP_ROOT=1 run --upgrade --yes --release-url "file://$REL"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC: $ERR"
has "$ERR" "warning" && has "$ERR" "live calls" && has "$ERR" "--yes" || problems="$problems|no warning about the override: $ERR"
cmp -s "$ROOT/usr/local/bin/dillad" "$FAKE" || problems="$problems|the binary was not replaced"
[ "$(count 'systemctl restart dilla')" -eq 1 ] || problems="$problems|dilla was not restarted once"
if [ -z "$problems" ]; then pass "--upgrade --yes proceeds over live rooms, with a warning"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "--upgrade --yes proceeds over live rooms, with a warning" $problems
	IFS='
'
fi

KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC: $ERR"
has "$(cat "$LOG")" "media --rooms" && problems="$problems|the rooms were asked although the SFU stays"
has "$ERR" "warning" && problems="$problems|a warning with no live rooms"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/fake-v2" || problems="$problems|the binary was not replaced"
if [ -z "$problems" ]; then pass "--upgrade onto a compatible release proceeds without asking for rooms"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "--upgrade onto a compatible release proceeds without asking for rooms" $problems
	IFS='
'
fi

# --upgrade against a tampered release: refused, the running binary stays.
KEEP_ROOT=1 run --upgrade --release-url "file://$BAD"
expect_refusal "--upgrade from a tampered release is refused" "checksum"
if cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/fake-v2" && ! has "$(cat "$LOG")" "restart"; then
	pass "a refused upgrade keeps the installed binary"
else
	fail "a refused upgrade keeps the installed binary"
fi

KEEP_ROOT=1 run --upgrade --domain chat.example.org $URL
expect_refusal "--upgrade with a mode flag is refused" "--upgrade"

run --upgrade $URL
expect_refusal "--upgrade with no instance is refused" "no instance"

run --yes $PROXY_ARGS $URL
expect_refusal "--yes without --upgrade is refused" "--yes is for --upgrade"

run --restart-sfu $PROXY_ARGS $URL
expect_refusal "--restart-sfu without --upgrade is refused" "--restart-sfu is for --upgrade"

# An instance from the old all-in-one release is migrated once. The old process
# releases the UDP port before the sidecar starts, and the previous config stays
# beside the new one for rollback. It ends calls, so it still needs --yes.
seed_root
KEEP_ROOT=1 run $PUBLIC_ARGS $URL
MIGRATING_CONF="$ROOT/etc/dilla/dilla.toml"
sed -i "s/^  mode = 'sidecar'$/  mode = 'in_process'/" "$MIGRATING_CONF"
rm -f "$ROOT/stub/media.pid" # an in_process instance runs no dilla-media
sed -i "s/^  mode = 'in_process'$/  mode = 'in_process' # local SFU/" "$MIGRATING_CONF"
KEEP_ROOT=1 run --upgrade --restart-sfu --release-url "file://$NEW"
expect_refusal "the in_process migration needs --yes, not only --restart-sfu" "--yes"
KEEP_ROOT=1 run --upgrade --yes --release-url "file://$NEW"
calls="$(cat "$LOG")"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|upgrade exited $RC: $ERR"
[ "$(toml_get "$MIGRATING_CONF" livekit mode)" = "'sidecar'" ] || problems="$problems|livekit.mode was not migrated"
[ "$(toml_get "$MIGRATING_CONF.prev" livekit mode)" = "'in_process' # local SFU" ] || problems="$problems|the old config was not saved"
has "$calls" "systemctl stop dilla" || problems="$problems|the old SFU was not stopped"
has "$calls" "systemctl enable --now dilla-media" || problems="$problems|the sidecar was not started"
[ "$(count 'systemctl restart dilla')" -eq 1 ] || problems="$problems|the API was not restarted once"
[ "$(count 'systemctl restart dilla-media')" -eq 0 ] || problems="$problems|the new sidecar was restarted a second time"
if [ -z "$problems" ]; then pass "an all-in-one install migrates to the sidecar on upgrade"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "an all-in-one install migrates to the sidecar on upgrade" $problems
	IFS='
'
fi

# If the new API fails after that migration, it must restore the old config and
# stop the new media service before starting the old combined process again.
seed_root
KEEP_ROOT=1 run $PUBLIC_ARGS $URL
MIGRATING_CONF="$ROOT/etc/dilla/dilla.toml"
sed -i "s/^  mode = 'sidecar'$/  mode = 'in_process'/" "$MIGRATING_CONF"
rm -f "$ROOT/stub/media.pid" # an in_process instance runs no dilla-media
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-migration"
echo 16 >"$TMP/schema"
FAKE_SCHEMA="$TMP/schema" STUB_FAIL_V2=1 KEEP_ROOT=1 run --upgrade --yes --release-url "file://$NEW"
calls="$(cat "$LOG")"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|upgrade unexpectedly succeeded"
[ "$(toml_get "$MIGRATING_CONF" livekit mode)" = "'in_process'" ] || problems="$problems|the old mode was not restored"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/pre-migration" || problems="$problems|the old binary was not restored"
has "$calls" "systemctl disable --now dilla-media" || problems="$problems|the sidecar was not stopped and disabled"
has "$calls" "systemctl restart dilla" || problems="$problems|the combined process was not restarted"
has "$ERR" "the previous release is running" || problems="$problems|the previous release did not restart"
if [ -z "$problems" ]; then pass "failed first migration restores the old combined service"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "failed first migration restores the old combined service" $problems
	IFS='
'
fi

# A media server that never becomes ready must fail the upgrade and restore the previous combined
# service.
seed_root
KEEP_ROOT=1 run $PUBLIC_ARGS $URL
MIGRATING_CONF="$ROOT/etc/dilla/dilla.toml"
sed -i "s/^  mode = 'sidecar'$/  mode = 'in_process'/" "$MIGRATING_CONF"
rm -f "$ROOT/stub/media.pid" # an in_process instance runs no dilla-media
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-probe"
FAKE_MEDIA_PROBE_FAIL=1 KEEP_ROOT=1 run --upgrade --yes --release-url "file://$NEW"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|upgrade unexpectedly succeeded"
[ "$(toml_get "$MIGRATING_CONF" livekit mode)" = "'in_process'" ] || problems="$problems|old mode was not restored"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/pre-probe" || problems="$problems|old binary was not restored"
has "$(cat "$LOG")" "systemctl disable --now dilla-media" || problems="$problems|failed media was not disabled"
has "$ERR" "the media service did not start" || problems="$problems|the media failure is not named: $ERR"
if [ -z "$problems" ]; then pass "first migration rolls back when media never becomes ready"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "first migration rolls back when media never becomes ready" $problems
	IFS='
'
fi

# ------------------------------------------------------- public install ----
seed_root
# shellcheck disable=SC2086
KEEP_ROOT=1 run $PUBLIC_ARGS --node-ip 203.0.113.20 $URL
check_common_install "a public install prints only the link and installs per §3"
T="$ROOT/etc/dilla/dilla.toml"
TOML_PROBLEMS=""
want_toml tls mode "'acme_tls_alpn'"
want_toml tls agreed true
want_toml server trusted_proxy_cidrs "[]"
want_toml turn enabled true
want_toml livekit udp_port 7882
want_toml livekit node_ip "'203.0.113.20'"
want_toml instance public_ip "'203.0.113.10'"
if [ -z "$TOML_PROBLEMS" ]; then pass "public: dilla.toml keeps acme_tls_alpn and takes --node-ip"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "public: dilla.toml keeps acme_tls_alpn and takes --node-ip" $TOML_PROBLEMS
	IFS='
'
fi

# behind-proxy without --public-ip or --node-ip is refused (M3) ...
run $PROXY_BASE $URL
expect_refusal "behind-proxy without --public-ip, --node-ip or --no-media-ip is refused" "--node-ip"

# ... unless --no-media-ip says so: no address in the file, and a warning.
seed_root
KEEP_ROOT=1 run $PROXY_BASE --no-media-ip $URL
T="$ROOT/etc/dilla/dilla.toml"
TOML_PROBLEMS=""
want_toml instance public_ip "''"
want_toml livekit node_ip "''"
if [ "$RC" -eq 0 ] && [ -z "$TOML_PROBLEMS" ] && has "$ERR" "livekit.node_ip"; then
	pass "behind-proxy without an address leaves node_ip empty and says so"
else
	fail "behind-proxy without an address leaves node_ip empty and says so" "rc $RC" "$TOML_PROBLEMS" "stderr: $ERR"
fi

# ------------------------------------------------------- doctor results ----
printf 'OK    config       parsed and validated\nFAIL  clock        no peer answered\nFAIL  certificate  no certificate for chat.example.org yet\nFAIL  turn         dial tls://chat.example.org:443: no such host\nWARN  udp          not probed\n' >"$TMP/doctor-net"
seed_root
# shellcheck disable=SC2086
FAKE_DOCTOR="$TMP/doctor-net" FAKE_DOCTOR_EXIT=69 KEEP_ROOT=1 run $PUBLIC_ARGS $URL
if [ "$RC" -eq 0 ] && [ "$OUT" = "https://chat.example.org/i/SECRETINVITECODE" ] && has "$ERR" "FAIL  certificate" && has "$ERR" "until DNS"; then
	pass "doctor failing only on DNS and network legs does not fail the install, and shows them"
else
	fail "doctor failing only on DNS and network legs does not fail the install, and shows them" "rc $RC" "out: $OUT" "stderr: $ERR"
fi

printf 'OK    config       parsed and validated\nFAIL  wasi         dilla_core_wasi.wasm: bad magic\nWARN  udp          not probed\n' >"$TMP/doctor-wasi"
seed_root
# shellcheck disable=SC2086
FAKE_DOCTOR="$TMP/doctor-wasi" FAKE_DOCTOR_EXIT=69 KEEP_ROOT=1 run $PUBLIC_ARGS $URL
if [ "$RC" -ne 0 ] && [ "$OUT" = "https://chat.example.org/i/SECRETINVITECODE" ] && has "$ERR" "FAIL  wasi"; then
	pass "doctor failing on the install itself fails it, and the link is still printed once"
else
	fail "doctor failing on the install itself fails it, and the link is still printed once" "rc $RC" "out: $OUT" "stderr: $ERR"
fi

seed_root
# shellcheck disable=SC2086
STUB_SYSTEMCTL_FAIL=1 KEEP_ROOT=1 run $PUBLIC_ARGS $URL
if [ "$RC" -ne 0 ] && [ "$OUT" = "https://chat.example.org/i/SECRETINVITECODE" ] && has "$ERR" "journalctl"; then
	pass "a service that does not start fails the install and still prints the link"
else
	fail "a service that does not start fails the install and still prints the link" "rc $RC" "out: $OUT" "stderr: $ERR"
fi

# ------------------------------------------------- packages and offline ----
# No CA bundle in the root: apt installs ca-certificates, and only that.
# shellcheck disable=SC2086
run $PUBLIC_ARGS $URL
calls="$(cat "$LOG")"
if has "$calls" "apt-get install -y --no-install-recommends ca-certificates" && ! has "$calls" "install -y --no-install-recommends curl"; then
	pass "only the missing package is installed"
else
	fail "only the missing package is installed" "log: $calls"
fi

# Offline with --sums: no download, no apt.
seed_root
# shellcheck disable=SC2086
KEEP_ROOT=1 run $PUBLIC_ARGS --binary "$REL/dillad-linux-amd64" --core "$REL/dilla_core_wasi.wasm" --sums "$REL/SHA256SUMS" --release-url "file://$TMP/nowhere"
if [ "$RC" -eq 0 ] && cmp -s "$ROOT/usr/local/bin/dillad" "$FAKE" && ! has "$(cat "$LOG")" "apt-get"; then
	pass "an offline install with --sums needs no network"
else
	fail "an offline install with --sums needs no network" "rc $RC" "stderr: $ERR"
fi

# ------------------------------------------- security review, 2026-10-14 ----
# C1: a downloaded SHA256SUMS that is empty must refuse, never fall back to "unverified".
EMPTY="$TMP/empty-sums"
make_release "$EMPTY"
: >"$EMPTY/SHA256SUMS"
run $PUBLIC_ARGS --release-url "file://$EMPTY"
expect_refusal "an empty downloaded SHA256SUMS is refused" "SHA256SUMS"
if [ -e "$ROOT/usr" ] || [ -e "$ROOT/var/lib/dillad" ]; then
	fail "an empty SHA256SUMS installs nothing" "$(find "$ROOT" | sed -n '1,10p')"
else
	pass "an empty SHA256SUMS installs nothing"
fi

# C1: one local file plus one download, no --sums: the download is still checked.
MIXED="$TMP/mixed"
make_release "$MIXED"
printf 'x' >>"$MIXED/dilla_core_wasi.wasm"
run $PUBLIC_ARGS --binary "$REL/dillad-linux-amd64" --insecure-skip-verify --release-url "file://$MIXED"
expect_refusal "a downloaded core is checked even when the binary is local" "checksum"

# I1: no "latest". An unstamped copy (the one in git) needs --version or --release-url.
if [ "$(grep -c '^DILLA_RELEASE_TAG=""$' "$INSTALL")" = 1 ]; then
	pass "install.sh carries exactly one DILLA_RELEASE_TAG placeholder for release.yml to stamp"
else
	fail "install.sh carries exactly one DILLA_RELEASE_TAG placeholder for release.yml to stamp"
fi
run $PUBLIC_ARGS
expect_refusal "an unstamped install.sh without --version or --release-url is refused" "--version"
run $PUBLIC_ARGS --version latest
expect_refusal "--version latest is refused" "--version"

# A curl that records the URL it was asked for and fails, so nothing leaves the box.
CURLSTUB="$TMP/curlstub"
mkdir -p "$CURLSTUB"
printf '#!/bin/sh\nfor a in "$@"; do last="$a"; done\necho "curl $last" >>"%s"\nexit 22\n' "$LOG" >"$CURLSTUB/curl"
chmod 0755 "$CURLSTUB/curl"
mkdir -p "$TMP/stamped"
sed 's/^DILLA_RELEASE_TAG=""$/DILLA_RELEASE_TAG="v9.9.9-test"/' "$INSTALL" >"$TMP/stamped/install.sh"
seed_root
EXTRA_PATH="$CURLSTUB" RUN_SCRIPT="$TMP/stamped/install.sh" KEEP_ROOT=1 run $PUBLIC_ARGS
if [ "$RC" -ne 0 ] && has "$(cat "$LOG")" "curl https://github.com/jonasthim/dilla/releases/download/v9.9.9-test/dillad-linux-amd64"; then
	pass "a stamped install.sh downloads from its own tag by default"
else
	fail "a stamped install.sh downloads from its own tag by default" "log: $(cat "$LOG")" "stderr: $ERR"
fi
seed_root
EXTRA_PATH="$CURLSTUB" KEEP_ROOT=1 run $PUBLIC_ARGS --version v1.2.3
if has "$(cat "$LOG")" "curl https://github.com/jonasthim/dilla/releases/download/v1.2.3/dillad-linux-amd64"; then
	pass "--version TAG downloads from releases/download/TAG"
else
	fail "--version TAG downloads from releases/download/TAG" "log: $(cat "$LOG")" "stderr: $ERR"
fi

# M1: local files without --sums are refused unless --insecure-skip-verify.
run $PUBLIC_ARGS --binary "$REL/dillad-linux-amd64" --core "$REL/dilla_core_wasi.wasm"
expect_refusal "local --binary and --core without --sums are refused" "--sums"
seed_root
KEEP_ROOT=1 run $PUBLIC_ARGS --binary "$REL/dillad-linux-amd64" --core "$REL/dilla_core_wasi.wasm" --insecure-skip-verify
if [ "$RC" -eq 0 ] && has "$ERR" "unverified"; then
	pass "--insecure-skip-verify installs local files with a warning"
else
	fail "--insecure-skip-verify installs local files with a warning" "rc $RC" "stderr: $ERR"
fi

# M2: a failure after init still prints the link once, and says how to start over.
seed_root
FAKE_INIT_BAD=1 KEEP_ROOT=1 run $PUBLIC_ARGS $URL
if [ "$RC" -ne 0 ] && [ "$OUT" = "https://chat.example.org/i/SECRETINVITECODE" ] && has "$ERR" "rm -rf"; then
	pass "a failure after init prints the link and the way to start over"
else
	fail "a failure after init prints the link and the way to start over" "rc $RC" "out: $OUT" "stderr: $ERR"
fi

# M4: values dillad would refuse are refused before anything is installed.
run $PUBLIC_ARGS --udp-port 07882 $URL
expect_refusal "a --udp-port with a leading zero is refused" "--udp-port"
run $PUBLIC_ARGS --node-ip 1.2.3.4.5 $URL
expect_refusal "a --node-ip that is no address is refused" "--node-ip"
run --public --domain chat.example.org --public-ip 256.1.1.1 --agree-tos $URL
expect_refusal "an IPv4 octet over 255 is refused" "--public-ip"
run $PROXY_BASE --node-ip 203.0.113.10 --trusted-proxy 10.0.0.0/33 $URL
expect_refusal "an IPv4 prefix longer than 32 is refused" "--trusted-proxy"

# M4: the edited dilla.toml is checked before the unit is enabled.
printf 'FAIL  config       instance.public_ip: bad\n' >"$TMP/doctor-config"
seed_root
FAKE_DOCTOR="$TMP/doctor-config" FAKE_DOCTOR_EXIT=69 KEEP_ROOT=1 run $PUBLIC_ARGS $URL
if [ "$RC" -ne 0 ] && ! has "$(cat "$LOG")" "enable --now" && [ "$OUT" = "https://chat.example.org/i/SECRETINVITECODE" ]; then
	pass "a dilla.toml the config check refuses is never started, and the link is printed"
else
	fail "a dilla.toml the config check refuses is never started, and the link is printed" "rc $RC" "log: $(cat "$LOG")" "stderr: $ERR"
fi

# M5: an upgrade whose restart fails puts the previous binary and core back.
seed_root
KEEP_ROOT=1 run $PUBLIC_ARGS $URL
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-upgrade"
STUB_SYSTEMCTL_FAIL=restart KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
if [ "$RC" -ne 0 ] && cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/pre-upgrade" && cmp -s "$ROOT/usr/local/bin/dilla_core_wasi.wasm" "$REL/dilla_core_wasi.wasm" && has "$ERR" "rolled back"; then
	pass "a failed upgrade restart rolls the binary and the core back"
else
	fail "a failed upgrade restart rolls the binary and the core back" "rc $RC" "stderr: $ERR"
fi
if has "$(cat "$LOG")" "migrate down"; then
	fail "a failed restart that migrated nothing runs no down migration" "log: $(cat "$LOG")"
else
	pass "a failed restart that migrated nothing runs no down migration"
fi

# I1 (web3.6 review): the new binary's start migrated the database (16 -> 17) and then failed.
# The old binary refuses a schema newer than its own, so the rollback first takes the database
# back down with the NEW binary, which alone knows 00017's Down, with dilla stopped.
seed_root
KEEP_ROOT=1 run $PUBLIC_ARGS $URL
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-upgrade"
echo 16 >"$TMP/schema"
FAKE_SCHEMA="$TMP/schema" STUB_FAIL_V2=1 STUB_RESTART_MIGRATES_TO=17 KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
calls="$(cat "$LOG")"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want non-zero: the upgrade failed"
has "$ERR" "the previous release is running" || problems="$problems|stderr does not say the previous release is running"
[ "$(cat "$TMP/schema")" = 16 ] || problems="$problems|the database is at schema $(cat "$TMP/schema"), want 16"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/pre-upgrade" || problems="$problems|the previous binary is not back"
has "$calls" "systemctl stop dilla" || problems="$problems|dilla was not stopped before the down migration"
down="$(printf '%s\n' "$calls" | grep -n 'migrate down' | head -1 | cut -d: -f1)"
stop="$(line_of 'systemctl stop dilla')"
second="$(line_of 'systemctl start dilla')"
if [ -z "$down" ]; then
	problems="$problems|no down migration ran"
else
	has "$calls" "migrate down --to=16 --i-know-what-i-am-doing" || problems="$problems|the down migration is not --to=16 --i-know-what-i-am-doing"
	[ -n "$stop" ] && [ "$stop" -lt "$down" ] || problems="$problems|the down migration ran before dilla was stopped"
	[ -n "$second" ] && [ "$down" -lt "$second" ] || problems="$problems|the previous binary was started before the down migration"
fi
if [ -z "$problems" ]; then pass "a failed upgrade whose start migrated takes the database down before the previous binary starts"; else
	IFS='|'
	fail "a failed upgrade whose start migrated takes the database down before the previous binary starts" $problems "stderr: $ERR" "log: $calls"
	unset IFS
fi

# The same, but the down migration fails: the previous binary is never started on the newer
# schema; the new binary stays installed, and the operator is told what to do.
seed_root
KEEP_ROOT=1 run $PUBLIC_ARGS $URL
[ "$RC" -eq 0 ] || fail "the install before the failed-down case" "rc $RC" "stderr: $ERR"
echo 16 >"$TMP/schema"
FAKE_SCHEMA="$TMP/schema" FAKE_DOWN_FAIL=1 STUB_FAIL_V2=1 STUB_RESTART_MIGRATES_TO=17 KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
calls="$(cat "$LOG")"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want non-zero"
[ "$(count 'systemctl restart dilla')" -eq 1 ] || problems="$problems|dilla was restarted again after the down migration failed"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/fake-v2" || problems="$problems|the new binary was swapped out although the database is still at 17"
has "$ERR" "migrate down --to=16 --i-know-what-i-am-doing" || problems="$problems|stderr does not give the down-migration command"
has "$ERR" "pre-migration" || problems="$problems|stderr does not name the pre-migration backup"
has "$ERR" "dillad.prev" || problems="$problems|stderr does not say where the previous binary is"
if [ -z "$problems" ]; then pass "a failed down migration never starts the previous binary on the newer schema"; else
	IFS='|'
	fail "a failed down migration never starts the previous binary on the newer schema" $problems "stderr: $ERR" "log: $calls"
	unset IFS
fi

# ----------------------------------------- calls survive an upgrade (UP3) ----
# verdict NAME: pass, or fail with the problems collected in $problems, stderr and the call log.
verdict() {
	if [ -z "$problems" ]; then
		pass "$1"
		return 0
	fi
	old_ifs="$IFS"
	IFS='|'
	fail "$1" $problems "stderr: $ERR" "log: $(tr '\n' ';' <"$LOG")"
	IFS="$old_ifs"
}
# fresh RELEASE [proxy|public]: a new root with an instance installed from RELEASE.
fresh() {
	seed_root
	if [ "${2:-proxy}" = public ]; then
		KEEP_ROOT=1 run $PUBLIC_ARGS --release-url "file://$1"
	else
		KEEP_ROOT=1 run $PROXY_ARGS --release-url "file://$1"
	fi
	[ "$RC" -eq 0 ] || fail "the install from $1 before the next case" "rc $RC" "stderr: $ERR"
}
# stub_sys ARGS: systemctl as the stub models it, outside an install.sh run (a reboot, a crash).
stub_sys() { env PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" FAKE_LOG="$LOG" "$STUBS/systemctl" "$@"; }
# refresh: one run of the installed dilla-media-refresh, as its timer would; leaves RC and ERR
# (what it logged) and the calls in $LOG.
refresh() {
	: >"$LOG"
	RC=0
	env PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" FAKE_LOG="$LOG" \
		sh "$ROOT/usr/local/libexec/dilla-media-refresh" >"$TMP/out" 2>&1 || RC=$?
	ERR="$(cat "$TMP/out")"
}
# set_turn ENABLED LISTEN: [turn] enabled and listen in the instance's dilla.toml.
set_turn() {
	awk -v e="$1" -v l="$2" '
		/^\[/ { inside = ($0 == "[turn]") }
		inside && /^  enabled = / { $0 = "  enabled = " e }
		inside && /^  listen = / { $0 = "  listen = \047" l "\047" }
		{ print }
	' "$ROOT/etc/dilla/dilla.toml" >"$TMP/turn.toml"
	cat "$TMP/turn.toml" >"$ROOT/etc/dilla/dilla.toml"
}
media_pid_now() { cat "$ROOT/stub/media.pid" 2>/dev/null || echo 0; }
media_json() { [ ! -f "$ROOT/var/lib/dillad/media.json" ] || cat "$ROOT/var/lib/dillad/media.json"; }
# media_json_is VERSION: media.json is valid (its pid is the MainPID) and names VERSION.
media_json_is() {
	has "$(media_json)" "\"pid\":$(media_pid_now)," && has "$(media_json)" "\"version\":\"$1\""
}
# before LINE_A LINE_B: the first call LINE_A comes before the first LINE_B, and both happened.
before() {
	a="$(line_of "$1")"
	b="$(line_of "$2")"
	[ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]
}

# A web3.12 first install: the Type=notify media unit, the refresh units, and the timer enabled.
seed_root
EXPECT_BIN="$TMP/fake-v2" EXPECT_REL="$NEW" EXPECT_MEDIA_UNIT="$MEDIA_UNIT" KEEP_ROOT=1 run $PROXY_ARGS --release-url "file://$NEW"
EXPECT_BIN="$TMP/fake-v2" EXPECT_REL="$NEW" EXPECT_MEDIA_UNIT="$MEDIA_UNIT" check_common_install "a web3.12 install writes the notify media unit and the refresh units verbatim"
problems=""
has "$(cat "$LOG")" "systemctl enable --now dilla-media-refresh.timer" || problems="$problems|the refresh timer was not enabled"
media_json_is 0.1.0-web3.12 || problems="$problems|no valid media.json after the install: $(media_json)"
verdict "a first install enables dilla-media-refresh.timer"

# The new release refuses the installed dilla.toml (web3.6 refuses auth.methods without totp or
# passkey). With a compatible SFU only the API restarts, so the API rollback catches it: the
# previous API comes back, nothing migrated, and dilla-media is never touched.
fresh "$REL" public
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-upgrade"
echo 16 >"$TMP/schema"
pid_before="$(media_pid_now)"
FAKE_SCHEMA="$TMP/schema" FAKE_V2_CONFIG_FAIL=1 KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want non-zero: the upgrade failed"
has "$ERR" "the previous release is running" || problems="$problems|stderr does not say the previous release is running"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/pre-upgrade" || problems="$problems|the previous binary is not back"
[ "$(cat "$TMP/schema")" = 16 ] || problems="$problems|the database is at schema $(cat "$TMP/schema"), want 16"
has "$(cat "$LOG")" "migrate down" && problems="$problems|a down migration ran although the database never moved"
grep -q 'systemctl [a-z]* dilla-media$' "$LOG" && problems="$problems|dilla-media was touched"
[ "$(media_pid_now)" = "$pid_before" ] || problems="$problems|dilla-media's MainPID changed"
cmp -s "$ROOT/etc/systemd/system/dilla-media.service" "$TMP/dilla-media.simple.service" || problems="$problems|the media unit was not put back for the previous (web3.11) binary"
verdict "a compatible release that refuses the config is rolled back, and dilla-media is untouched"

# On the restart path dilla-media restarts first, so a release that refuses the config fails there,
# and the API is never restarted.
fresh "$REL" public
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-upgrade"
echo 16 >"$TMP/schema"
FAKE_SCHEMA="$TMP/schema" FAKE_V2_CONFIG_FAIL=1 KEEP_ROOT=1 run --upgrade --restart-sfu --release-url "file://$NEW"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want non-zero: the upgrade failed"
has "$ERR" "the media service did not start" || problems="$problems|stderr does not report the media readiness failure"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/pre-upgrade" || problems="$problems|the previous binary is not back"
[ "$(cat "$TMP/schema")" = 16 ] || problems="$problems|the database is at schema $(cat "$TMP/schema"), want 16"
[ "$(count 'systemctl restart dilla')" -eq 0 ] || problems="$problems|the old API was restarted unnecessarily"
before 'systemctl stop dilla-media' 'systemctl start dilla-media' || problems="$problems|dilla-media was not stopped and started on the previous binary"
verdict "a release whose media server does not come up never restarts the API"

# Compatible upgrade, live rooms, the level from the running executable (the installed web3.12,
# asked its own version --json): dilla once, dilla-media never.
fresh "$NEW"
pid_before="$(media_pid_now)"
FAKE_ROOMS="$TMP/rooms.live" KEEP_ROOT=1 run --upgrade --release-url "file://$C13"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
[ "$(count 'systemctl restart dilla')" -eq 1 ] || problems="$problems|dilla restarted $(count 'systemctl restart dilla') times, want 1"
[ "$(count 'systemctl restart dilla-media')" -eq 0 ] || problems="$problems|dilla-media was restarted"
[ "$(media_pid_now)" = "$pid_before" ] || problems="$problems|dilla-media's MainPID changed"
has "$ERR" "(media level 2, from the SHA-256 of $ROOT/proc/" && has "$ERR" "which is $ROOT/usr/local/bin/dillad)" || problems="$problems|the level did not come from the executable"
has "$(cat "$LOG")" "runuser -u dillad -- $ROOT/usr/local/bin/dillad version --json" || problems="$problems|the matched binary was not asked its version --json as dillad"
has "$(cat "$LOG")" "media --rooms" && problems="$problems|the live-call check ran"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/fake-c13" || problems="$problems|the binary was not replaced"
verdict "a compatible upgrade from web3.12 keeps the SFU, by its executable"

# What media.sock says, or whether it answers at all, does not move the decision.
fresh "$NEW"
FAKE_SELF_DOWN=1 KEEP_ROOT=1 run --upgrade --release-url "file://$C13"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
has "$ERR" "decision: keep" || problems="$problems|a silent media.sock changed the decision"
verdict "without a media.sock answer the executable still decides"
fresh "$NEW"
FAKE_SELF_BAD=1 KEEP_ROOT=1 run --upgrade --release-url "file://$C13"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
has "$ERR" "decision: keep" || problems="$problems|a hostile media.sock changed the decision"
has "$ERR" "touch /pwned" && problems="$problems|the hostile version was printed"
verdict "a hostile media.sock answer is never believed (keep path)"
# On the restart path a hostile media.sock never passes readiness.
fresh "$NEW"
FAKE_SELF_BAD=1 KEEP_ROOT=1 run --upgrade --restart-sfu --release-url "file://$C13"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|exit status 0: readiness passed against a hostile media.sock"
has "$ERR" "did not become ready on v0.1.0-web3.13" || problems="$problems|the readiness failure is not named"
[ ! -e /pwned ] || problems="$problems|/pwned exists"
verdict "a hostile media.sock answer never passes readiness"

# Incompatible upgrade with live rooms: refused, nothing changed; --restart-sfu: one restart each,
# dilla-media before dilla.
fresh "$NEW"
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-preflight"
cp "$ROOT/etc/dilla/dilla.toml" "$TMP/toml.pre-preflight"
FAKE_ROOMS="$TMP/rooms.live" KEEP_ROOT=1 run --upgrade --release-url "file://$I13"
problems="$(untouched)"
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want a refusal"
has "$ERR" "needs level 3 or later" || problems="$problems|the decision does not say why"
has "$ERR" "--restart-sfu" || problems="$problems|the override is not named"
verdict "an incompatible upgrade with live rooms is refused and changes nothing"
FAKE_ROOMS="$TMP/rooms.live" KEEP_ROOT=1 run --upgrade --restart-sfu --release-url "file://$I13"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
[ "$(count 'systemctl restart dilla-media')" -eq 1 ] || problems="$problems|dilla-media restarted $(count 'systemctl restart dilla-media') times, want 1"
[ "$(count 'systemctl restart dilla')" -eq 1 ] || problems="$problems|dilla restarted $(count 'systemctl restart dilla') times, want 1"
before 'systemctl restart dilla-media' 'systemctl restart dilla' || problems="$problems|dilla restarted before dilla-media"
has "$ERR" "continuing because of --restart-sfu" || problems="$problems|no warning about ending the live calls"
media_json_is 0.1.0-web3.13 || problems="$problems|media.json does not name the new binary: $(media_json)"
has "$ERR" "dilla and dilla-media run v0.1.0-web3.13" || problems="$problems|the report does not name the SFU's binary"
verdict "an incompatible upgrade with --restart-sfu restarts dilla-media, then dilla, once each"

# The restart path, and the API fails: the previous pair back, then dilla-media stopped and started
# on it, then dilla.
fresh "$NEW"
STUB_SYSTEMCTL_FAIL=restart KEEP_ROOT=1 run --upgrade --restart-sfu --release-url "file://$I13"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want a failure"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/fake-v2" || problems="$problems|the previous binary is not back"
has "$ERR" "the previous release is running" || problems="$problems|stderr does not say the previous release is running"
first_api="$(line_of 'systemctl restart dilla')"
stop_media="$(line_of 'systemctl stop dilla-media')"
start_media="$(line_of 'systemctl start dilla-media')"
second_api="$(line_of 'systemctl start dilla')"
[ -n "$first_api" ] && [ -n "$stop_media" ] && [ "$first_api" -lt "$stop_media" ] || problems="$problems|dilla-media was not stopped after the failed API restart"
[ -n "$start_media" ] && [ "$stop_media" -lt "$start_media" ] || problems="$problems|dilla-media was not started again after it was stopped"
[ -n "$second_api" ] && [ "$start_media" -lt "$second_api" ] || problems="$problems|dilla was started before dilla-media"
media_json_is 0.1.0-web3.12 || problems="$problems|dilla-media does not run the previous binary: $(media_json)"
verdict "the restart path's failed API restart restores .prev, then restarts dilla-media before dilla"

# The keep path, and the API fails: the rollback, and the SFU untouched.
fresh "$NEW"
pid_before="$(media_pid_now)"
STUB_SYSTEMCTL_FAIL=restart KEEP_ROOT=1 run --upgrade --release-url "file://$C13"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want a failure"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/fake-v2" || problems="$problems|the previous binary is not back"
has "$ERR" "rolled back" || problems="$problems|stderr does not say it rolled back"
grep -q 'systemctl [a-z]* dilla-media$' "$LOG" && problems="$problems|dilla-media was touched"
[ "$(media_pid_now)" = "$pid_before" ] || problems="$problems|dilla-media's MainPID changed"
verdict "a failed API restart on the keep path rolls back and leaves the SFU alone"

# serve exits 69 (api.sock, or dilla-media not reachable yet) and systemd's Restart=on-failure
# brings it up: the upgrade waits for that instead of rolling back.
fresh "$NEW"
STUB_API_RETRY_OK=1 KEEP_ROOT=1 run --upgrade --release-url "file://$C13"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
has "$ERR" "came up on systemd's restart" || problems="$problems|the wait for systemd's restart is not said"
has "$ERR" "rolled back" && problems="$problems|it rolled back"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/fake-c13" || problems="$problems|the new binary is not installed"
verdict "a first API start that exits 69 is retried by systemd, and the upgrade waits for it"

# A stale media.json (its pid is not the MainPID) is ignored. The SFU still runs web3.11, kept by
# the previous upgrade, so it is dillad.prev: the SHA-256 of its executable decides.
fresh "$REL"
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
printf '{"version":"0.1.0-web3.12","media_level":2,"capabilities":[],"pid":99999,"started":"2026-10-21T08:00:00Z"}\n' >"$ROOT/var/lib/dillad/media.json"
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
has "$ERR" "(media level 2" && problems="$problems|the stale file's level 2 was believed"
has "$ERR" "runs v0.1.0-web3.11 (media level 1, from the SHA-256 of $ROOT/proc/" && has "$ERR" "which is $ROOT/usr/local/bin/dillad.prev)" || problems="$problems|the level did not come from the executable's SHA-256 against dillad.prev"
has "$ERR" "decision: keep" || problems="$problems|a level-1 SFU was not kept for a release that works with level 1"
verdict "a stale media.json is ignored, and the executable's SHA-256 decides (keep)"
# Now dillad.prev is web3.12 too, so the running web3.11 matches nothing: unknown, so a restart,
# whatever the stale file claims.
printf '{"version":"0.1.0-web3.13","media_level":3,"capabilities":[],"pid":99999,"started":"2026-10-21T08:00:00Z"}\n' >"$ROOT/var/lib/dillad/media.json"
FAKE_ROOMS="$TMP/rooms.live" KEEP_ROOT=1 run --upgrade --release-url "file://$C13"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want a refusal"
has "$ERR" "media level is unknown" || problems="$problems|the stale file's level was believed"
verdict "a stale media.json is ignored, and an executable that matches nothing means a restart"

# Nothing reached through /proc is ever executed as root: a dillad process can execve a binary of
# its own and keep its pid. Here that binary would leave a marker if anything ran it.
cat >"$TMP/hostile-exe" <<HOSTILE
#!/bin/sh
touch "$TMP/hostile-ran"
echo "dillad 0.1.0-web3.11 (go1.25 linux/amd64)"
HOSTILE
chmod 0755 "$TMP/hostile-exe"
fresh "$NEW"
rm -f "$ROOT/var/lib/dillad/media.json" "$ROOT/stub/media.self" "$TMP/hostile-ran"
cp "$TMP/hostile-exe" "$ROOT/proc/$(media_pid_now)/exe.x"
mv -f "$ROOT/proc/$(media_pid_now)/exe.x" "$ROOT/proc/$(media_pid_now)/exe"
KEEP_ROOT=1 run --upgrade --release-url "file://$C13"
problems=""
[ ! -e "$TMP/hostile-ran" ] || problems="$problems|install.sh executed the running SFU's /proc/<pid>/exe"
has "$ERR" "media level is unknown" || problems="$problems|the level was not unknown"
has "$ERR" "decision: restart dilla-media" || problems="$problems|an unknown level did not mean a restart"
verdict "install.sh never executes /proc/<pid>/exe, and an unrecognised one is level unknown"
rm -f "$ROOT/var/lib/dillad/media.json" "$ROOT/stub/media.self" "$TMP/hostile-ran"
cp "$TMP/hostile-exe" "$ROOT/proc/$(media_pid_now)/exe.x"
mv -f "$ROOT/proc/$(media_pid_now)/exe.x" "$ROOT/proc/$(media_pid_now)/exe"
refresh
problems=""
[ ! -e "$TMP/hostile-ran" ] || problems="$problems|the refresh executed the running SFU's /proc/<pid>/exe"
has "$ERR" "runs another executable than the installed" || problems="$problems|the restart is not logged: $ERR"
verdict "dilla-media-refresh never executes /proc/<pid>/exe"

# Identity comes first (fix round 2). claim VERSION LEVEL: the running process says, on media.sock
# and in media.json, that it is VERSION, whatever executable it runs.
claim() {
	printf '{"version":"%s","media_level":%s,"capabilities":[],"pid":%s,"started":"2026-10-22T08:00:00Z"}\n' \
		"$1" "$2" "$(media_pid_now)" >"$ROOT/stub/media.self"
	cp "$ROOT/stub/media.self" "$ROOT/var/lib/dillad/media.json"
}
# An SFU on another executable that claims the installed release is still restarted.
fresh "$REL"
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
claim 0.1.0-web3.12 2
refresh
problems=""
[ "$(count 'systemctl restart dilla-media')" -eq 1 ] || problems="$problems|an SFU that lied about its version was not restarted"
has "$ERR" "runs another executable than the installed" && has "$ERR" "(it reports 0.1.0-web3.12)" || problems="$problems|the restart is not logged"
media_json_is 0.1.0-web3.12 && [ "$(stat -L -c %i "$ROOT/proc/$(media_pid_now)/exe")" = "$(stat -c %i "$ROOT/usr/local/bin/dillad")" ] || problems="$problems|dilla-media does not run the installed binary now"
verdict "refresh: an SFU that reports the installed version while running another executable is restarted"
# An SFU on the installed inode is not restarted, whatever it says about itself.
fresh "$NEW"
claim 0.1.0-web3.10 0
refresh
problems=""
grep -q '^systemctl restart' "$LOG" && problems="$problems|an SFU on the installed inode was restarted"
verdict "refresh: an SFU on the installed inode is not restarted, whatever it reports"
# install.sh: an SFU that claims a higher level than its executable is gets the executable's level.
fresh "$REL"
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
claim 0.1.0-web3.13 3
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-preflight"
cp "$ROOT/etc/dilla/dilla.toml" "$TMP/toml.pre-preflight"
FAKE_ROOMS="$TMP/rooms.live" KEEP_ROOT=1 run --upgrade --release-url "file://$I13"
problems="$(untouched)"
[ "$RC" -ne 0 ] || problems="$problems|exit status 0: the lie kept the SFU"
has "$ERR" "runs v0.1.0-web3.11 (media level 1, from the SHA-256 of" || problems="$problems|the level did not come from the executable"
has "$ERR" "needs level 3 or later" || problems="$problems|the decision does not say why"
verdict "install.sh: an SFU's own claim never outranks its executable's identity"

# Fix round 3. The level comes from the matched executable's own `version --json`, never from the
# report: an SFU on the installed web3.12 binary that claims level 3 is level 2.
fresh "$NEW"
claim 0.1.0-web3.12 3
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-preflight"
cp "$ROOT/etc/dilla/dilla.toml" "$TMP/toml.pre-preflight"
FAKE_ROOMS="$TMP/rooms.live" KEEP_ROOT=1 run --upgrade --release-url "file://$I13"
problems="$(untouched)"
[ "$RC" -ne 0 ] || problems="$problems|exit status 0: the claimed level 3 kept the SFU"
has "$ERR" "runs v0.1.0-web3.12 (media level 2, from the SHA-256 of" || problems="$problems|the level did not come from the executable's version --json"
has "$ERR" "needs level 3 or later" && has "$(cat "$LOG")" "media --rooms" || problems="$problems|no restart decision and preflight"
verdict "install.sh: the level is the matched executable's, not the SFU's claim"

# A FIFO where media.json belongs never hangs the installer or the refresh.
fresh "$NEW"
STUB_MEDIA_JSON_FIFO=1 RUN_TIMEOUT=120 KEEP_ROOT=1 run --upgrade --restart-sfu --release-url "file://$C13"
problems=""
[ "$RC" -ne 124 ] || problems="$problems|install.sh hung on a FIFO media.json"
[ "$RC" -ne 0 ] || problems="$problems|a media.json that is no regular file passed readiness"
has "$ERR" "did not become ready on v0.1.0-web3.13" || problems="$problems|the readiness failure is not named"
verdict "install.sh: a FIFO media.json is not read and fails readiness, without hanging"
fresh "$REL"
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
rm -f "$ROOT/var/lib/dillad/media.json"
mkfifo "$ROOT/var/lib/dillad/media.json"
: >"$LOG"
RC=0
env PATH="$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" FAKE_LOG="$LOG" FAKE_IDLE=1 \
	timeout 60 sh "$ROOT/usr/local/libexec/dilla-media-refresh" >"$TMP/out" 2>&1 || RC=$?
problems=""
[ "$RC" -ne 124 ] || problems="$problems|the refresh hung on a FIFO media.json"
verdict "refresh: a FIFO media.json is not read, without hanging"

# A deferred restart is recorded, by root, for the doctor: since when this media process has run
# another executable without being idle. The record is cleared once the SFU is restarted.
fresh "$REL"
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
PENDING_FILE="$ROOT/var/lib/dilla-media-refresh/pending"
FAKE_IDLE=1 refresh
problems=""
[ -f "$PENDING_FILE" ] || problems="$problems|no record of the deferred restart"
grep -qx "pid=$(media_pid_now) since=[0-9]*" "$PENDING_FILE" 2>/dev/null || problems="$problems|the record is not pid=<MainPID> since=<unix>: $(cat "$PENDING_FILE" 2>/dev/null)"
[ "$(mode_of "$PENDING_FILE")" = 644 ] && [ "$(mode_of "$ROOT/var/lib/dilla-media-refresh")" = 755 ] || problems="$problems|the record is not 0644 in a 0755 directory"
has "$ERR" "its restart waits until it is" || problems="$problems|the deferral is not logged"
cp "$PENDING_FILE" "$TMP/pending.first" 2>/dev/null || :
FAKE_IDLE=1 refresh
cmp -s "$PENDING_FILE" "$TMP/pending.first" || problems="$problems|a second busy minute moved the record"
[ -z "$ERR" ] || problems="$problems|a second busy minute logged again: $ERR"
refresh
[ ! -e "$PENDING_FILE" ] || problems="$problems|the record outlived the restart"
verdict "refresh: a deferred restart is recorded once for the doctor, and cleared by the restart"

# The readiness trap: the installed binary is new, but the process systemd runs after the restart
# is the old one. A probe run from the installed binary would pass; asking the running process does
# not, so the upgrade rolls back.
fresh "$NEW"
STUB_MEDIA_RUNS="$TMP/fake-v2" KEEP_ROOT=1 run --upgrade --restart-sfu --release-url "file://$I13"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|exit status 0: readiness passed for an SFU that runs the old binary"
has "$ERR" "did not become ready on v0.1.0-web3.13" || problems="$problems|the readiness failure is not named"
[ "$(count 'systemctl restart dilla')" -eq 0 ] || problems="$problems|the API was restarted onto an SFU that never proved itself"
has "$(cat "$LOG")" "media --probe" && problems="$problems|the installed binary's probe was asked"
verdict "readiness asks the running SFU: a new installed binary with an old running one does not pass"
fresh "$NEW"
STUB_MEDIA_RUNS="$TMP/fake-v2" KEEP_ROOT=1 run --upgrade --release-url "file://$REL"
problems=""
[ "$RC" -ne 0 ] || problems="$problems|exit status 0: readiness passed for an SFU that runs the old binary"
has "$ERR" "did not become ready on v0.1.0-web3.11" || problems="$problems|the readiness failure is not named"
verdict "readiness for a web3.11 target checks the running executable before its probe"

# A web3.10 SFU has no rule that names its level, so it is restarted.
fresh "$W10"
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
has "$ERR" "media level is unknown (0.1.0-web3.10" || problems="$problems|the unknown level is not said"
[ "$(count 'systemctl restart dilla-media')" -eq 1 ] || problems="$problems|dilla-media was not restarted once"
before 'systemctl restart dilla-media' 'systemctl restart dilla' || problems="$problems|dilla restarted before dilla-media"
verdict "an SFU older than web3.11 needs a restart"

# --restart-sfu on a compatible release.
fresh "$NEW"
KEEP_ROOT=1 run --upgrade --restart-sfu --release-url "file://$C13"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
has "$ERR" "decision: restart dilla-media, which ends any live call: --restart-sfu was given" || problems="$problems|the decision is not logged"
[ "$(count 'systemctl restart dilla-media')" -eq 1 ] && [ "$(count 'systemctl restart dilla')" -eq 1 ] || problems="$problems|not one restart each"
before 'systemctl restart dilla-media' 'systemctl restart dilla' || problems="$problems|dilla restarted before dilla-media"
verdict "--restart-sfu restarts a compatible SFU, once, before dilla"

# ------------------------------------------------------- release.json ----
RJSUM="$TMP/rj-sum"
make_release "$RJSUM" "$TMP/fake-v2"
printf ' ' >>"$RJSUM/release.json"
fresh "$REL"
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-preflight"
cp "$ROOT/etc/dilla/dilla.toml" "$TMP/toml.pre-preflight"
KEEP_ROOT=1 run --upgrade --release-url "file://$RJSUM"
problems="$(untouched)"
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want a refusal"
has "$ERR" "checksum mismatch" || problems="$problems|the mismatch is not named"
verdict "a release.json that does not match its SHA256SUMS line is refused"

RJLIE="$TMP/rj-lie"
make_release "$RJLIE" "$TMP/fake-v2"
sed -i 's/"min_sfu_media_level":1/"min_sfu_media_level":0/' "$RJLIE/release.json"
(cd "$RJLIE" && sha256sum dillad-linux-amd64 dillad-linux-arm64 dilla_core_wasi.wasm install.sh release.json >SHA256SUMS)
KEEP_ROOT=1 run --upgrade --release-url "file://$RJLIE"
problems="$(untouched)"
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want a refusal"
has "$ERR" "release.json says min_sfu_media_level is 0, but the new dillad says 1" || problems="$problems|the disagreement is not named"
verdict "a release.json that disagrees with the binary's version --json is refused"

RJNONE="$TMP/rj-none"
make_release "$RJNONE" "$TMP/fake-v2"
grep -v ' release.json$' "$RJNONE/SHA256SUMS" >"$RJNONE/SHA256SUMS.new"
mv "$RJNONE/SHA256SUMS.new" "$RJNONE/SHA256SUMS"
KEEP_ROOT=1 run --upgrade --release-url "file://$RJNONE"
problems="$(untouched)"
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want a refusal"
has "$ERR" "has no release.json in its SHA256SUMS" || problems="$problems|the missing release.json is not named"
verdict "a web3.12 release whose SHA256SUMS does not list release.json is refused"

KEEP_ROOT=1 run --upgrade --binary "$NEW/dillad-linux-amd64" --core "$NEW/dilla_core_wasi.wasm" --sums "$NEW/SHA256SUMS"
expect_refusal "--binary with a SHA256SUMS that lists release.json needs --release-json" "--release-json"
KEEP_ROOT=1 run --upgrade --binary "$NEW/dillad-linux-amd64" --core "$RJNONE/dilla_core_wasi.wasm" --sums "$RJNONE/SHA256SUMS"
expect_refusal "--binary of web3.12 without release.json is refused" "--release-json"
KEEP_ROOT=1 run --upgrade --binary "$NEW/dillad-linux-amd64" --core "$NEW/dilla_core_wasi.wasm" --sums "$NEW/SHA256SUMS" --release-json "$NEW/release.json"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
has "$ERR" "verified dillad-linux-amd64 dilla_core_wasi.wasm release.json against SHA256SUMS" || problems="$problems|release.json was not verified against --sums"
has "$ERR" "decision: keep" || problems="$problems|the SFU was not kept"
verdict "--binary --release-json FILE verifies release.json and decides by it"
run --upgrade --release-json "$NEW/release.json" --release-url "file://$NEW"
expect_refusal "--release-json without --binary is refused" "--release-json is for --binary"

# ------------------------------------------------- CAP_NET_BIND_SERVICE ----
fresh "$REL"
set_turn true ':3478'
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
cmp -s "$ROOT/etc/systemd/system/dilla-media.service" "$MEDIA_UNIT" || problems="$problems|the unit for turn.listen :3478 is not deploy/dilla-media.service"
grep -q '^AmbientCapabilities=' "$ROOT/etc/systemd/system/dilla-media.service" && problems="$problems|a capability was added for port 3478"
verdict "turn.listen on 3478 adds no capability to dilla-media.service"
set_turn true '0.0.0.0:443'
KEEP_ROOT=1 run --upgrade --release-url "file://$C13"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
grep -qx 'AmbientCapabilities=CAP_NET_BIND_SERVICE' "$ROOT/etc/systemd/system/dilla-media.service" || problems="$problems|no AmbientCapabilities=CAP_NET_BIND_SERVICE"
grep -qx 'CapabilityBoundingSet=CAP_NET_BIND_SERVICE' "$ROOT/etc/systemd/system/dilla-media.service" || problems="$problems|no CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
verdict "turn.listen on 443 behind a proxy adds CAP_NET_BIND_SERVICE to dilla-media.service"

# ------------------------------------------------- rollback below web3.12 ----
# The web3.12 SFU holds turn.listen, and web3.11's serve would bind it too: dilla-media stops first.
fresh "$NEW"
set_turn true ':3478'
stub_sys restart dilla-media >/dev/null
stub_sys restart dilla >/dev/null
KEEP_ROOT=1 run --upgrade --release-url "file://$REL"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
has "$ERR" "stopping dilla-media first, which ends every live call" || problems="$problems|it does not say it ends calls"
before 'systemctl stop dilla-media' 'systemctl start dilla-media' || problems="$problems|dilla-media was not stopped, then started"
before 'systemctl start dilla-media' 'systemctl restart dilla' || problems="$problems|dilla started before dilla-media was stopped and started"
[ "$(count 'systemctl restart dilla-media')" -eq 0 ] || problems="$problems|dilla-media was restarted as well"
cmp -s "$ROOT/etc/systemd/system/dilla-media.service" "$TMP/dilla-media.simple.service" || problems="$problems|the media unit is not web3.11's Type=simple"
has "$(cat "$LOG")" "systemctl disable --now dilla-media-refresh.timer" || problems="$problems|the refresh timer stays on for web3.11"
verdict "a rollback to web3.11 with a web3.12 SFU stops dilla-media before it starts dilla"

fresh "$NEW" public
set_turn true ':5349'
cp "$ROOT/usr/local/bin/dillad" "$TMP/pre-preflight"
cp "$ROOT/etc/dilla/dilla.toml" "$TMP/toml.pre-preflight"
KEEP_ROOT=1 run --upgrade --yes --release-url "file://$REL"
problems="$(untouched)"
[ "$RC" -ne 0 ] || problems="$problems|exit status 0, want a refusal"
has "$ERR" "remove turn.listen from dilla.toml first; public-mode TURN goes back to 443" || problems="$problems|the key is not named"
verdict "a rollback to web3.11 with the public-mode turn.listen set is refused and changes nothing"

# ------------------------------------------------- dilla-media-refresh ----
fresh "$NEW"
refresh
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
grep -q '^systemctl restart' "$LOG" && problems="$problems|something was restarted"
[ -z "$ERR" ] || problems="$problems|a minute with nothing to do logged: $ERR"
verdict "refresh: the SFU runs the installed inode, so nothing is restarted"

fresh "$REL"
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
FAKE_IDLE=1 refresh
problems=""
grep -q '^systemctl restart' "$LOG" && problems="$problems|restarted although rooms are busy"
has "$(cat "$LOG")" "runuser -u dillad -- $ROOT/usr/local/bin/dillad media --idle --config=$ROOT/etc/dilla/dilla.toml" || problems="$problems|media --idle was not asked as dillad"
verdict "refresh: another inode but busy rooms: no restart"
FAKE_IDLE=69 refresh
problems=""
grep -q '^systemctl restart' "$LOG" && problems="$problems|restarted although --idle could not tell"
verdict "refresh: media --idle exits 69: no restart"
refresh
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
[ "$(count 'systemctl restart dilla-media')" -eq 1 ] || problems="$problems|dilla-media restarted $(count 'systemctl restart dilla-media') times, want 1"
[ "$(count 'systemctl restart dilla')" -eq 0 ] || problems="$problems|dilla restarted without a TURN handoff"
has "$ERR" "runs another executable than the installed" && has "$ERR" "its rooms are idle: restarting it" || problems="$problems|the restart is not logged"
media_json_is 0.1.0-web3.12 || problems="$problems|dilla-media does not run the installed binary: $(media_json)"
verdict "refresh: another inode and idle: one restart, logged"
refresh
problems=""
grep -q '^systemctl restart' "$LOG" && problems="$problems|restarted again"
verdict "refresh: after its restart the next minute finds nothing to do"

# The TURN handoff: web3.11's API holds turn.listen, the kept web3.11 SFU has none.
fresh "$REL"
set_turn true ':3478'
stub_sys restart dilla >/dev/null
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
[ -e "$ROOT/stub/api.turn" ] || fail "the handoff case starts with dilla holding turn.listen"
refresh
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC"
[ "$(count 'systemctl restart dilla-media')" -eq 1 ] && [ "$(count 'systemctl restart dilla')" -eq 1 ] || problems="$problems|not one restart each"
before 'systemctl restart dilla-media' 'systemctl restart dilla' || problems="$problems|dilla restarted before dilla-media"
has "$(media_json)" '"capabilities":["turn"]' || problems="$problems|media.json does not list turn: $(media_json)"
has "$ERR" "TURN handoff done" || problems="$problems|the handoff is not logged"
[ "$(cat "$ROOT/run/dilla-media-refresh.handoff" 2>/dev/null)" = "$(media_pid_now)" ] || problems="$problems|the handoff did not mark this media process"
verdict "refresh: the TURN handoff restarts dilla-media, then dilla, and waits for turn"
KEEP_ROOT=1 run --upgrade --release-url "file://$C13"
refresh
problems=""
[ "$(count 'systemctl restart dilla-media')" -eq 1 ] || problems="$problems|dilla-media was not restarted"
[ "$(count 'systemctl restart dilla')" -eq 0 ] || problems="$problems|dilla was restarted between two TURN-serving binaries"
has "$(media_json)" '"capabilities":["turn"]' || problems="$problems|media.json does not list turn: $(media_json)"
verdict "refresh: between two TURN-serving binaries dilla is not restarted"

# An SFU crash after a compatible upgrade: systemd starts it on the new binary while dilla still
# holds turn.listen. The refresh hands TURN over once, when idle, by restarting dilla alone.
fresh "$REL"
set_turn true ':3478'
stub_sys restart dilla >/dev/null
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
stub_sys restart dilla-media >/dev/null
refresh
problems=""
[ "$(count 'systemctl restart dilla-media')" -eq 0 ] || problems="$problems|dilla-media was restarted"
[ "$(count 'systemctl restart dilla')" -eq 1 ] || problems="$problems|dilla was not restarted once"
has "$(media_json)" '"capabilities":["turn"]' || problems="$problems|media.json does not list turn: $(media_json)"
verdict "refresh: an SFU that came up on the new binary without TURN gets it at the next idle minute"

# A reboot of a mixed pair: the SFU on web3.11 with a stale media.json, web3.12 on disk. Both units
# start from the one installed binary, the new process writes media.json, and the refresh service
# then finds nothing to do.
fresh "$REL"
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
printf '{"version":"0.1.0-web3.12","media_level":2,"capabilities":[],"pid":99999,"started":"2026-10-21T08:00:00Z"}\n' >"$ROOT/var/lib/dillad/media.json"
rm -rf "${ROOT:?}/proc" "$ROOT/stub/media.pid" "$ROOT/stub/dilla.state" "$ROOT/stub/api.turn"
: >"$LOG"
stub_sys start dilla-media
stub_sys start dilla
problems=""
[ "$(stat -L -c %i "$ROOT/proc/$(media_pid_now)/exe")" = "$(stat -c %i "$ROOT/usr/local/bin/dillad")" ] || problems="$problems|dilla-media did not come up on the installed binary"
media_json_is 0.1.0-web3.12 || problems="$problems|media.json was not rewritten by the new process: $(media_json)"
grep -q '^After=.*dilla-media.service' "$UNIT" || problems="$problems|dilla.service does not start after dilla-media"
refresh
grep -q '^systemctl restart' "$LOG" && problems="$problems|the refresh restarted something after the reboot"
verdict "a reboot of a mixed pair comes up on web3.12 alone, and the refresh finds nothing to do"

# --------------------------------------------------- the real dillad init ----
if [ -n "${DILLA_TEST_DILLAD:-}" ]; then
	REAL="$TMP/real-release"
	make_release "$REAL" "$DILLA_TEST_DILLAD"
	for mode in proxy public; do
		seed_root
		if [ "$mode" = proxy ]; then
			# shellcheck disable=SC2086
			STUB_MEDIA_PROBE_SUCCESS=1 KEEP_ROOT=1 run $PROXY_ARGS --node-ip 203.0.113.10 --release-url "file://$REAL"
		else
			# shellcheck disable=SC2086
			STUB_MEDIA_PROBE_SUCCESS=1 KEEP_ROOT=1 run $PUBLIC_ARGS --udp-port 7999 --release-url "file://$REAL"
		fi
		# The fake core fails the wasi leg; the config leg is what this checks.
		if has "$ERR" "OK    config" && has "$OUT" "https://chat.example.org/i/"; then
			pass "real dillad ($mode): the edited dilla.toml passes doctor's config leg"
		else
			fail "real dillad ($mode): the edited dilla.toml passes doctor's config leg" "out: $OUT" "stderr: $ERR"
		fi
	done
else
	echo "skip real dillad: set DILLA_TEST_DILLAD to a dillad binary to run init and doctor's config leg for real"
fi

# ----------------------------------------------------------- shellcheck ----
if command -v shellcheck >/dev/null 2>&1; then
	if out="$(shellcheck -s sh "$INSTALL" 2>&1)"; then pass "shellcheck install.sh"; else fail "shellcheck install.sh" "$out"; fi
	if out="$(shellcheck "$HERE/proxmox-lxc.sh" 2>&1)"; then pass "shellcheck proxmox-lxc.sh"; else fail "shellcheck proxmox-lxc.sh" "$out"; fi
	if out="$(shellcheck -s sh "$HERE/dilla-media-refresh.sh" 2>&1)"; then pass "shellcheck dilla-media-refresh.sh"; else fail "shellcheck dilla-media-refresh.sh" "$out"; fi
else
	echo "skip shellcheck: not installed"
fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
