#!/bin/sh
# Installs dillad on a Debian 13 host, LXC container or VM, as the systemd
# service of docs/deploy/README.md §3, without Docker. Run it as root.
#
# Take this file from a release (releases/download/<tag>/install.sh): the
# release stamps its own tag into DILLA_RELEASE_TAG below, so it installs that
# release by default. A copy straight from git is unstamped and needs
# --version <tag> or --release-url <url>.
#
#   behind a TLS-terminating proxy (Pangolin, Traefik, Caddy, nginx):
#     sh install.sh --behind-proxy --domain chat.example.org \
#       --listen 0.0.0.0:8080 --trusted-proxy 10.0.0.5/32 --public-ip 203.0.113.10
#   reachable from the internet on 443/tcp itself:
#     sh install.sh --public --domain chat.example.org \
#       --public-ip 203.0.113.10 --agree-tos
#   a newer release over an installed instance:
#     sh install.sh --upgrade --version <tag>
#
# stdout carries exactly one thing: the bootstrap invite link, printed once at
# the end of a first install, so `link=$(sh install.sh ...)` captures it and
# nothing else. Every progress line, every command's output and every warning
# goes to stderr. The instance keys and the TURN and LiveKit secrets never
# leave the files dillad init writes them to.
#
# DILLA_INSTALL_ROOT, when set, prefixes every path the script writes or
# checks; deploy/install_test.sh uses it to run the install in a temporary
# directory with stubs for useradd, chown, systemctl and runuser.
set -eu

# The release this copy installs by default. release.yml rewrites this exact
# line to the tag it publishes; leave it empty in git.
DILLA_RELEASE_TAG=""

LINK=""
LINK_PRINTED=0
POST_INIT=0
WORK=""

log() { printf 'install: %s\n' "$*" >&2; }
die() {
	log "error: $*"
	if [ "$POST_INIT" -eq 1 ]; then
		log "the instance is half-installed: init ran, so its invite link is printed below, once."
		log "to start over: systemctl disable --now dilla; rm -rf /var/lib/dillad /etc/dilla/dilla.toml; then run install.sh again"
	fi
	exit 1
}

# On any exit after init, the link is printed once: init consumed it, and the
# database holds only its hash.
# shellcheck disable=SC2317,SC2329 # invoked by the EXIT trap below (SC2317 on older shellcheck)
on_exit() {
	[ -z "$WORK" ] || rm -rf "$WORK"
	if [ -n "$LINK" ] && [ "$LINK_PRINTED" -eq 0 ]; then
		LINK_PRINTED=1
		printf '%s\n' "$LINK"
	fi
}
trap on_exit EXIT

usage() {
	cat >&2 <<'USAGE'
usage: install.sh --behind-proxy --domain NAME --listen ADDR:PORT --trusted-proxy CIDR... (--public-ip IP | --node-ip IP | --no-media-ip) [options]
       install.sh --public --domain NAME --public-ip IP --agree-tos [options]
       install.sh --upgrade [--restart-sfu] [--version TAG] [--release-url URL] [--binary FILE --core FILE --sums FILE --release-json FILE]

Installs dillad as the systemd service `dilla`: the user dillad, /usr/local/bin/dillad
with dilla_core_wasi.wasm beside it, /var/lib/dillad (0700) and /etc/dilla/dilla.toml
(0640 root:dillad). Prints the bootstrap invite link once, on stdout.

modes (exactly one):
  --behind-proxy         a reverse proxy terminates TLS (tls.mode = "behind_proxy");
                         TURN stays off
    --domain NAME        the public DNS name of the instance (instance.domain)
    --listen ADDR:PORT   the plain HTTP listener the proxy reaches (server.plain_listen)
    --trusted-proxy CIDR the proxy's own address, as narrow as you can (a /32);
                         repeatable (server.trusted_proxy_cidrs)
    --public-ip IP       the address clients send UDP --udp-port to (with Pangolin, the
                         Pangolin server's): instance.public_ip, and livekit.node_ip
                         unless --node-ip
    --no-media-ip        install without either; calls cannot reach the SFU from
                         outside this host until livekit.node_ip is set
  --public               dillad terminates TLS on 443/tcp (tls.mode = "acme_tls_alpn")
    --domain NAME        the public DNS name of the instance (instance.domain)
    --public-ip IP       the address clients reach the instance on (instance.public_ip)
    --agree-tos          accept the ACME CA's subscriber agreement (tls.agreed)
  --upgrade              replace the binary and core, restart the API and run doctor; rolls
                         back a failed API restart. When the release's release.json says it
                         works with the running media server (dilla-media), only the API
                         restarts and live calls continue; dilla-media-refresh.timer moves
                         dilla-media onto the new binary once its calls have ended.
                         Otherwise dilla-media restarts too, first, which ends every live
                         call: the upgrade then runs `dillad media --rooms` and refuses,
                         changing nothing, if a room has participants or the check cannot
                         be made. Migrates livekit.mode from in_process to sidecar once,
                         saving dilla.toml.prev (that ends calls, and needs --yes)
    --restart-sfu        restart dilla-media now as well, ending any live calls
    --yes                end live calls where the upgrade must: the in_process migration, and
                         (for this release, as an alias of --restart-sfu) the live-call check

options:
  --version TAG          the release to install, e.g. v0.1.0 (default: the tag this copy
                         was released with; a copy from git has none)
  --release-url URL      where the release assets are downloaded from (default:
                         https://github.com/jonasthim/dilla/releases/download/TAG)
  --binary FILE          use this dillad binary instead of downloading one
  --core FILE            use this dilla_core_wasi.wasm instead of downloading one
  --sums FILE            the SHA256SUMS to check --binary and --core (and any download) against
  --release-json FILE    with --binary: the release's release.json, checked against --sums and
                         against the binary (a download fetches it when SHA256SUMS lists it)
  --insecure-skip-verify install local --binary/--core without a --sums check
  --udp-port N           LiveKit's media port (livekit.udp_port, default 7882)
  --node-ip IP           the address LiveKit advertises for media (livekit.node_ip)
  --check-args           validate the arguments and exit without changing anything
  -h, --help             show this help
USAGE
}

MODE=""
UPGRADE=0
ASSUME_YES=0
RESTART_SFU=0
RELEASE_JSON=""
CHECK_ARGS=0
DOMAIN=""
PUBLIC_IP=""
AGREE_TOS=0
LISTEN=""
TRUSTED=""
VERSION=""
RELEASE_URL=""
URL_TAG=""
BINARY=""
CORE=""
SUMS=""
INSECURE=0
NO_MEDIA_IP=0
UDP_PORT="7882"
NODE_IP=""
SET_MODE_FLAGS=""

set_mode() {
	if [ -n "$MODE" ] && [ "$MODE" != "$1" ]; then
		die "give only one of --behind-proxy and --public"
	fi
	MODE="$1"
}
# Flags that only a first install reads; --upgrade refuses them.
saw() { SET_MODE_FLAGS="$SET_MODE_FLAGS $1"; }

# Flags take their value as "--flag value" or "--flag=value".
while [ "$#" -gt 0 ]; do
	flag="$1"
	value=""
	case "$flag" in
	--*=*)
		value="${flag#*=}"
		flag="${flag%%=*}"
		shift
		;;
	--behind-proxy | --public | --agree-tos | --upgrade | --yes | --restart-sfu | --check-args | --insecure-skip-verify | --no-media-ip | -h | --help)
		shift
		;;
	--domain | --public-ip | --listen | --trusted-proxy | --udp-port | --node-ip | --version | --release-url | --binary | --core | --sums | --release-json)
		[ "$#" -ge 2 ] || die "$flag needs a value"
		value="$2"
		shift 2
		;;
	-*)
		usage
		die "unknown option $flag"
		;;
	*)
		usage
		die "unexpected argument $flag"
		;;
	esac
	case "$flag" in
	--behind-proxy)
		set_mode behind-proxy
		saw "$flag"
		;;
	--public)
		set_mode public
		saw "$flag"
		;;
	--upgrade) UPGRADE=1 ;;
	--yes) ASSUME_YES=1 ;;
	--restart-sfu) RESTART_SFU=1 ;;
	--check-args) CHECK_ARGS=1 ;;
	--insecure-skip-verify) INSECURE=1 ;;
	--no-media-ip)
		NO_MEDIA_IP=1
		saw "$flag"
		;;
	--domain)
		DOMAIN="$value"
		saw "$flag"
		;;
	--public-ip)
		PUBLIC_IP="$value"
		saw "$flag"
		;;
	--agree-tos)
		AGREE_TOS=1
		saw "$flag"
		;;
	--listen)
		LISTEN="$value"
		saw "$flag"
		;;
	--trusted-proxy)
		TRUSTED="$TRUSTED $value"
		saw "$flag"
		;;
	--udp-port)
		UDP_PORT="$value"
		saw "$flag"
		;;
	--node-ip)
		NODE_IP="$value"
		saw "$flag"
		;;
	--version) VERSION="$value" ;;
	--release-url) RELEASE_URL="${value%/}" ;;
	--binary) BINARY="$value" ;;
	--core) CORE="$value" ;;
	--sums) SUMS="$value" ;;
	--release-json) RELEASE_JSON="$value" ;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		usage
		die "unknown option $flag"
		;;
	esac
done

# ------------------------------------------------------------ validation ----
# Every value that reaches dilla.toml is checked against what dillad itself
# accepts, and against a strict character set: the file is edited as text, and
# a quote or a newline in a value would be TOML injection.

# A decimal number without leading zeros (TOML refuses 07882), at most $2.
valid_uint() {
	case "$1" in
	'' | *[!0-9]*) return 1 ;;
	0) ;;
	0*) return 1 ;;
	esac
	[ "${#1}" -le 6 ] && [ "$1" -le "$2" ]
}
valid_ipv4() {
	case "$1" in
	*[!0-9.]* | .* | *. | *..*) return 1 ;;
	esac
	old_ifs="$IFS"
	IFS=.
	# shellcheck disable=SC2086 # split on the dots
	set -- $1
	IFS="$old_ifs"
	[ "$#" -eq 4 ] || return 1
	for octet in "$@"; do
		valid_uint "$octet" 255 || return 1
	done
}
valid_ipv6() {
	case "$1" in
	'' | *[!0-9A-Fa-f:.]* | *:::*) return 1 ;;
	*:*:*) ;;
	*) return 1 ;;
	esac
	colons="$(printf '%s' "$1" | tr -cd ':')"
	[ "${#colons}" -le 7 ] || return 1
	case "$1" in
	*::*::*) return 1 ;;
	*.*) valid_ipv4 "${1##*:}" ;;
	esac
}
valid_ip() { valid_ipv4 "$1" || valid_ipv6 "$1"; }
valid_port() { valid_uint "$1" 65535 && [ "$1" -ge 1 ]; }
valid_cidr() {
	case "$1" in
	*/*/* | */) return 1 ;;
	*/*) ;;
	*) return 1 ;;
	esac
	if valid_ipv4 "${1%/*}"; then
		valid_uint "${1#*/}" 32
	else
		valid_ipv6 "${1%/*}" && valid_uint "${1#*/}" 128
	fi
}
valid_listen() {
	case "$1" in
	'' | *[!0-9A-Za-z.:\[\]-]*) return 1 ;;
	*:*) ;;
	*) return 1 ;;
	esac
	valid_port "${1##*:}"
}
valid_domain() {
	case "$1" in
	'' | *[!A-Za-z0-9.-]* | .* | *. | *..*) return 1 ;;
	*.*) return 0 ;;
	*) return 1 ;;
	esac
}

if [ "$UPGRADE" -eq 1 ]; then
	[ -z "$SET_MODE_FLAGS" ] || die "--upgrade keeps the installed network settings; drop$SET_MODE_FLAGS"
else
	[ "$ASSUME_YES" -eq 0 ] || die "--yes is for --upgrade"
	[ "$RESTART_SFU" -eq 0 ] || die "--restart-sfu is for --upgrade"
	[ -n "$MODE" ] || {
		usage
		die "choose a mode: --behind-proxy or --public (or --upgrade for an installed instance)"
	}
	valid_domain "$DOMAIN" || die "--domain must be a DNS name such as chat.example.org, got \"$DOMAIN\""
	valid_port "$UDP_PORT" || die "--udp-port must be a port number 1-65535 without leading zeros, got \"$UDP_PORT\""
	[ -z "$NODE_IP" ] || valid_ip "$NODE_IP" || die "--node-ip must be an IPv4 or IPv6 address, got \"$NODE_IP\""
	[ -z "$PUBLIC_IP" ] || valid_ip "$PUBLIC_IP" || die "--public-ip must be an IPv4 or IPv6 address, got \"$PUBLIC_IP\""
	if [ "$MODE" = behind-proxy ]; then
		[ -n "$LISTEN" ] || die "--behind-proxy needs --listen ADDR:PORT, the plain HTTP listener the proxy reaches"
		valid_listen "$LISTEN" || die "--listen must be ADDR:PORT such as 0.0.0.0:8080, got \"$LISTEN\""
		[ -n "$TRUSTED" ] || die "--behind-proxy needs at least one --trusted-proxy CIDR: dillad trusts X-Forwarded-For only from it"
		for cidr in $TRUSTED; do
			valid_cidr "$cidr" || die "--trusted-proxy must be a CIDR such as 10.0.0.5/32, got \"$cidr\""
		done
		[ "$AGREE_TOS" -eq 0 ] || die "--agree-tos is for --public: behind a proxy dillad requests no certificate"
		if [ -z "$PUBLIC_IP" ] && [ -z "$NODE_IP" ] && [ "$NO_MEDIA_IP" -eq 0 ]; then
			die "--behind-proxy needs --public-ip or --node-ip, the address clients send UDP $UDP_PORT to (with Pangolin, the Pangolin server's); without one, calls cannot reach the SFU from outside this host. Pass --no-media-ip to install without it anyway"
		fi
	else
		[ -z "$LISTEN" ] || die "--listen is for --behind-proxy; --public serves on 443"
		[ -z "$TRUSTED" ] || die "--trusted-proxy is for --behind-proxy; a direct listener must not honour X-Forwarded-For"
		[ "$NO_MEDIA_IP" -eq 0 ] || die "--no-media-ip is for --behind-proxy; --public needs --public-ip"
		[ -n "$PUBLIC_IP" ] || die "--public needs --public-ip, the address clients reach the instance on"
		[ "$AGREE_TOS" -eq 1 ] || die "--public needs --agree-tos: tls.agreed records your acceptance of the ACME CA's subscriber agreement, and this script has no standing to accept it for you"
	fi
fi

# Where the binary and the core come from, and how they are checked. A file
# that is downloaded is always checked; a local file is checked against
# --sums, or installed unchecked only with --insecure-skip-verify.
DOWNLOAD=0
[ -n "$BINARY" ] || DOWNLOAD=1
[ -n "$CORE" ] || DOWNLOAD=1
if [ -n "$BINARY$CORE" ] && [ -z "$SUMS" ] && [ "$INSECURE" -eq 0 ]; then
	die "--binary and --core are checked against a SHA256SUMS: pass --sums FILE, or --insecure-skip-verify to install them unchecked"
fi
[ -z "$RELEASE_JSON" ] || [ -n "$BINARY" ] || die "--release-json is for --binary: a downloaded release fetches its own release.json"

[ -n "$VERSION" ] || VERSION="$DILLA_RELEASE_TAG"
if [ -n "$VERSION" ]; then
	case "$VERSION" in
	v[0-9]*) ;;
	*) die "--version must be a release tag such as v0.1.0, got \"$VERSION\"" ;;
	esac
	case "$VERSION" in
	*[!A-Za-z0-9.+_-]*) die "--version must be a release tag such as v0.1.0, got \"$VERSION\"" ;;
	esac
fi
if [ -z "$RELEASE_URL" ] && [ "$DOWNLOAD" -eq 1 ]; then
	[ -n "$VERSION" ] || die "this install.sh is not from a release, so it has no default version: pass --version <tag> (see https://github.com/jonasthim/dilla/releases) or --release-url <url>"
	RELEASE_URL="https://github.com/jonasthim/dilla/releases/download/$VERSION"
	URL_TAG="$VERSION"
fi

[ "$CHECK_ARGS" -eq 0 ] || exit 0

# ------------------------------------------------------------------ host ----
[ "$(id -u)" = 0 ] || die "run this as root (inside the container or VM that will host dilla)"

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
x86_64 | amd64) ARCH=amd64 ;;
aarch64 | arm64) ARCH=arm64 ;;
*) die "unsupported architecture $ARCH_RAW: dillad is built for amd64 and arm64" ;;
esac

ROOT="${DILLA_INSTALL_ROOT:-}"
ROOT="${ROOT%/}"
BIN_DIR="$ROOT/usr/local/bin"
UNIT_PATH="$ROOT/etc/systemd/system/dilla.service"
MEDIA_UNIT_PATH="$ROOT/etc/systemd/system/dilla-media.service"
REFRESH_UNIT_PATH="$ROOT/etc/systemd/system/dilla-media-refresh.service"
REFRESH_TIMER_PATH="$ROOT/etc/systemd/system/dilla-media-refresh.timer"
REFRESH_DIR="$ROOT/usr/local/libexec"
REFRESH_SCRIPT="$REFRESH_DIR/dilla-media-refresh"
PROC="$ROOT/proc"
CONF_DIR="$ROOT/etc/dilla"
CONF="$CONF_DIR/dilla.toml"
DATA_DIR="$ROOT/var/lib/dillad"
BIN_NAME="dillad-linux-$ARCH"
CORE_NAME="dilla_core_wasi.wasm"

INSTALLED=0
if [ -e "$CONF" ]; then
	INSTALLED=1
elif [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR")" ]; then
	INSTALLED=1
fi
if [ "$UPGRADE" -eq 1 ]; then
	[ "$INSTALLED" -eq 1 ] || die "--upgrade found no instance: neither $CONF nor a non-empty $DATA_DIR exists; install first"
	[ -e "$CONF" ] || die "--upgrade found $DATA_DIR but no $CONF; restore the config before upgrading"
elif [ "$INSTALLED" -eq 1 ]; then
	die "an instance is already installed here ($CONF or $DATA_DIR exists); run with --upgrade to replace the binary and the core, which never touches the config or the data"
fi

# The downloads land in a root-only directory on /var, not /tmp: the verified new binary is run
# from here (version --json), and /tmp may be mounted noexec.
WORK_PARENT="$ROOT/var/lib/dilla-install"
[ ! -L "$WORK_PARENT" ] || die "$WORK_PARENT is a symbolic link; refusing to work in it"
mkdir -p "$WORK_PARENT"
chmod 0700 "$WORK_PARENT"
WORK="$(mktemp -d "$WORK_PARENT/work.XXXXXX")"

# ------------------------------------------------------------- artefacts ----
have() { command -v "$1" >/dev/null 2>&1; }

# Only what is missing, and only when something has to be downloaded.
ensure_download_tools() {
	missing=""
	have curl || have wget || missing="curl"
	[ -s "$ROOT/etc/ssl/certs/ca-certificates.crt" ] || missing="$missing ca-certificates"
	[ -n "$missing" ] || return 0
	log "installing$missing with apt"
	DEBIAN_FRONTEND=noninteractive apt-get update >&2
	# shellcheck disable=SC2086 # one word per package
	DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing >&2
}

fetch() { # URL OUT
	if have curl; then
		curl -fsSL --proto '=https,file' --proto-redir '=https' -o "$2" "$1" >&2 || die "download of $1 failed"
	else
		case "$1" in
		https://*) ;;
		*) die "download of $1 failed: wget fetches https:// only" ;;
		esac
		wget -q --https-only -O "$2" "$1" >&2 || die "download of $1 failed"
	fi
}

if [ "$DOWNLOAD" -eq 1 ]; then
	ensure_download_tools
fi

# CHECK holds the names that must match SHA256SUMS; UNCHECKED the local files
# that --insecure-skip-verify lets through.
CHECK=""
UNCHECKED=""
if [ -n "$BINARY" ]; then
	[ -s "$BINARY" ] || die "the dillad binary $BINARY is missing or empty"
	cp "$BINARY" "$WORK/$BIN_NAME"
	if [ -n "$SUMS" ]; then CHECK="$CHECK $BIN_NAME"; else UNCHECKED="$UNCHECKED $BIN_NAME"; fi
else
	log "downloading $BIN_NAME from $RELEASE_URL"
	fetch "$RELEASE_URL/$BIN_NAME" "$WORK/$BIN_NAME"
	CHECK="$CHECK $BIN_NAME"
fi
if [ -n "$CORE" ]; then
	[ -s "$CORE" ] || die "the wasi core $CORE is missing or empty"
	cp "$CORE" "$WORK/$CORE_NAME"
	if [ -n "$SUMS" ]; then CHECK="$CHECK $CORE_NAME"; else UNCHECKED="$UNCHECKED $CORE_NAME"; fi
else
	log "downloading $CORE_NAME from $RELEASE_URL"
	fetch "$RELEASE_URL/$CORE_NAME" "$WORK/$CORE_NAME"
	CHECK="$CHECK $CORE_NAME"
fi
# release.json (R-UP2): the release's machine-readable metadata, generated from the binary's own
# `dillad version --json`. HAVE_RELEASE_JSON is 1 once there is one to read.
REL_JSON_NAME="release.json"
HAVE_RELEASE_JSON=0
if [ -n "$RELEASE_JSON" ]; then
	[ -s "$RELEASE_JSON" ] || die "--release-json $RELEASE_JSON is missing or empty"
	cp "$RELEASE_JSON" "$WORK/$REL_JSON_NAME"
	HAVE_RELEASE_JSON=1
	if [ -n "$SUMS" ]; then CHECK="$CHECK $REL_JSON_NAME"; else UNCHECKED="$UNCHECKED $REL_JSON_NAME"; fi
fi

if [ -n "$CHECK" ]; then
	if [ -n "$SUMS" ]; then
		[ -f "$SUMS" ] || die "--sums $SUMS does not exist"
		cp "$SUMS" "$WORK/SHA256SUMS"
	else
		log "downloading SHA256SUMS from $RELEASE_URL"
		fetch "$RELEASE_URL/SHA256SUMS" "$WORK/SHA256SUMS"
	fi
	# An empty or short SHA256SUMS refuses: verification is decided by where the
	# files came from, never by what the SHA256SUMS file happens to hold.
	[ -s "$WORK/SHA256SUMS" ] || die "SHA256SUMS is empty; refusing to install unverified files"
	# SHA256SUMS decides whether the release has a release.json: listed means it is fetched and
	# verified like the binary (exactly one line, below); not listed means there is none.
	if [ "$HAVE_RELEASE_JSON" -eq 0 ] && awk -v n="$REL_JSON_NAME" '$2 == n || $2 == "*" n { found = 1 } END { exit !found }' "$WORK/SHA256SUMS"; then
		[ -z "$BINARY" ] || die "SHA256SUMS lists $REL_JSON_NAME: pass the release's copy with --release-json FILE; nothing was installed"
		log "downloading $REL_JSON_NAME from $RELEASE_URL"
		fetch "$RELEASE_URL/$REL_JSON_NAME" "$WORK/$REL_JSON_NAME"
		HAVE_RELEASE_JSON=1
		CHECK="$CHECK $REL_JSON_NAME"
	fi
	# Exactly one line per asset, by exact name, so a SHA256SUMS that leaves one
	# out cannot pass for both.
	: >"$WORK/check.sums"
	for name in $CHECK; do
		awk -v n="$name" '($2 == n || $2 == "*" n) && $1 ~ /^[0-9a-f]+$/ && length($1) == 64' "$WORK/SHA256SUMS" >"$WORK/line"
		[ "$(wc -l <"$WORK/line")" -eq 1 ] || die "SHA256SUMS does not hold exactly one SHA-256 line for $name; refusing to install unverified files"
		cat "$WORK/line" >>"$WORK/check.sums"
	done
	if ! (cd "$WORK" && sha256sum -c --strict --quiet check.sums) >&2; then
		die "checksum mismatch: the files do not match SHA256SUMS; nothing was installed"
	fi
	log "verified$CHECK against SHA256SUMS"
fi
if [ -n "$UNCHECKED" ]; then
	log "warning: --insecure-skip-verify: installing$UNCHECKED unverified"
fi

# json_get JSON KEY: the raw value of KEY in a flat JSON object (a string with its quotes, a
# number, true or false, or an array), empty when absent. Every JSON read here is written by
# dillad (version --json, media.json) or generated from it (release.json), one flat object.
json_get() {
	printf '%s' "$1" | tr -d ' \t\r\n' |
		sed -n "s/.*\"$2\":\(\"[^\"]*\"\|\[[^]]*\]\|-\{0,1\}[0-9][0-9]*\|true\|false\).*/\1/p"
}
unquote() {
	uq="${1#\"}"
	printf '%s' "${uq%\"}"
}
has_turn() { case "$1" in *'"turn"'*) return 0 ;; esac; return 1; }

# web312_or_later VERSION: true when VERSION (with or without its leading v) is v0.1.0-web3.12 or a
# later release, the first that must ship release.json. 0.1.0 itself and anything above it count as
# later; another 0.1.0 prerelease (noise-beta, a dev build) as earlier.
web312_or_later() {
	wv="${1#v}"
	wbase="${wv%%-*}"
	wpre=""
	[ "$wbase" = "$wv" ] || wpre="${wv#*-}"
	wmaj="${wbase%%.*}"
	wrest="${wbase#*.}"
	wmin="${wrest%%.*}"
	wpat="${wrest#*.}"
	for n in "$wmaj" "$wmin" "$wpat"; do
		case "$n" in '' | *[!0-9]*) return 1 ;; esac
	done
	[ "$wmaj" -eq 0 ] || return 0
	[ "$wmin" -le 1 ] || return 0
	[ "$wmin" -eq 1 ] || return 1
	[ "$wpat" -eq 0 ] || return 0
	[ -n "$wpre" ] || return 0
	case "$wpre" in
	web3.*) ;;
	*) return 1 ;;
	esac
	wn="${wpre#web3.}"
	wn="${wn%%.*}"
	case "$wn" in '' | *[!0-9]*) return 1 ;; esac
	[ "$wn" -ge 12 ]
}

# What the new binary says it is. It was verified above, so running it is running the release.
chmod 0755 "$WORK/$BIN_NAME"
NEW_VERSION="$("$WORK/$BIN_NAME" version 2>/dev/null | awk '$1 == "dillad" { print $2; exit }')" || NEW_VERSION=""
[ -n "$NEW_VERSION" ] || die "the new dillad does not run on this host ($WORK/$BIN_NAME version printed no version); nothing was installed"
# web3.11 and older know no --json: their media level is 1, and they serve no TURN in dilla-media.
NEW_JSON="$("$WORK/$BIN_NAME" version --json 2>/dev/null | head -n 1)" || NEW_JSON=""
NEW_LEVEL="$(json_get "$NEW_JSON" media_level)"
case "$NEW_LEVEL" in '' | *[!0-9]*) NEW_LEVEL=1 ;; esac
# A dillad of media level 2 (web3.12) or later sends READY=1 and answers on media.sock.
NEW_NOTIFY=0
[ "$NEW_LEVEL" -lt 2 ] || NEW_NOTIFY=1
NEW_MIN=""
if [ "$HAVE_RELEASE_JSON" -eq 1 ]; then
	# release.json cannot be swapped: it matched SHA256SUMS above, and it must describe this binary.
	RJ="$(cat "$WORK/$REL_JSON_NAME")"
	[ -n "$NEW_JSON" ] || die "release.json describes a release, but the new dillad ($NEW_VERSION) has no version --json to check it against; nothing was installed"
	[ "$(json_get "$RJ" format)" = 1 ] || die "release.json has format $(json_get "$RJ" format), and this install.sh reads format 1; nothing was installed"
	for key in version wire schema media_level min_sfu_media_level media_capabilities; do
		rj_value="$(json_get "$RJ" "$key")"
		bin_value="$(json_get "$NEW_JSON" "$key")"
		if [ -z "$rj_value" ] || [ "$rj_value" != "$bin_value" ]; then
			die "release.json says $key is ${rj_value:-missing}, but the new dillad says ${bin_value:-missing}; refusing a release whose metadata does not describe its binary. Nothing was installed"
		fi
	done
	RJ_TAG="$(unquote "$(json_get "$RJ" tag)")"
	[ "$RJ_TAG" = "v$NEW_VERSION" ] || die "release.json names tag ${RJ_TAG:-none}, but the new dillad is $NEW_VERSION; nothing was installed"
	[ -z "$URL_TAG" ] || [ "$RJ_TAG" = "$URL_TAG" ] || die "release.json names tag $RJ_TAG, but the release asked for is $URL_TAG; nothing was installed"
	case "$(unquote "$(json_get "$RJ" sfu_restart)")" in
	when-idle | required) ;;
	*) die "release.json's sfu_restart is $(json_get "$RJ" sfu_restart), want \"when-idle\" or \"required\"; nothing was installed" ;;
	esac
	NEW_MIN="$(json_get "$RJ" min_sfu_media_level)"
	case "$NEW_MIN" in '' | *[!0-9]*) die "release.json's min_sfu_media_level is not a number; nothing was installed" ;; esac
	log "release.json: v$NEW_VERSION, media level $NEW_LEVEL, works with a media server of level $NEW_MIN or later"
elif web312_or_later "$NEW_VERSION" || { [ -n "$URL_TAG" ] && web312_or_later "$URL_TAG"; }; then
	# Every release from v0.1.0-web3.12 on ships one. Without it the installer cannot tell whether
	# the running media server can stay, so it never guesses.
	case "$UNCHECKED" in
	*"$BIN_NAME"*) log "warning: --insecure-skip-verify without --release-json: v$NEW_VERSION is treated as needing a media server restart" ;;
	*)
		if [ -n "$BINARY" ]; then
			die "v$NEW_VERSION ships release.json, listed in its SHA256SUMS: pass it with --release-json FILE (and a --sums that lists it). Nothing was installed"
		fi
		die "the release at $RELEASE_URL has no release.json in its SHA256SUMS, which every release from v0.1.0-web3.12 on ships; refusing an incomplete release. Nothing was installed"
		;;
	esac
fi

# Installs a file next to its destination and renames it over, so a running
# dillad keeps its open inode and an interrupted copy never leaves half a file.
put() { # SRC DEST MODE
	install -m "$3" "$1" "$2.new"
	mv -f "$2.new" "$2"
}

# conf_value TABLE KEY: KEY's value in [TABLE] of dilla.toml, without quotes or a trailing comment.
conf_value() {
	[ -f "$CONF" ] || return 0
	awk -v t="[$1]" -v k="$2" '
		{ line = $0; sub(/^[ \t]+/, "", line); sub(/[ \t]+$/, "", line) }
		line ~ /^\[/ { inside = (line == t); next }
		inside && index(line, k) == 1 {
			rest = substr(line, length(k) + 1)
			if (rest !~ /^[ \t]*=/) next
			sub(/^[ \t]*=[ \t]*/, "", rest)
			sub(/[ \t]*#.*$/, "", rest)
			gsub(/["\047]/, "", rest)
			print rest
			exit
		}
	' "$CONF"
}

# turn_listen_served: TURN is on and turn.listen is set, so a web3.12+ dilla-media binds it (R-UP11).
turn_listen_served() {
	[ "$(conf_value turn enabled)" = true ] && [ -n "$(conf_value turn listen)" ]
}

# media_bind_cap: dilla-media binds turn.listen on a port below 1024, which a non-root process may
# do only with CAP_NET_BIND_SERVICE.
media_bind_cap() {
	turn_listen_served || return 1
	mbc_port="$(conf_value turn listen)"
	mbc_port="${mbc_port##*:}"
	case "$mbc_port" in '' | *[!0-9]*) return 1 ;; esac
	[ "$mbc_port" -lt 1024 ]
}

# write_media_unit notify|simple: deploy/dilla-media.service, verbatim, for a dillad that sends
# READY=1 (web3.12 on); "simple" is the same unit for an older dillad, which never does.
write_media_unit() {
	cat >"$WORK/dilla-media.service" <<'UNIT'
[Unit]
Description=dilla media SFU
Documentation=https://github.com/jonasthim/dilla/blob/main/docs/deploy/README.md
After=network-online.target
Wants=network-online.target
# No PartOf=dilla.service: restarting the API never touches the SFU, so live calls survive an
# API-only upgrade. dilla-media-refresh.timer moves it onto a new dillad once its calls end.

[Service]
# READY: dillad media sends READY=1 once the SFU accepts RoomService requests and media.json is
# READY: written, so systemctl start and restart return when the media server is ready.
Type=notify
NotifyAccess=main
ExecStart=/usr/local/bin/dillad media --config=%E/dilla/dilla.toml
# Exit 69 (the SFU did not come up) is retried; exit.Config (78) means dilla.toml must be fixed.
Restart=on-failure
RestartSec=5s
RestartPreventExitStatus=78
TimeoutStartSec=60s
TimeoutStopSec=25s
User=dillad
Group=dillad
StateDirectory=dillad
StateDirectoryMode=0700
ConfigurationDirectory=dilla
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
# The media server executes nothing but the (statically linked) dillad itself.
NoExecPaths=/
ExecPaths=/usr/local/bin
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectProc=invisible
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
UNIT
	if [ "$1" = simple ]; then
		sed -e '/^# READY: /d' -e '/^NotifyAccess=main$/d' -e 's/^Type=notify$/Type=simple/' \
			-e 's/^TimeoutStartSec=60s$/TimeoutStartSec=30s/' "$WORK/dilla-media.service" >"$WORK/dilla-media.service.x"
		mv -f "$WORK/dilla-media.service.x" "$WORK/dilla-media.service"
	elif media_bind_cap; then
		log "turn.listen is below port 1024: dilla-media.service gets CAP_NET_BIND_SERVICE to bind it"
		awk '{ print } $0 == "UMask=0077" {
			print "# turn.listen is below 1024: how a non-root dillad media binds it."
			print "AmbientCapabilities=CAP_NET_BIND_SERVICE"
			print "CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
		}' "$WORK/dilla-media.service" >"$WORK/dilla-media.service.x"
		mv -f "$WORK/dilla-media.service.x" "$WORK/dilla-media.service"
	fi
	put "$WORK/dilla-media.service" "$MEDIA_UNIT_PATH" 0644
}

# media_unit_type: notify for a new binary that sends READY=1 (media level 2, web3.12, on).
media_unit_type() {
	if [ "$NEW_LEVEL" -ge 2 ]; then echo notify; else echo simple; fi
}

# write_refresh_units: deploy/dilla-media-refresh.{service,timer} and deploy/dilla-media-refresh.sh,
# verbatim (deploy/install_test.sh compares them). R-UP4.
write_refresh_units() {
	mkdir -p "$REFRESH_DIR"
	cat >"$WORK/dilla-media-refresh.service" <<'UNIT'
[Unit]
Description=dilla: restart dilla-media onto the installed dillad once its calls have ended
Documentation=https://github.com/jonasthim/dilla/blob/main/docs/deploy/README.md

[Service]
# Root: it restarts dilla-media (and, at the one-time TURN handoff, dilla) and asks
# `dillad media --idle` as the dillad user. The logic is a script, so this unit quotes nothing.
Type=oneshot
ExecStart=/usr/local/libexec/dilla-media-refresh
# A restart waits for dilla-media's READY (60 s); the TURN handoff also waits for dilla (300 s).
TimeoutStartSec=10min
UNIT
	put "$WORK/dilla-media-refresh.service" "$REFRESH_UNIT_PATH" 0644
	cat >"$WORK/dilla-media-refresh.timer" <<'UNIT'
[Unit]
Description=dilla: every minute, check whether dilla-media can move to the installed dillad
Documentation=https://github.com/jonasthim/dilla/blob/main/docs/deploy/README.md

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
	put "$WORK/dilla-media-refresh.timer" "$REFRESH_TIMER_PATH" 0644
	cat >"$WORK/dilla-media-refresh" <<'SCRIPT'
#!/bin/sh
# dilla-media-refresh: dilla-media-refresh.service runs this as root every minute, from
# dilla-media-refresh.timer. deploy/install.sh installs it as /usr/local/libexec/dilla-media-refresh.
#
# An upgrade whose release can work with the running media server restarts only the API, so live
# calls continue and dilla-media keeps running the previous dillad. This restarts dilla-media onto
# /usr/local/bin/dillad once both hold:
#   - the running SFU's executable is not the installed file (its inode differs);
#   - `dillad media --idle`, run as dillad, exits 0: no room has participants, none is younger than
#     60 s, and the API says no call token was minted in the last 60 s. Any other exit (busy, the
#     API does not answer, a dillad too old to know --idle) means not now.
# It works for a web3.11 media server too, which knows nothing of this. Whether the SFU runs the
# installed binary is decided by executable identity only (inode and SHA-256), never by what it
# says about itself. This runs as root and never executes anything reached through /proc: a dillad
# process can execve a binary of its own and keep its pid, so /proc/<pid>/exe is only stat'ed and
# hashed, as data.
#
# The TURN handoff (one time): when the SFU being replaced does not serve TURN (its media.json does
# not list "turn", or it has none) and the installed dillad does, the API still holds turn.listen.
# The new SFU becomes ready without it ("TURN bind pending"), dilla is then restarted so it lets go,
# and this waits until media.json lists "turn". The rooms are idle, so no relay is in use.
#
# Every restart is logged to the journal; a minute with nothing to do logs nothing.
# DILLA_INSTALL_ROOT prefixes every path, for deploy/install_test.sh only.
set -u

ROOT="${DILLA_INSTALL_ROOT:-}"
ROOT="${ROOT%/}"
BIN="$ROOT/usr/local/bin/dillad"
CONF="$ROOT/etc/dilla/dilla.toml"
LOCK="$ROOT/run/dilla-install.lock"
MARK="$ROOT/run/dilla-media-refresh.handoff"
WAIT=60

log() { printf 'dilla-media-refresh: %s\n' "$*"; }

# conf_value TABLE KEY: KEY's value in [TABLE] of dilla.toml, without quotes or a trailing comment.
conf_value() {
	awk -v t="[$1]" -v k="$2" '
		{ line = $0; sub(/^[ \t]+/, "", line); sub(/[ \t]+$/, "", line) }
		line ~ /^\[/ { inside = (line == t); next }
		inside && index(line, k) == 1 {
			rest = substr(line, length(k) + 1)
			if (rest !~ /^[ \t]*=/) next
			sub(/^[ \t]*=[ \t]*/, "", rest)
			sub(/[ \t]*#.*$/, "", rest)
			gsub(/["\047]/, "", rest)
			print rest
			exit
		}
	' "$CONF" 2>/dev/null
}

# json_get JSON KEY: the raw value of KEY in a flat JSON object (a string with its quotes, a number,
# or an array), empty when it is absent. The JSON comes from dillad itself (media.json, version --json).
json_get() {
	printf '%s' "$1" | tr -d ' \t\r\n' |
		sed -n "s/.*\"$2\":\(\"[^\"]*\"\|\[[^]]*\]\|-\{0,1\}[0-9][0-9]*\|true\|false\).*/\1/p"
}
unquote() { v="${1#\"}"; printf '%s' "${v%\"}"; }
has_turn() { case "$1" in *'"turn"'*) return 0 ;; esac; return 1; }
# sha256_of FILE: FILE's SHA-256, read as data.
sha256_of() { sha256sum <"$1" 2>/dev/null | awk '{ print $1 }'; }

main_pid() {
	p="$(systemctl show -P MainPID dilla-media 2>/dev/null)"
	case "$p" in '' | *[!0-9]*) echo 0 ;; *) echo "$p" ;; esac
}

DATA="$(conf_value instance data_dir)"
[ -n "$DATA" ] || DATA="$ROOT/var/lib/dillad"

# parse_report JSON: P_VERSION, P_LEVEL, P_PID and P_CAPS from a media server's self-description.
# It comes from a process dillad controls: the values are only compared and printed, never
# evaluated, and anything but plain tokens is refused.
parse_report() {
	P_VERSION="$(unquote "$(json_get "$1" version)")"
	P_LEVEL="$(json_get "$1" media_level)"
	P_PID="$(json_get "$1" pid)"
	P_CAPS="$(json_get "$1" capabilities)"
	case "$P_VERSION" in '' | *[!A-Za-z0-9.+_-]*) return 1 ;; esac
	[ "${#P_VERSION}" -le 64 ] || return 1
	case "$P_LEVEL" in '' | *[!0-9]*) return 1 ;; esac
	[ "${#P_LEVEL}" -le 3 ] || return 1
	case "$P_PID" in '' | 0 | *[!0-9]*) return 1 ;; esac
	[ "${#P_PID}" -le 10 ] || return 1
	printf '%s' "$P_CAPS" | awk '/^\[("[A-Za-z0-9._-]+"(,"[A-Za-z0-9._-]+")*)?\]$/ { ok = 1 } END { exit !ok }'
}

# media_state PID: sets MS_VERSION, MS_LEVEL and MS_CAPS from what the running media process (PID,
# the unit's MainPID) says about itself: first on media.sock (GET /media/self, asked as dillad
# through the installed dillad as a client), then from its media.json. An answer for another pid,
# a file left by an earlier process, or anything malformed counts as no answer. A media server
# older than web3.12 has neither. Nothing reached through /proc is ever run.
media_state() {
	MS_VERSION=""
	MS_LEVEL=0
	MS_CAPS=""
	[ "$1" -gt 0 ] || return 1
	ms="$(runuser -u dillad -- "$BIN" media --self --config="$CONF" 2>/dev/null | head -n 1)" || ms=""
	if ! parse_report "$ms" || [ "$P_PID" != "$1" ]; then
		ms="$(head -c 4096 "$DATA/media.json" 2>/dev/null)" || return 1
		parse_report "$ms" || return 1
		[ "$P_PID" = "$1" ] || return 1
	fi
	MS_VERSION="$P_VERSION"
	MS_LEVEL="$P_LEVEL"
	MS_CAPS="$P_CAPS"
}

# restart_api_for_handoff: restarts dilla, so it lets go of turn.listen, and waits WAIT seconds for
# dilla-media to report "turn". It ends the run.
restart_api_for_handoff() {
	if ! systemctl restart dilla; then
		log "error: dilla did not restart for the TURN handoff; read journalctl -o cat -u dilla"
		exit 1
	fi
	i=0
	while [ "$i" -lt "$WAIT" ]; do
		if media_state "$(main_pid)" && has_turn "$MS_CAPS"; then
			log "TURN handoff done: dilla-media serves turn.listen"
			exit 0
		fi
		sleep 1
		i=$((i + 1))
	done
	log "warning: dilla-media has not bound turn.listen $WAIT s after dilla restarted; dillad doctor's turn leg names who serves TURN"
	exit 1
}

idle() { runuser -u dillad -- "$BIN" media --idle --config="$CONF" >/dev/null 2>&1; }

# One at a time with install.sh --upgrade, which holds this lock while it decides and restarts.
if command -v flock >/dev/null 2>&1; then
	mkdir -p "$ROOT/run"
	exec 9>"$LOCK"
	flock -n 9 || exit 0
fi

[ -x "$BIN" ] || exit 0
[ "$(conf_value livekit mode)" = sidecar ] || exit 0
pid="$(main_pid)"
# Not running: systemd starts it on the installed binary, so there is nothing to refresh.
[ "$pid" -gt 0 ] || exit 0

turn_configured=0
if [ "$(conf_value turn enabled)" = true ] && [ -n "$(conf_value turn listen)" ]; then
	turn_configured=1
fi
new_json="$(runuser -u dillad -- "$BIN" version --json 2>/dev/null)" || new_json=""
installed_version="$(unquote "$(json_get "$new_json" version)")"
before_valid=0
before_turn=0
if media_state "$pid"; then
	before_valid=1
	has_turn "$MS_CAPS" && before_turn=1
fi
handoff=0
if [ "$turn_configured" -eq 1 ] && [ "$before_turn" -eq 0 ] && has_turn "$(json_get "$new_json" media_capabilities)"; then
	handoff=1
fi

# Whether the SFU runs the installed binary is decided by executable identity alone (R-UP4): the
# inode of /proc/<pid>/exe and its SHA-256, both read as data, against $BIN. A binary replaced in
# place has a new inode, so an SFU on the deleted old one never matches. What the SFU says about
# itself is never asked here: a stale or compromised process could claim the installed release and
# so never be moved onto a patched binary.
running="$(stat -L -c '%d:%i' "$ROOT/proc/$pid/exe" 2>/dev/null)" || exit 0
installed="$(stat -L -c '%d:%i' "$BIN" 2>/dev/null)" || exit 0
same=0
if [ "$running" = "$installed" ]; then
	running_sum="$(sha256_of "$ROOT/proc/$pid/exe")"
	installed_sum="$(sha256_of "$BIN")"
	[ -z "$running_sum" ] || [ "$running_sum" != "$installed_sum" ] || same=1
fi

if [ "$same" -eq 1 ]; then
	# The SFU runs the installed binary, so its report can be used for its level and capabilities.
	# Only a handoff that never happened is left: the SFU came up on this binary on its own
	# (systemd restarted it after a crash) while the API still held turn.listen. Once per media
	# process, so a port that cannot be bound for another reason never restarts the API in a loop.
	if [ "$handoff" -ne 1 ] || [ "$before_valid" -ne 1 ] || [ "$MS_LEVEL" -lt 2 ]; then
		exit 0
	fi
	[ "$(cat "$MARK" 2>/dev/null)" != "$pid" ] || exit 0
	idle || exit 0
	echo "$pid" >"$MARK"
	log "dilla-media (pid $pid) runs the installed ${installed_version:-dillad} but has not bound turn.listen, which dilla still holds; its rooms are idle: restarting dilla to hand TURN over"
	restart_api_for_handoff
fi

# Another executable: an older SFU, whatever it says about itself. Restart it once it is idle.
idle || exit 0
log "dilla-media (pid $pid) runs another executable than the installed $BIN${MS_VERSION:+ (it reports $MS_VERSION)}; its rooms are idle: restarting it"
if ! systemctl restart dilla-media; then
	log "error: dilla-media did not restart; read journalctl -o cat -u dilla-media"
	exit 1
fi
new_pid="$(main_pid)"
if media_state "$new_pid"; then
	log "dilla-media now runs $MS_VERSION (pid $new_pid)"
else
	log "dilla-media restarted (pid $new_pid)"
fi
[ "$handoff" -eq 1 ] || exit 0
log "TURN handoff: dilla-media takes turn.listen from now on; restarting dilla so it lets go"
restart_api_for_handoff
SCRIPT
	put "$WORK/dilla-media-refresh" "$REFRESH_SCRIPT" 0755
}

# refresh_timer: enables the timer for a dillad that knows `media --idle` (web3.12 on), and
# disables it for an older one, which would answer every minute with a usage error.
refresh_timer() {
	if [ "$NEW_LEVEL" -ge 2 ]; then
		systemctl enable --now dilla-media-refresh.timer >&2 || die "systemd could not enable dilla-media-refresh.timer"
	else
		systemctl disable --now dilla-media-refresh.timer >&2 || :
	fi
}

livekit_mode() {
	awk '
		/^[[:space:]]*\[livekit\][[:space:]]*$/ { inside = 1; next }
		inside && /^[[:space:]]*\[/ { exit }
		inside && /^[[:space:]]*mode[[:space:]]*=/ {
			line = $0
			sub(/^[^=]*=[[:space:]]*/, "", line)
			sub(/[[:space:]]*#.*/, "", line)
			gsub(/["\047[:space:]]/, "", line)
			print line
			exit
		}
	' "$CONF"
}

set_livekit_mode() { # MODE
	awk -v mode="$1" '
		/^[[:space:]]*\[livekit\][[:space:]]*$/ { inside = 1 }
		inside && /^[[:space:]]*\[/ && $0 !~ /^[[:space:]]*\[livekit\][[:space:]]*$/ { inside = 0 }
		inside && /^[[:space:]]*mode[[:space:]]*=/ {
			sub(/mode[[:space:]]*=.*/, "mode = \047" mode "\047")
			found = 1
		}
		{ print }
		END { if (!found) exit 3 }
	' "$CONF" >"$WORK/dilla-sidecar.toml" || die "dilla.toml has no livekit.mode; cannot migrate it to a media sidecar"
	cp -p "$CONF" "$CONF.new"
	cat "$WORK/dilla-sidecar.toml" >"$CONF.new"
	mv -f "$CONF.new" "$CONF"
}

run_doctor() {
	DOCTOR_RC=0
	DOCTOR_OUT="$(runuser -u dillad -- "$BIN_DIR/dillad" doctor --config="$CONF" 2>&1)" || DOCTOR_RC=$?
}

doctor_and_report() {
	log "running dillad doctor"
	run_doctor
	printf '%s\n' "$DOCTOR_OUT" | sed 's/^/  /' >&2
	# Legs that need DNS for the domain, outbound HTTPS or the proxy: red until
	# those exist, which is expected on a fresh install. The udp leg is never red:
	# it reads WARN "not probed" by default and cannot prove the forward.
	PENDING="$(printf '%s\n' "$DOCTOR_OUT" | awk '$1 == "FAIL" && ($2 == "clock" || $2 == "certificate" || $2 == "turn") { printf "%s ", $2 }')"
	BROKEN="$(printf '%s\n' "$DOCTOR_OUT" | awk '$1 == "FAIL" && !($2 == "clock" || $2 == "certificate" || $2 == "turn") { printf "%s ", $2 }')"
	if [ -n "$PENDING" ]; then
		log "doctor: these checks need DNS, the network or the proxy set up first, and fail until DNS and the proxy are in place: $PENDING"
		log "        run the doctor again once they are: runuser -u dillad -- /usr/local/bin/dillad doctor --config=/etc/dilla/dilla.toml"
	fi
	if [ -n "$BROKEN" ]; then
		log "error: doctor found a problem with the install itself: $BROKEN"
		return 1
	fi
	if [ "$DOCTOR_RC" -ne 0 ] && [ -z "$PENDING" ]; then
		log "error: dillad doctor exited $DOCTOR_RC"
		return 1
	fi
	return 0
}

# schema_version BINARY: the database's schema version, as BINARY's `migrate status` reads it.
schema_version() {
	sv_out="$(runuser -u dillad -- "$1" migrate status --config="$CONF" 2>/dev/null)" || return 1
	sv="$(printf '%s\n' "$sv_out" | awk '$1 == "current" { sub(/,$/, "", $2); print $2; exit }')"
	case "$sv" in '' | *[!0-9]*) return 1 ;; esac
	printf '%s\n' "$sv"
}

# rollback_stuck REASON: the rollback cannot prove the database is at a schema the previous binary
# reads, so the previous binary is NOT started (it refuses a newer schema, so the instance would
# stay down either way). The new binary stays in place, and the operator is told the ways out.
rollback_stuck() {
	log "error: dilla did not restart with the new binary, and the rollback stopped: $1"
	if [ "$STOPPED" -eq 1 ]; then
		log "dilla is stopped. The new binary is still $BIN_DIR/dillad; the previous one is $BIN_DIR/dillad.prev."
	else
		log "dilla could not be stopped, so systemd may still be restarting the new binary ($BIN_DIR/dillad); the previous one is $BIN_DIR/dillad.prev."
	fi
	if [ "${MEDIA_RESTARTED:-0}" -eq 1 ]; then
		log "dilla-media was restarted onto the new binary. Whichever way you go back to the previous one, stop dilla-media"
		log "before you start the previous dilla, and start it again first, so exactly one of them holds turn.listen:"
		log "    systemctl stop dilla-media; <put the previous pair back as below>; systemctl start dilla-media; systemctl start dilla"
		log "A previous release below v0.1.0-web3.12 runs dilla-media as Type=simple: set Type=simple in $MEDIA_UNIT_PATH and run systemctl daemon-reload first."
	fi
	if [ -z "${SCHEMA_AFTER:-}" ]; then
		log "First read the database's schema version with the previous binary:"
		log "    runuser -u dillad -- $BIN_DIR/dillad.prev migrate status --config=$CONF"
		log "If it prints \"current $SCHEMA_BEFORE\" (or lower), nothing was migrated: put the previous pair back and start it:"
		log "    systemctl stop dilla; cp -p $BIN_DIR/dillad.prev $BIN_DIR/dillad; cp -p $BIN_DIR/$CORE_NAME.prev $BIN_DIR/$CORE_NAME; systemctl start dilla"
		log "If it prints a higher current version, the new binary migrated it; then either:"
	else
		log "The database is at schema $SCHEMA_AFTER and the previous binary refuses anything above $SCHEMA_BEFORE, so do not put it back as it is. Either:"
	fi
	log "  1. fix what stopped the new release (journalctl -o cat -u dilla) and run: systemctl start dilla"
	if [ "${LIVEKIT_MODE_BEFORE:-}" = in_process ]; then
		log "     If returning to the previous binary, first stop dilla-media and restore $CONF.prev to $CONF."
	fi
	log "  2. or stop dilla, take the database back with the NEW binary, then put the previous pair back:"
	log "       runuser -u dillad -- $BIN_DIR/dillad migrate down --to=$SCHEMA_BEFORE --i-know-what-i-am-doing --config=$CONF"
	log "       cp -p $BIN_DIR/dillad.prev $BIN_DIR/dillad; cp -p $BIN_DIR/$CORE_NAME.prev $BIN_DIR/$CORE_NAME; systemctl start dilla"
	log "  3. or, on SQLite, restore the copy the new binary took before it migrated, <db.path>.pre-migration-<unix time>"
	log "     beside the database (it loses everything written since), then put the previous pair back as in 2"
	exit 1
}

# How long the upgrade waits for a service to come up: dilla-media's READY (TimeoutStartSec=60s)
# and its own report, or systemd's own restart of a dilla whose first start failed.
MEDIA_WAIT=60
API_WAIT=60

# The released dillad binaries a running dilla-media older than web3.12 is recognised by, by the
# SHA-256 of its executable: such a media server has no media.sock and writes no media.json, and
# nothing reached through /proc is ever run to ask it. web3.12 and later answer on media.sock, so
# this table never grows. "<sha256> <version> <media level> <asset>", from the release's SHA256SUMS.
KNOWN_SFU_BINARIES="
f13cf8c804d050afd295b178f8ef2a4c87ef1387a6782ba422652fe21a5af8c1 0.1.0-web3.11 1 dillad-linux-amd64
58e67dbf56bb5df012bf3cd967a5c11ee4631c41a7dc919ffc67120af4afdeee 0.1.0-web3.11 1 dillad-linux-arm64
"

# media_main_pid: dilla-media's MainPID, 0 when it is not running.
media_main_pid() {
	mmp="$(systemctl show -P MainPID dilla-media 2>/dev/null)" || mmp=0
	case "$mmp" in '' | *[!0-9]*) echo 0 ;; *) echo "$mmp" ;; esac
}

# parse_report JSON: P_VERSION, P_LEVEL, P_PID and P_CAPS from a media server's self-description
# (media.sock's GET /media/self, or media.json). Both come from a process dillad controls, so the
# values are only compared and printed, never evaluated, and anything but plain tokens is refused.
parse_report() {
	P_VERSION="$(unquote "$(json_get "$1" version)")"
	P_LEVEL="$(json_get "$1" media_level)"
	P_PID="$(json_get "$1" pid)"
	P_CAPS="$(json_get "$1" capabilities)"
	case "$P_VERSION" in '' | *[!A-Za-z0-9.+_-]*) return 1 ;; esac
	[ "${#P_VERSION}" -le 64 ] || return 1
	case "$P_LEVEL" in '' | *[!0-9]*) return 1 ;; esac
	[ "${#P_LEVEL}" -le 3 ] || return 1
	case "$P_PID" in '' | 0 | *[!0-9]*) return 1 ;; esac
	[ "${#P_PID}" -le 10 ] || return 1
	printf '%s' "$P_CAPS" | awk '/^\[("[A-Za-z0-9._-]+"(,"[A-Za-z0-9._-]+")*)?\]$/ { ok = 1 } END { exit !ok }'
}

# media_self: what the RUNNING dilla-media says about itself on media.sock (GET /media/self), asked
# as dillad (media.sock serves only that uid) through the installed dillad as a client. Sets
# SELF_VERSION and SELF_LEVEL; 1 when nothing answers, the answer is malformed, or it
# names another pid than the unit's MainPID. web3.11 and older have no media.sock.
media_self() {
	SELF_VERSION=""
	SELF_LEVEL=""
	msf="$(runuser -u dillad -- "$BIN_DIR/dillad" media --self --config="$CONF" 2>/dev/null | head -n 1)" || return 1
	parse_report "$msf" || return 1
	msf_main="$(media_main_pid)"
	[ "$msf_main" -gt 0 ] && [ "$P_PID" = "$msf_main" ] || return 1
	SELF_VERSION="$P_VERSION"
	SELF_LEVEL="$P_LEVEL"
}

# media_state: sets MS_VERSION, MS_LEVEL and MS_CAPS from media.json when its pid is dilla-media's
# MainPID (R-UP3). A file with any other pid was left by an earlier process (a crash, a reboot) and
# counts as absent; MS_STALE then says why. A malformed file counts as absent too.
media_state() {
	MS_VERSION=""
	MS_LEVEL=""
	MS_CAPS=""
	MS_STALE=""
	ms="$(head -c 4096 "$MEDIA_DATA/media.json" 2>/dev/null)" || return 1
	parse_report "$ms" || return 1
	ms_main="$(media_main_pid)"
	if [ "$ms_main" -eq 0 ] || [ "$P_PID" != "$ms_main" ]; then
		MS_STALE="its pid $P_PID is not dilla-media's MainPID $ms_main"
		return 1
	fi
	MS_VERSION="$P_VERSION"
	MS_LEVEL="$P_LEVEL"
	MS_CAPS="$P_CAPS"
}

# sha256_of FILE: FILE's SHA-256, read as data.
sha256_of() { sha256sum <"$1" 2>/dev/null | awk '{ print $1 }'; }

# sfu_level: what the running SFU is (R-UP3). Sets SFU_PID, SFU_VERSION, SFU_LEVEL (empty when it
# cannot be told) and SFU_FROM, where the answer came from.
#
# Identity comes first, from the executable alone: the SHA-256 of /proc/<pid>/exe, read as data,
# against the installed dillad, dillad.prev (root's own files) and the pinned web3.11 releases.
# Nothing reached through /proc is ever executed: a dillad process can execve a binary of its own
# and keep its pid, and this runs as root. An executable that matches none of them is unknown, and
# unknown means a restart, whatever the process says about itself.
#
# Only once the executable is known is the process's own report used for its level: on media.sock,
# then its media.json (pid = MainPID), and only when it names the version that executable is. A
# web3.11 executable has no report and is level 1, the baseline CI proves (R-UP1).
sfu_level() {
	SFU_PID="$(media_main_pid)"
	SFU_VERSION=""
	SFU_LEVEL=""
	SFU_FROM=""
	if [ "$SFU_PID" -eq 0 ]; then
		SFU_FROM="dilla-media is not running"
		return 0
	fi
	SFU_FROM="the SHA-256 of $PROC/$SFU_PID/exe"
	sl_sum="$(sha256_of "$PROC/$SFU_PID/exe")"
	case "$sl_sum" in '' | *[!0-9a-f]*) return 0 ;; esac
	[ "${#sl_sum}" -eq 64 ] || return 0
	sl_is="$(printf '%s\n' "$KNOWN_SFU_BINARIES" | awk -v s="$sl_sum" '$1 == s { print $2; exit }')"
	if [ -z "$sl_is" ]; then
		for sl_cand in "$BIN_DIR/dillad" "$BIN_DIR/dillad.prev"; do
			[ -f "$sl_cand" ] && [ ! -L "$sl_cand" ] || continue
			# Only a file no one but its owner can write is asked its version.
			[ -z "$(find "$sl_cand" -perm /022 2>/dev/null)" ] || continue
			[ "$(sha256_of "$sl_cand")" = "$sl_sum" ] || continue
			sl_is="$(runuser -u dillad -- "$sl_cand" version 2>/dev/null | awk '$1 == "dillad" { print $2; exit }')" || sl_is=""
			SFU_FROM="$SFU_FROM, which is $sl_cand"
			break
		done
	fi
	case "$sl_is" in *[!A-Za-z0-9.+_-]*) sl_is="" ;; esac
	if [ -z "$sl_is" ]; then
		SFU_FROM="$SFU_FROM, which is no dillad this installer knows"
		return 0
	fi
	SFU_VERSION="$sl_is"
	if [ "$sl_is" = 0.1.0-web3.11 ]; then
		SFU_LEVEL=1
		return 0
	fi
	# A known executable of web3.12 or later: its own report gives the level, if it is that version.
	if media_self && [ "$SELF_VERSION" = "$sl_is" ]; then
		SFU_LEVEL="$SELF_LEVEL"
		SFU_FROM="$SFU_FROM, and its media.sock"
		return 0
	fi
	if media_state && [ "$MS_VERSION" = "$sl_is" ]; then
		SFU_LEVEL="$MS_LEVEL"
		SFU_FROM="$SFU_FROM, and its media.json"
		return 0
	fi
	[ -z "$MS_STALE" ] || log "ignoring $MEDIA_DATA/media.json: $MS_STALE, so an earlier process left it"
	SFU_FROM="$SFU_FROM, without a report that names it"
	return 0
}

# sfu_decision: keep the running SFU, or restart it (R-UP3). The installer decides by level, from
# the verified release.json, and never guesses. Sets DECISION (keep or restart) and logs why.
sfu_decision() {
	DECISION=restart
	if [ "$RESTART_SFU" -eq 1 ]; then
		WHY="--restart-sfu was given"
	elif [ -z "$NEW_MIN" ]; then
		WHY="v$NEW_VERSION has no release.json, so nothing says which media server it works with"
	elif [ "$SFU_PID" -eq 0 ]; then
		WHY="dilla-media is not running"
	elif [ -z "$SFU_LEVEL" ]; then
		WHY="the running dilla-media's media level is unknown (${SFU_VERSION:-no version} from $SFU_FROM)"
	elif [ "$SFU_LEVEL" -ge "$NEW_MIN" ]; then
		DECISION=keep
		WHY="dilla-media runs v$SFU_VERSION (media level $SFU_LEVEL, from $SFU_FROM), and v$NEW_VERSION works with level $NEW_MIN or later"
	else
		WHY="dilla-media runs v$SFU_VERSION (media level $SFU_LEVEL, from $SFU_FROM), and v$NEW_VERSION needs level $NEW_MIN or later"
	fi
	if [ "$DECISION" = keep ]; then
		log "decision: keep dilla-media running: $WHY. Only dilla restarts; live calls continue"
	else
		log "decision: restart dilla-media, which ends any live call: $WHY"
	fi
}

# live_calls_preflight refuses (exit 1, nothing touched) while a room has participants or when the
# check cannot be made, unless the operator accepted ending the calls. It runs only when the upgrade
# restarts the SFU, at the moment it is about to stop things: an answer from earlier does not count.
# A release that keeps the SFU never comes here, so live calls never refuse it. `media --rooms`
# prints "no live rooms", or per room "<room><TAB><n> participants" followed by the participants'
# identities indented by two spaces.
live_calls_preflight() {
	_rooms=""
	if [ "$LIVEKIT_MODE_BEFORE" != sidecar ]; then
		_why="livekit.mode is $LIVEKIT_MODE_BEFORE, so the SFU runs inside dilla and its rooms cannot be listed; this upgrade restarts it and ends every live call"
	elif ! systemctl is-active --quiet dilla-media; then
		# A stopped SFU holds no rooms (stopped by hand, or a rollback that stopped it first).
		log "dilla-media is not running, so there are no live calls"
		return 0
	elif _rooms="$(runuser -u dillad -- "$BIN_DIR/dillad" media --rooms --config="$CONF")"; then
		_busy="$(printf '%s\n' "$_rooms" | awk -F'\t' '$2 ~ /^[1-9][0-9]* participants$/ { print "  " $1 ": " $2 }')"
		if [ -z "$_busy" ]; then
			case "$_rooms" in
			"no live rooms" | *participants*) return 0 ;;
			esac
			_why="dillad media --rooms printed something unexpected: $_rooms"
		else
			_why="there are live calls, and restarting the SFU disconnects everyone in them"
			log "live rooms:"
			printf '%s\n' "$_busy" | while IFS= read -r _line; do log "$_line"; done
		fi
	else
		_why="could not list the live rooms (runuser -u dillad -- $BIN_DIR/dillad media --rooms --config=$CONF failed)"
	fi
	if [ "$LIVEKIT_MODE_BEFORE" = sidecar ] && [ "$RESTART_SFU" -eq 1 ]; then
		log "warning: $_why; continuing because of --restart-sfu"
		return 0
	fi
	if [ "$ASSUME_YES" -eq 1 ]; then
		log "warning: $_why; continuing because of --yes"
		return 0
	fi
	if [ "$LIVEKIT_MODE_BEFORE" != sidecar ]; then
		die "$_why. Nothing was changed. Pass --yes to upgrade anyway, ending any live calls"
	fi
	die "$_why. Nothing was changed. Try again when the rooms are empty, or pass --restart-sfu to restart the media server anyway, ending the calls"
}

# upgrade_lock: one upgrade at a time, and dilla-media-refresh (which takes the same lock, and skips
# a minute while it is held) never restarts a service in the middle of one.
upgrade_lock() {
	if ! have flock; then
		log "warning: flock is not installed, so dilla-media-refresh.timer is not held off during this upgrade"
		return 0
	fi
	mkdir -p "$ROOT/run"
	exec 9>"$ROOT/run/dilla-install.lock"
	flock -w 900 9 || die "another install.sh or dilla-media-refresh holds $ROOT/run/dilla-install.lock; nothing was changed"
}

# wait_media_ready VERSION NOTIFY: the RUNNING dilla-media is VERSION and ready, within MEDIA_WAIT
# seconds. It never takes the installed binary's word for it: once restarts are decoupled the
# installed dillad and the running one can differ, so a probe run from the installed binary would
# pass and prove nothing. First, always, identity: the unit is active (which a Type=notify unit is
# only after READY) and the running executable's SHA-256, read as data, is the installed binary's.
# Then, for a dillad that sends READY=1 (NOTIFY 1): media.json's pid is the MainPID and names
# VERSION, and the process itself answers on media.sock with VERSION and that pid. For an older one
# (no media.sock): the authenticated RoomService probe. A start that failed may still come up
# through systemd's Restart=on-failure, so the wait does not end at the first failure.
wait_media_ready() {
	wmr_i=0
	while :; do
		if systemctl is-active --quiet dilla-media; then
			wmr_sum="$(sha256_of "$PROC/$(media_main_pid)/exe")"
			if [ -n "$wmr_sum" ] && [ "$wmr_sum" = "$(sha256_of "$BIN_DIR/dillad")" ]; then
				if [ "$2" -eq 1 ]; then
					if media_state && [ "$MS_VERSION" = "$1" ] && media_self && [ "$SELF_VERSION" = "$1" ]; then return 0; fi
				elif runuser -u dillad -- "$BIN_DIR/dillad" media --probe --config="$CONF" >&2; then
					return 0
				fi
			fi
		fi
		[ "$wmr_i" -lt "$MEDIA_WAIT" ] || return 1
		sleep 1
		wmr_i=$((wmr_i + 1))
	done
}

# restart_api: restarts dilla and waits for it. A Type=notify restart that fails can still come up
# through systemd's Restart=on-failure (serve exits 69 while it cannot bind api.sock or reach
# dilla-media), so a failed restart is followed by a bounded wait for systemd's own retry.
restart_api() {
	systemctl restart dilla >&2 && return 0
	log "dilla did not report ready; waiting up to $API_WAIT s for systemd's own restart of it (Restart=on-failure)"
	ra_i=0
	while [ "$ra_i" -lt "$API_WAIT" ]; do
		sleep 1
		if systemctl is-active --quiet dilla; then
			log "dilla came up on systemd's restart"
			return 0
		fi
		ra_i=$((ra_i + 1))
	done
	return 1
}

# restore_prev: the previous binary and core back in place, and dilla-media.service rewritten for
# the previous binary (no PartOf either way, so starting dilla never restarts the SFU).
restore_prev() {
	put "$BIN_DIR/dillad.prev" "$BIN_DIR/dillad" 0755
	put "$BIN_DIR/$CORE_NAME.prev" "$BIN_DIR/$CORE_NAME" 0644
	NEW_LEVEL="$OLD_LEVEL"
	write_media_unit "$(media_unit_type)"
	systemctl daemon-reload >&2 || :
	[ "$OLD_LEVEL" -ge 2 ] || systemctl disable --now dilla-media-refresh.timer >&2 || :
}

# restart_media_on_previous: dilla-media back on the previous binary, stopped first so the new one
# lets go of turn.listen before anything else binds it.
restart_media_on_previous() {
	systemctl stop dilla-media >&2 || :
	systemctl start dilla-media >&2 || :
	wait_media_ready "$OLD_VERSION" "$OLD_NOTIFY" ||
		log "warning: dilla-media did not become ready on the previous binary; read journalctl -o cat -u dilla-media"
}

# api_rollback: dilla did not come up on the new binary. The database goes back to the schema the
# previous binary reads, the previous pair goes back, and, when dilla-media was restarted onto the
# new binary, dilla-media is stopped and started on the previous one before dilla starts. A kept
# dilla-media is not touched: it still runs the previous binary.
api_rollback() {
	log "error: dilla did not restart with the new binary"
	# Stopped first: systemd restarts a failed dilla on its own (Restart=on-failure), and each
	# start of the new binary would migrate the database up again.
	STOPPED=1
	systemctl stop dilla >&2 || STOPPED=0
	# Read with the PREVIOUS binary: it loaded this dilla.toml a minute ago, and its `migrate
	# status` reports a newer schema without refusing it. The new binary may refuse the config
	# (a release that validates it more strictly), in which case it never migrated anything.
	SCHEMA_AFTER=""
	SCHEMA_AFTER="$(schema_version "$BIN_DIR/dillad.prev")" || {
		SCHEMA_AFTER=""
		rollback_stuck "could not read the database's schema version with the previous binary"
	}
	if [ "$SCHEMA_AFTER" -gt "$SCHEMA_BEFORE" ]; then
		# The new binary got past its config load and migrated, so it can take the database down.
		[ "$STOPPED" -eq 1 ] || rollback_stuck "dilla could not be stopped, so the database cannot be migrated down safely"
		log "the new binary migrated the database from schema $SCHEMA_BEFORE to $SCHEMA_AFTER; taking it back to $SCHEMA_BEFORE"
		runuser -u dillad -- "$BIN_DIR/dillad" migrate down --to="$SCHEMA_BEFORE" --i-know-what-i-am-doing --config="$CONF" >&2 ||
			rollback_stuck "migrate down --to=$SCHEMA_BEFORE failed"
	fi
	log "putting the previous binary and core back"
	if [ "$LIVEKIT_MODE_BEFORE" = in_process ]; then
		systemctl disable --now dilla-media >&2 || :
		cp -p "$CONF.prev" "$CONF"
	fi
	restore_prev
	if [ "$LIVEKIT_MODE_BEFORE" = sidecar ] && [ "$MEDIA_RESTARTED" -eq 1 ]; then
		log "dilla-media runs the new binary: stopping it, then starting it on the previous one before dilla"
		restart_media_on_previous
	fi
	# dilla was stopped above; one that could not be stopped is restarted onto the previous binary.
	api_verb=start
	[ "$STOPPED" -eq 1 ] || api_verb=restart
	if systemctl "$api_verb" dilla >&2; then
		die "the upgrade failed and was rolled back; the previous release is running. Read why with: journalctl -o cat -u dilla"
	fi
	die "the upgrade failed and was rolled back, but dilla did not start with the previous binary either; read its log with: journalctl -o cat -u dilla"
}

# ---------------------------------------------------------------- upgrade ----
if [ "$UPGRADE" -eq 1 ]; then
	log "upgrading $BIN_DIR/dillad and $BIN_DIR/$CORE_NAME to v$NEW_VERSION"
	upgrade_lock
	LIVEKIT_MODE_BEFORE="$(livekit_mode)"
	case "$LIVEKIT_MODE_BEFORE" in
	in_process | sidecar) ;;
	*) die "livekit.mode is $LIVEKIT_MODE_BEFORE; the upgrade supports in_process or sidecar" ;;
	esac
	MEDIA_DATA="$(conf_value instance data_dir)"
	[ -n "$MEDIA_DATA" ] || MEDIA_DATA="$DATA_DIR"
	# A release below web3.12 refuses turn.listen in public mode (its config validation), so a
	# rollback there with the web3.12 opt-in set would leave the instance down (R-UP11).
	if ! web312_or_later "$NEW_VERSION" && [ "$(conf_value tls mode)" = acme_tls_alpn ] && [ -n "$(conf_value turn listen)" ]; then
		die "v$NEW_VERSION refuses turn.listen in public mode (tls.mode = acme_tls_alpn), and dilla.toml sets it: remove turn.listen from dilla.toml first; public-mode TURN goes back to 443. Nothing was changed"
	fi
	# The binary being replaced: what a rollback starts again, and how its media server reports ready.
	OLD_VERSION="$("$BIN_DIR/dillad" version 2>/dev/null | awk '$1 == "dillad" { print $2; exit }')" || OLD_VERSION=""
	OLD_LEVEL="$(json_get "$("$BIN_DIR/dillad" version --json 2>/dev/null | head -n 1)" media_level)"
	case "$OLD_LEVEL" in '' | *[!0-9]*) OLD_LEVEL=1 ;; esac
	OLD_NOTIFY=0
	[ "$OLD_LEVEL" -lt 2 ] || OLD_NOTIFY=1
	# The schema the previous binary runs on. The new binary migrates the database when it
	# starts, and a dillad refuses a database newer than its own migrations, so a rollback must
	# first take the database back to this version, with the new binary (the only one that knows
	# the way down).
	SCHEMA_BEFORE="$(schema_version "$BIN_DIR/dillad")" ||
		die "could not read the database's schema version with the installed binary (runuser -u dillad -- $BIN_DIR/dillad migrate status --config=$CONF); nothing was changed"
	MEDIA_RESTARTED=0
	DECISION=restart
	SFU_LEVEL=""
	SFU_VERSION=""
	if [ "$LIVEKIT_MODE_BEFORE" = sidecar ]; then
		sfu_level
		sfu_decision
	fi
	if [ "$ASSUME_YES" -eq 1 ] && [ "$RESTART_SFU" -eq 0 ] && [ "$LIVEKIT_MODE_BEFORE" = sidecar ]; then
		log "note: --yes only lets a restart that this release needs end live calls; --restart-sfu restarts dilla-media now. --yes goes away in the next release"
	fi
	# Last check before anything is written or stopped, and only when the SFU restarts.
	[ "$DECISION" = keep ] || live_calls_preflight

	# The previous pair stays beside the new one, for the rollback below and by hand.
	cp -p "$BIN_DIR/dillad" "$BIN_DIR/dillad.prev"
	cp -p "$BIN_DIR/$CORE_NAME" "$BIN_DIR/$CORE_NAME.prev"
	cp -p "$CONF" "$CONF.prev"
	put "$WORK/$BIN_NAME" "$BIN_DIR/dillad" 0755
	put "$WORK/$CORE_NAME" "$BIN_DIR/$CORE_NAME" 0644
	write_media_unit "$(media_unit_type)"
	write_refresh_units
	systemctl daemon-reload >&2 || die "systemd could not load dilla-media.service"
	refresh_timer

	if [ "$LIVEKIT_MODE_BEFORE" = in_process ]; then
		# The one path that still ends calls by design: the SFU leaves the API process.
		log "moving the SFU into dilla-media.service"
		systemctl stop dilla >&2 || die "could not stop the previous in-process SFU"
		set_livekit_mode sidecar
		systemctl enable --now dilla-media >&2 || :
		if ! wait_media_ready "$NEW_VERSION" "$NEW_NOTIFY"; then
			log "error: dilla-media did not start; restoring the previous binary and config"
			systemctl disable --now dilla-media >&2 || :
			cp -p "$CONF.prev" "$CONF"
			restore_prev
			systemctl start dilla >&2 || :
			die "the media service did not start; read journalctl -o cat -u dilla-media"
		fi
		MEDIA_RESTARTED=1
		log "restarting dilla"
		restart_api || api_rollback
		doctor_and_report || exit 1
		log "upgrade done: dilla and dilla-media run v$NEW_VERSION; the previous binary, core and config are kept as $BIN_DIR/dillad.prev, $CORE_NAME.prev and $CONF.prev"
		log "dilla.service was not rewritten; compare it with the release's deploy/dilla.service"
		exit 0
	fi

	if [ "$DECISION" = keep ]; then
		log "restarting dilla; dilla-media keeps running v$SFU_VERSION"
		restart_api || api_rollback
		doctor_and_report || exit 1
		log "upgrade done: dilla runs v$NEW_VERSION. dilla-media keeps v$SFU_VERSION until its calls end; dilla-media-refresh.timer then restarts it onto v$NEW_VERSION"
	else
		# Each restarts once, dilla-media first: the API then sees the new SFU's capabilities at
		# its start (R-UP11), and a media server that does not come up never takes the API down.
		MEDIA_RESTARTED=1
		if ! web312_or_later "$NEW_VERSION" && [ "${SFU_LEVEL:-0}" -ge 2 ]; then
			log "rolling back below v0.1.0-web3.12 while dilla-media runs v$SFU_VERSION, which holds turn.listen: stopping dilla-media first, which ends every live call, then starting it on v$NEW_VERSION before dilla"
			systemctl stop dilla-media >&2 || die "could not stop dilla-media; nothing else was restarted"
			systemctl start dilla-media >&2 || log "dilla-media did not report ready at once; waiting up to $MEDIA_WAIT s for systemd's retry"
		else
			log "restarting dilla-media on v$NEW_VERSION first"
			systemctl restart dilla-media >&2 || log "dilla-media did not report ready at once; waiting up to $MEDIA_WAIT s for systemd's retry"
		fi
		if ! wait_media_ready "$NEW_VERSION" "$NEW_NOTIFY"; then
			log "error: dilla-media did not become ready on v$NEW_VERSION; putting the previous binary back (dilla was not restarted and still runs the previous release)"
			restore_prev
			restart_media_on_previous
			die "the media service did not start on the new binary; read journalctl -o cat -u dilla-media"
		fi
		log "dilla-media runs v$NEW_VERSION; restarting dilla"
		restart_api || api_rollback
		# The TURN handoff: the new dilla-media binds turn.listen once the API let go of it.
		if [ "$NEW_NOTIFY" -eq 1 ] && turn_listen_served && has_turn "$(json_get "$NEW_JSON" media_capabilities)"; then
			th_i=0
			until media_state && has_turn "$MS_CAPS"; do
				if [ "$th_i" -ge "$MEDIA_WAIT" ]; then
					log "warning: dilla-media has not bound turn.listen $MEDIA_WAIT s after dilla restarted; dillad doctor's turn leg names who serves TURN"
					break
				fi
				sleep 1
				th_i=$((th_i + 1))
			done
			if has_turn "$MS_CAPS"; then log "dilla-media serves TURN on turn.listen"; fi
		fi
		doctor_and_report || exit 1
		log "upgrade done: dilla and dilla-media run v$NEW_VERSION"
	fi
	log "the previous binary, core and config are kept as $BIN_DIR/dillad.prev, $CORE_NAME.prev and $CONF.prev"
	log "dilla.service was not rewritten; compare it with the release's deploy/dilla.service"
	exit 0
fi

# ---------------------------------------------------------------- install ----
log "installing dillad ($ARCH) per docs/deploy §3"
mkdir -p "$BIN_DIR" "$ROOT/etc/systemd/system"
put "$WORK/$BIN_NAME" "$BIN_DIR/dillad" 0755
# Beside the binary: dillad looks for the wasi core in its own executable's directory.
put "$WORK/$CORE_NAME" "$BIN_DIR/$CORE_NAME" 0644

# deploy/dilla.service, verbatim (deploy/install_test.sh compares the two).
cat >"$WORK/dilla.service" <<'UNIT'
[Unit]
Description=dilla server (dillad)
Documentation=https://github.com/jonasthim/dilla/blob/main/docs/deploy/README.md
After=network-online.target dilla-media.service
Wants=network-online.target dilla-media.service

[Service]
Type=notify
NotifyAccess=main
ExecStart=/usr/local/bin/dillad serve --config=%E/dilla/dilla.toml
Restart=on-failure
RestartSec=5s
# exit.Config (78) means the operator must fix dilla.toml; restarting would loop.
RestartPreventExitStatus=78
# WatchdogSec is deliberately NOT set: dillad sends READY=1 and nothing else over
# NOTIFY_SOCKET, so a watchdog would have systemd abort a healthy service after
# the first interval.
# ACME issuance plus goose migrations plus the pre-migration VACUUM INTO can
# exceed the 90 s default on a large SQLite file.
TimeoutStartSec=300s
TimeoutStopSec=45s

User=dillad
Group=dillad
StateDirectory=dillad
# The default is 0755; this directory holds instances.key_history, the franking
# key and the database.
StateDirectoryMode=0700
ConfigurationDirectory=dilla
UMask=0077

# How a non-root process binds 443/tcp.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectProc=invisible
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
# AF_NETLINK is required, not optional: Go's net.Interfaces reads the interface
# addresses over netlink, and LiveKit's SFU setup and pion/turn's network both
# call it. Without it serve fails at start with "netlinkrib: address family not
# supported by protocol".
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictSUIDSGID=yes
LockPersonality=yes
# MemoryDenyWriteExecute is deliberately NOT set: wazero's compiler back end
# writes and then executes generated machine code, so setting it would make the
# MLS path fail at runtime rather than at start. A blind copy of a hardening
# template is exactly how that regression arrives.

[Install]
WantedBy=multi-user.target
UNIT
put "$WORK/dilla.service" "$UNIT_PATH" 0644

# deploy/dilla-media.service, and the refresh timer with its service and script, verbatim.
write_media_unit "$(media_unit_type)"
write_refresh_units

if getent passwd dillad >/dev/null 2>&1; then
	log "the dillad user exists"
else
	useradd --system --user-group --no-create-home --home-dir /var/lib/dillad --shell /usr/sbin/nologin dillad >&2
fi

# init needs --public-ip and --agree-tos whatever the mode. Behind a proxy
# without an address it gets loopback, and both values are corrected below.
INIT_IP="$PUBLIC_IP"
[ -n "$INIT_IP" ] || INIT_IP="127.0.0.1"
log "initialising the instance"
# init writes the config straight to $CONF, so its directory exists first.
install -d -m 0755 "$CONF_DIR"
INIT_OUT="$("$BIN_DIR/dillad" init --config="$CONF" --data-dir="$DATA_DIR" --domain="$DOMAIN" --public-ip="$INIT_IP" --agree-tos)" ||
	die "dillad init failed"
LINK="$(printf '%s\n' "$INIT_OUT" | sed -n 's|^bootstrap invite.*: \(https://[^ ]*\)$|\1|p' | head -n 1)"
# Everything init printed except the link itself, which has one destination.
printf '%s\n' "$INIT_OUT" | grep -v '^bootstrap invite' >&2 || :
[ -n "$LINK" ] || die "dillad init did not print a bootstrap invite link"
POST_INIT=1

# toml_set TABLE KEY VALUE: replaces the value of KEY in [TABLE] of the file
# init wrote. VALUE is TOML text; its characters were validated above.
toml_set() {
	awk -v t="[$1]" -v k="$2" -v v="$3" '
		{ line = $0; sub(/^[ \t]+/, "", line) }
		line ~ /^\[/ { inside = (line == t) }
		inside && index(line, k " = ") == 1 {
			indent = substr($0, 1, length($0) - length(line))
			print indent k " = " v
			found = 1
			next
		}
		{ print }
		END { if (!found) exit 3 }
	' "$CONF" >"$WORK/dilla.toml" || die "dilla.toml has no $2 in [$1]; this dillad's init writes a layout this install.sh does not know (use the install.sh of the same release)"
	cat "$WORK/dilla.toml" >"$CONF"
}

toml_set livekit udp_port "$UDP_PORT"
toml_set livekit mode "'sidecar'"
[ -z "$NODE_IP" ] || toml_set livekit node_ip "'$NODE_IP'"
if [ "$MODE" = behind-proxy ]; then
	log "configuring tls.mode = behind_proxy on $LISTEN"
	toml_set tls mode "'behind_proxy'"
	# The operator accepted no CA agreement, and none is needed behind a proxy.
	toml_set tls agreed false
	toml_set server plain_listen "'$LISTEN'"
	cidrs=""
	for cidr in $TRUSTED; do
		cidrs="${cidrs:+$cidrs, }'$cidr'"
	done
	toml_set server trusted_proxy_cidrs "[$cidrs]"
	# init writes turn.enabled = true; behind a proxy the relay would need a
	# turn.listen port of its own (docs/deploy §1), so it stays off.
	toml_set turn enabled false
	if [ -z "$PUBLIC_IP" ]; then
		toml_set instance public_ip "''"
		[ -n "$NODE_IP" ] || toml_set livekit node_ip "''"
	fi
fi

log "setting the owners and modes of $CONF and $DATA_DIR"
chown root:dillad "$CONF"
chmod 0640 "$CONF"
chown -R dillad:dillad "$DATA_DIR"
chmod 0700 "$DATA_DIR"

# The edited file passes dillad's own config check (strict decoding plus
# Validate) before the unit is enabled, so a bad value never reaches a start loop.
log "checking dilla.toml"
run_doctor
if ! printf '%s\n' "$DOCTOR_OUT" | grep -q '^OK  *config '; then
	printf '%s\n' "$DOCTOR_OUT" | grep '^FAIL  *config ' >&2 || printf '%s\n' "$DOCTOR_OUT" | sed 's/^/  /' >&2
	die "dillad refuses the edited /etc/dilla/dilla.toml; the service was not started"
fi

log "starting the service"
STATUS=0
MEDIA_DATA="$DATA_DIR"
if systemctl daemon-reload >&2 && { systemctl enable --now dilla-media >&2 || :; } &&
	wait_media_ready "$NEW_VERSION" "$NEW_NOTIFY" &&
	systemctl enable --now dilla >&2; then
	refresh_timer
	doctor_and_report || STATUS=1
else
	STATUS=1
	log "error: the service did not start; read its log with: journalctl -o cat -u dilla"
fi

# ------------------------------------------------------------- next steps ----
if [ "$MODE" = behind-proxy ]; then
	port="${LISTEN##*:}"
	log ""
	log "next steps in Pangolin (or any TLS-terminating proxy):"
	log "  1. an HTTPS resource for $DOMAIN whose target is http://<this host's address>:$port;"
	log "     Pangolin SSO (resource authentication) OFF for it, dilla signs its users in itself;"
	log "     WebSocket upgrades must pass through (Traefik passes them by default; add no"
	log "     middleware that strips Upgrade or Connection)."
	log "  2. the raw UDP forward for media, $UDP_PORT/udp to this host: a Traefik UDP entry point"
	log "     udp-$UDP_PORT on \":$UDP_PORT/udp\" with udp.timeout 30s, $UDP_PORT:$UDP_PORT/udp published on"
	log "     the gerbil service, and a raw UDP resource with exactly one target, this host's $UDP_PORT/udp."
	log "     The tunnel MTU stays 1280."
	log "     See docs/deploy/README.md, \"Behind a WireGuard tunnel (Pangolin)\"."
	if [ -z "$NODE_IP" ] && [ -z "$PUBLIC_IP" ]; then
		log "  3. livekit.node_ip is empty: set it in /etc/dilla/dilla.toml to the public address clients"
		log "     send $UDP_PORT/udp to (the Pangolin server's), then systemctl restart dilla. Until"
		log "     then calls cannot reach the SFU from outside this host."
	fi
	log "  Only the proxy's own address belongs in --trusted-proxy: any host in that range can set"
	log "  X-Forwarded-For and pick the address dillad rate-limits it by."
	log "  TURN is off (tls.mode = behind_proxy): a member behind a UDP-blocking network cannot join calls."
else
	log ""
	log "next steps:"
	log "  1. DNS: $DOMAIN resolving to $PUBLIC_IP."
	log "  2. forward 443/tcp and $UDP_PORT/udp to this host; nothing else needs to be open."
fi
log "  then: runuser -u dillad -- /usr/local/bin/dillad doctor --config=/etc/dilla/dilla.toml"
log ""
log "the bootstrap invite link is the line on stdout; it is valid for 24 hours, works once and is not stored anywhere."

# The link is printed once, even when the service failed to start: the invite
# stays valid for 24 hours and cannot be shown again.
LINK_PRINTED=1
printf '%s\n' "$LINK"
exit "$STATUS"
