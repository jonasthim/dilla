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
# It works for a web3.11 media server too, which knows nothing of this.
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

main_pid() {
	p="$(systemctl show -P MainPID dilla-media 2>/dev/null)"
	case "$p" in '' | *[!0-9]*) echo 0 ;; *) echo "$p" ;; esac
}

DATA="$(conf_value instance data_dir)"
[ -n "$DATA" ] || DATA="$ROOT/var/lib/dillad"

# media_state PID: sets MS_VERSION, MS_LEVEL and MS_CAPS from media.json when its pid is PID, the
# unit's MainPID; a file left by an earlier process (a crash, a reboot) counts as absent.
media_state() {
	MS_VERSION=""
	MS_LEVEL=0
	MS_CAPS=""
	[ "$1" -gt 0 ] || return 1
	ms="$(cat "$DATA/media.json" 2>/dev/null)" || return 1
	[ "$(json_get "$ms" pid)" = "$1" ] || return 1
	MS_VERSION="$(unquote "$(json_get "$ms" version)")"
	MS_LEVEL="$(json_get "$ms" media_level)"
	case "$MS_LEVEL" in '' | *[!0-9]*) MS_LEVEL=0 ;; esac
	MS_CAPS="$(json_get "$ms" capabilities)"
	[ -n "$MS_VERSION" ]
}

# restart_api_for_handoff: restarts dilla, so it lets go of turn.listen, and waits WAIT seconds for
# media.json to list "turn". It ends the run.
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
running="$(stat -L -c '%d:%i' "$ROOT/proc/$pid/exe" 2>/dev/null)" || exit 0
installed="$(stat -L -c '%d:%i' "$BIN" 2>/dev/null)" || exit 0

turn_configured=0
if [ "$(conf_value turn enabled)" = true ] && [ -n "$(conf_value turn listen)" ]; then
	turn_configured=1
fi
new_json="$(runuser -u dillad -- "$BIN" version --json 2>/dev/null)" || new_json=""
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

if [ "$running" = "$installed" ]; then
	# The SFU already runs the installed dillad. Only a handoff that never happened is left: the SFU
	# came up on this binary on its own (systemd restarted it after a crash) while the API still
	# held turn.listen. Once per media process, so a port that cannot be bound for another reason
	# never restarts the API in a loop.
	if [ "$handoff" -ne 1 ] || [ "$before_valid" -ne 1 ] || [ "$MS_LEVEL" -lt 2 ]; then
		exit 0
	fi
	[ "$(cat "$MARK" 2>/dev/null)" != "$pid" ] || exit 0
	idle || exit 0
	echo "$pid" >"$MARK"
	log "dilla-media (pid $pid) runs the installed dillad but has not bound turn.listen, which dilla still holds; its rooms are idle: restarting dilla to hand TURN over"
	restart_api_for_handoff
fi

idle || exit 0
old="${MS_VERSION:-}"
[ -n "$old" ] || old="$("$ROOT/proc/$pid/exe" version 2>/dev/null | awk '$1 == "dillad" { print $2; exit }')"
log "dilla-media runs ${old:-an older dillad} (pid $pid), not the installed $BIN; its rooms are idle: restarting it"
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
