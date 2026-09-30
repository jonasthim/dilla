#!/usr/bin/env bash
# Installs dillad in a new unprivileged Debian 13 LXC container on a Proxmox VE
# host, as a systemd service (deploy/dilla.service).
#
# stdout carries exactly one thing: the bootstrap invite link, printed once, so
# `link=$(./proxmox-lxc.sh ...)` captures it and nothing else. Every progress
# line, every command's output and every warning goes to stderr.
set -euo pipefail

log() { printf 'proxmox-lxc: %s\n' "$*" >&2; }
die() {
	log "error: $*"
	exit 1
}

usage() {
	cat >&2 <<'USAGE'
usage: proxmox-lxc.sh --domain NAME --public-ip IP --agree-tos [options]

required:
  --domain NAME        the public DNS name of the instance (instance.domain)
  --public-ip IP       the address clients reach the instance on, IPv4 or IPv6
  --agree-tos          accept the ACME CA's subscriber agreement (tls.agreed)

options:
  --ctid N             container id (default: the next free id)
  --hostname NAME      container hostname (default: dilla)
  --bridge NAME        network bridge (default: vmbr0)
  --storage NAME       rootfs storage (default: local-lvm)
  --template-storage N storage that holds the Debian template (default: local)
  --release-url URL    where dillad-linux-<arch> and dilla_core_wasi.wasm are
                       downloaded from (default: the latest release)
  --binary PATH        use this dillad binary instead of downloading one
  --core PATH          use this dilla_core_wasi.wasm instead of downloading one
USAGE
}

CTID=""
CT_HOSTNAME="dilla"
DOMAIN=""
PUBLIC_IP=""
AGREE_TOS=0
BRIDGE="vmbr0"
STORAGE="local-lvm"
TEMPLATE_STORAGE="local"
RELEASE_URL="https://github.com/jonasthim/dilla/releases/latest/download"
BINARY=""
CORE=""

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
	--agree-tos | -h | --help)
		shift
		;;
	--*)
		[ "$#" -ge 2 ] || die "$flag needs a value"
		value="$2"
		shift 2
		;;
	*)
		usage
		die "unexpected argument $flag"
		;;
	esac
	case "$flag" in
	--ctid) CTID="$value" ;;
	--hostname) CT_HOSTNAME="$value" ;;
	--domain) DOMAIN="$value" ;;
	--public-ip) PUBLIC_IP="$value" ;;
	--agree-tos) AGREE_TOS=1 ;;
	--bridge) BRIDGE="$value" ;;
	--storage) STORAGE="$value" ;;
	--template-storage) TEMPLATE_STORAGE="$value" ;;
	--release-url) RELEASE_URL="${value%/}" ;;
	--binary) BINARY="$value" ;;
	--core) CORE="$value" ;;
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

command -v pct >/dev/null 2>&1 || die "run this on a Proxmox host as root"
[ "$(id -u)" -eq 0 ] || die "run this on a Proxmox host as root"

if [ -z "$DOMAIN" ] || [ -z "$PUBLIC_IP" ]; then
	usage
	die "--domain and --public-ip are required"
fi
[ "$AGREE_TOS" -eq 1 ] || die "--agree-tos is required: tls.agreed records your acceptance of the ACME CA's subscriber agreement, and this script has no standing to accept it for you"

if [ -z "$CTID" ]; then
	if command -v pvesh >/dev/null 2>&1; then
		CTID="$(pvesh get /cluster/nextid)"
	else
		die "--ctid is required: pvesh is not available to choose the next free id"
	fi
fi
case "$CTID" in
'' | *[!0-9]*) die "--ctid must be a number, got \"$CTID\"" ;;
esac
if pct status "$CTID" >/dev/null 2>&1; then
	die "container $CTID already exists; choose another --ctid"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT="$SCRIPT_DIR/dilla.service"
[ -f "$UNIT" ] || die "dilla.service is not next to this script ($UNIT)"

case "$(uname -m)" in
x86_64) ARCH=amd64 ;;
aarch64) ARCH=arm64 ;;
*) die "unsupported host architecture $(uname -m): dillad is built for amd64 and arm64" ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The two artefacts first, so a bad URL fails before a container exists.
if [ -z "$BINARY" ]; then
	log "downloading dillad-linux-$ARCH"
	curl -fsSL -o "$WORK/dillad" "$RELEASE_URL/dillad-linux-$ARCH" >&2
	BINARY="$WORK/dillad"
fi
if [ -z "$CORE" ]; then
	log "downloading dilla_core_wasi.wasm"
	curl -fsSL -o "$WORK/dilla_core_wasi.wasm" "$RELEASE_URL/dilla_core_wasi.wasm" >&2
	CORE="$WORK/dilla_core_wasi.wasm"
fi
[ -s "$BINARY" ] || die "the dillad binary $BINARY is missing or empty"
[ -s "$CORE" ] || die "the wasi core $CORE is missing or empty"

log "looking for the Debian 13 template"
pveam update >&2 || log "warning: pveam update failed; using the template list already on this host"
TEMPLATE="$(pveam available --section system | awk '$2 ~ /^debian-13-standard/ { print $2 }' | sort -V | tail -n 1)"
[ -n "$TEMPLATE" ] || die "no debian-13-standard template is listed by pveam"
if ! pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE"; then
	log "downloading $TEMPLATE to $TEMPLATE_STORAGE"
	pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >&2
fi

# Unprivileged, with nesting: the unit's sandboxing directives (PrivateTmp,
# ProtectSystem, ...) need it to start inside a container.
log "creating container $CTID ($CT_HOSTNAME)"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
	--hostname "$CT_HOSTNAME" \
	--unprivileged 1 \
	--features nesting=1 \
	--memory 2048 \
	--cores 2 \
	--rootfs "$STORAGE:8" \
	--net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
	--onboot 1 \
	--ostype debian >&2
log "starting container $CTID"
pct start "$CTID" >&2
pct exec "$CTID" -- systemctl is-system-running --wait >/dev/null 2>&1 || true

ct() { pct exec "$CTID" -- "$@"; }

log "installing dillad"
pct push "$CTID" "$BINARY" /usr/local/bin/dillad --perms 0755 >&2
pct push "$CTID" "$CORE" /usr/local/bin/dilla_core_wasi.wasm --perms 0644 >&2
pct push "$CTID" "$UNIT" /etc/systemd/system/dilla.service --perms 0644 >&2
ct useradd --system --user-group --no-create-home --home-dir /var/lib/dillad --shell /usr/sbin/nologin dillad >&2

# init writes <data-dir>/dilla.toml; the unit reads /etc/dilla/dilla.toml, so the
# file is moved there once init has printed the invite.
log "initialising the instance"
INIT_OUT="$(ct /usr/local/bin/dillad init --data-dir=/var/lib/dillad --domain="$DOMAIN" --public-ip="$PUBLIC_IP" --agree-tos)"
LINK="$(printf '%s\n' "$INIT_OUT" | sed -n 's|^bootstrap invite.*: \(https://[^ ]*\)$|\1|p' | head -n 1)"
# Everything init printed except the link itself, which has one destination.
printf '%s\n' "$INIT_OUT" | grep -v '^bootstrap invite' >&2 || true
[ -n "$LINK" ] || die "dillad init did not print a bootstrap invite link"

ct install -d -m 0755 /etc/dilla >&2
ct install -m 0640 -o root -g dillad /var/lib/dillad/dilla.toml /etc/dilla/dilla.toml >&2
ct rm -f /var/lib/dillad/dilla.toml >&2
ct chown -R dillad:dillad /var/lib/dillad >&2
ct chmod 0700 /var/lib/dillad >&2

log "starting the service"
STARTED=1
ct systemctl daemon-reload >&2
ct systemctl enable --now dilla >&2 || STARTED=0
if [ "$STARTED" -eq 1 ]; then
	log "running dillad doctor"
	ct runuser -u dillad -- /usr/local/bin/dillad doctor --config=/etc/dilla/dilla.toml >&2 ||
		log "warning: dillad doctor reported a failing check; fix it (DNS for $DOMAIN, the firewall, the clock) and run it again"
else
	log "error: the service did not start; read its log with: pct exec $CTID -- journalctl -o cat -u dilla"
fi

# The link is printed once and is stored nowhere: the database holds only its
# SHA-256. It is printed even when the service failed to start, because the
# invite stays valid for 24 hours and cannot be shown again.
printf '%s\n' "$LINK"
[ "$STARTED" -eq 1 ] || exit 1
