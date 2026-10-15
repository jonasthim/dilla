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
stub systemctl 'echo "systemctl $*" >>"'"$LOG"'"; [ -z "${STUB_SYSTEMCTL_FAIL:-}" ] || exit 1
# With FAKE_SCHEMA (a file holding the database schema version), a restart models dillad serve:
# the new release (fake v2) migrates to STUB_RESTART_MIGRATES_TO at start and then fails when
# STUB_FAIL_V2 is set; the old one (v1, highest migration 16) refuses a newer schema.
if [ "$1" = restart ] && [ -n "${FAKE_SCHEMA:-}" ]; then
	if grep -q "^# fake dillad v2 for" "${DILLA_INSTALL_ROOT:-}/usr/local/bin/dillad"; then
		[ -z "${STUB_RESTART_MIGRATES_TO:-}" ] || echo "$STUB_RESTART_MIGRATES_TO" >"$FAKE_SCHEMA"
		[ -z "${STUB_FAIL_V2:-}" ] || exit 1
	elif [ "$(cat "$FAKE_SCHEMA")" -gt 16 ]; then
		echo "serve: database schema $(cat "$FAKE_SCHEMA") is newer than this binary'"'"'s highest migration 16: refusing to start" >&2
		exit 1
	fi
fi
exit 0'
# runuser -u dillad -- cmd args: run cmd args.
stub runuser 'echo "runuser $*" >>"'"$LOG"'"; while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift; exec "$@"'

# The fake dillad. $1 is the verb.
FAKE="$TMP/fake-dillad"
cat >"$FAKE" <<'FAKE'
#!/bin/sh
# fake dillad for deploy/install_test.sh
echo "dillad $*" >>"${FAKE_LOG:?}"
verb="$1"
shift
case "$verb" in
init)
	for a in "$@"; do
		case "$a" in
		--data-dir=*) dir="${a#*=}" ;;
		--domain=*) domain="${a#*=}" ;;
		--public-ip=*) ip="${a#*=}" ;;
		esac
	done
	[ -e "$dir/dilla.toml" ] && { echo "init: $dir/dilla.toml already exists" >&2; exit 73; }
	mkdir -p "$dir"
	chmod 0700 "$dir"
	printf 'secret-turn-0123456789abcdef0123456789abcdef' >"$dir/turn.secret"
	printf 'secret-livekit-0123456789abcdef0123456789ab' >"$dir/livekit.secret"
	chmod 0600 "$dir/turn.secret" "$dir/livekit.secret"
	cat >"$dir/dilla.toml" <<EOF
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
	chmod 0600 "$dir/dilla.toml"
	if [ -n "${FAKE_INIT_BAD:-}" ]; then
		# A layout install.sh does not know: no livekit.udp_port.
		grep -v 'udp_port' "$dir/dilla.toml" >"$dir/dilla.toml.x"
		cat "$dir/dilla.toml.x" >"$dir/dilla.toml"
		rm -f "$dir/dilla.toml.x"
	fi
	echo "dillad init: wrote $dir/dilla.toml"
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
version) echo "dillad fake ${FAKE_VERSION:-1}" ;;
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

# A release directory: the three assets under their release names, and SHA256SUMS.
# make_release DIR [BINARY]
make_release() {
	mkdir -p "$1"
	cp "${2:-$FAKE}" "$1/dillad-linux-amd64"
	cp "${2:-$FAKE}" "$1/dillad-linux-arm64"
	printf '\0asm fake core %s\n' "$1" >"$1/dilla_core_wasi.wasm"
	cp "$INSTALL" "$1/install.sh" 2>/dev/null || : >"$1/install.sh"
	(cd "$1" && sha256sum dillad-linux-amd64 dillad-linux-arm64 dilla_core_wasi.wasm install.sh >SHA256SUMS)
}

REL="$TMP/release"
make_release "$REL"

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
	RC=0
	env PATH="${EXTRA_PATH:+$EXTRA_PATH:}$STUBS:$PATH" DILLA_INSTALL_ROOT="$ROOT" FAKE_LOG="$LOG" \
		sh "${RUN_SCRIPT:-$INSTALL}" "$@" >"$TMP/out" 2>"$TMP/err" || RC=$?
	OUT="$(cat "$TMP/out")"
	ERR="$(cat "$TMP/err")"
}

mode_of() { stat -c %a "$1" 2>/dev/null || echo missing; }
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
	cmp -s "$ROOT/usr/local/bin/dillad" "$FAKE" || problems="$problems|/usr/local/bin/dillad is not the release binary"
	cmp -s "$ROOT/usr/local/bin/dilla_core_wasi.wasm" "$REL/dilla_core_wasi.wasm" || problems="$problems|the core is not beside the binary"
	cmp -s "$ROOT/etc/systemd/system/dilla.service" "$UNIT" || problems="$problems|the installed unit differs from deploy/dilla.service"
	[ "$(mode_of "$ROOT/etc/dilla/dilla.toml")" = 640 ] || problems="$problems|dilla.toml mode $(mode_of "$ROOT/etc/dilla/dilla.toml"), want 640"
	[ "$(mode_of "$ROOT/var/lib/dillad")" = 700 ] || problems="$problems|/var/lib/dillad mode $(mode_of "$ROOT/var/lib/dillad"), want 700"
	[ "$(mode_of "$ROOT/usr/local/bin/dillad")" = 755 ] || problems="$problems|dillad mode $(mode_of "$ROOT/usr/local/bin/dillad"), want 755"
	[ ! -e "$ROOT/var/lib/dillad/dilla.toml" ] || problems="$problems|init's dilla.toml was left in the data directory"
	calls="$(cat "$LOG")"
	has "$calls" "useradd --system --user-group --no-create-home --home-dir /var/lib/dillad --shell /usr/sbin/nologin dillad" || problems="$problems|no dillad system user was created"
	has "$calls" "chown root:dillad $ROOT/etc/dilla/dilla.toml" || problems="$problems|dilla.toml is not root:dillad"
	has "$calls" "chown -R dillad:dillad $ROOT/var/lib/dillad" || problems="$problems|the data directory is not dillad's"
	has "$calls" "systemctl daemon-reload" || problems="$problems|no daemon-reload"
	has "$calls" "systemctl enable --now dilla" || problems="$problems|the service was not enabled and started"
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
NEW="$TMP/new-release"
sed 's/^# fake dillad for/# fake dillad v2 for/' "$FAKE" >"$TMP/fake-v2"
chmod 0755 "$TMP/fake-v2"
make_release "$NEW" "$TMP/fake-v2"
ls -la "$ROOT/var/lib/dillad" >"$TMP/data.before" 2>&1 || :
KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
problems=""
[ "$RC" -eq 0 ] || problems="$problems|exit status $RC: $ERR"
[ -z "$OUT" ] || problems="$problems|stdout = \"$OUT\", want nothing on an upgrade"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/fake-v2" || problems="$problems|the binary was not replaced"
cmp -s "$ROOT/usr/local/bin/dilla_core_wasi.wasm" "$NEW/dilla_core_wasi.wasm" || problems="$problems|the core was not replaced"
cmp -s "$T" "$TMP/toml.before" || problems="$problems|the upgrade changed dilla.toml"
ls -la "$ROOT/var/lib/dillad" >"$TMP/data.after" 2>&1 || :
cmp -s "$TMP/data.before" "$TMP/data.after" || problems="$problems|the upgrade changed the data directory"
has "$(cat "$LOG")" "dillad init" && problems="$problems|the upgrade ran init"
has "$(cat "$LOG")" "systemctl restart dilla" || problems="$problems|the upgrade did not restart dilla"
has "$(cat "$LOG")" "doctor --config=" || problems="$problems|the upgrade did not run doctor"
if [ -z "$problems" ]; then pass "--upgrade replaces only the binary and the core, restarts and runs doctor"; else
	IFS='|'
	# shellcheck disable=SC2086
	fail "--upgrade replaces only the binary and the core, restarts and runs doctor" $problems
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
STUB_SYSTEMCTL_FAIL=1 KEEP_ROOT=1 run --upgrade --release-url "file://$NEW"
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
stop="$(printf '%s\n' "$calls" | grep -n 'systemctl stop dilla' | head -1 | cut -d: -f1)"
second="$(printf '%s\n' "$calls" | grep -n 'systemctl restart dilla' | sed -n 2p | cut -d: -f1)"
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
[ "$(printf '%s\n' "$calls" | grep -c 'systemctl restart dilla')" -eq 1 ] || problems="$problems|dilla was restarted again after the down migration failed"
cmp -s "$ROOT/usr/local/bin/dillad" "$TMP/fake-v2" || problems="$problems|the new binary was swapped out although the database is still at 17"
has "$ERR" "migrate down --to=16 --i-know-what-i-am-doing" || problems="$problems|stderr does not give the down-migration command"
has "$ERR" "pre-migration" || problems="$problems|stderr does not name the pre-migration backup"
has "$ERR" "dillad.prev" || problems="$problems|stderr does not say where the previous binary is"
if [ -z "$problems" ]; then pass "a failed down migration never starts the previous binary on the newer schema"; else
	IFS='|'
	fail "a failed down migration never starts the previous binary on the newer schema" $problems "stderr: $ERR" "log: $calls"
	unset IFS
fi

# --------------------------------------------------- the real dillad init ----
if [ -n "${DILLA_TEST_DILLAD:-}" ]; then
	REAL="$TMP/real-release"
	make_release "$REAL" "$DILLA_TEST_DILLAD"
	for mode in proxy public; do
		seed_root
		if [ "$mode" = proxy ]; then
			# shellcheck disable=SC2086
			KEEP_ROOT=1 run $PROXY_ARGS --node-ip 203.0.113.10 --release-url "file://$REAL"
		else
			# shellcheck disable=SC2086
			KEEP_ROOT=1 run $PUBLIC_ARGS --udp-port 7999 --release-url "file://$REAL"
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
else
	echo "skip shellcheck: not installed"
fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
