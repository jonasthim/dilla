#!/bin/sh
# doctor-rust.sh - assert the Rust toolchain this repository pins is the one in use.
#
# rust-toolchain.toml is a rustup feature. A distro cargo ignores it silently, with no
# warning of any kind (gap-32-ci.md 1.1), so the pin has to be asserted out of band.
# Run from anywhere: every path below is derived from this script's own location.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cargo_home=${CARGO_HOME:-$HOME/.cargo}
problems=0

note() {
  printf 'MISSING: %s\n' "$1"
  problems=$((problems + 1))
}

want=$(sed -n 's/^channel = "\(.*\)"/\1/p' "$here/rust-toolchain.toml")
if [ -z "$want" ]; then
  note "rust-toolchain.toml has no [toolchain] channel"
  exit 1
fi

# 1. a user-scoped rustup toolchain at the pinned version
if [ ! -x "$cargo_home/bin/rustc" ]; then
  note "$cargo_home/bin/rustc (repo pins rustc $want)"
  printf '  fix: curl --proto =https --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --default-toolchain none --profile minimal\n'
else
  have=$("$cargo_home/bin/rustc" --version | awk '{print $2}')
  [ "$have" = "$want" ] || note "rustc $want (found $have at $cargo_home/bin/rustc)"
fi

# 2. both wasm targets, checked through the pinned rustc
for t in wasm32-unknown-unknown wasm32-wasip1; do
  if [ -x "$cargo_home/bin/rustc" ]; then
    d=$("$cargo_home/bin/rustc" --print target-libdir --target "$t" 2>/dev/null || true)
    if [ -z "$d" ] || [ ! -d "$d" ]; then
      note "target $t (fix: $cargo_home/bin/rustup target add $t)"
    fi
  else
    note "target $t (no pinned rustc to check it with)"
  fi
done

# 3. clippy and rustfmt
for c in cargo-clippy rustfmt; do
  [ -x "$cargo_home/bin/$c" ] || note "component binary $cargo_home/bin/$c"
done

# 4. wasm-bindgen-cli must match the wasm-bindgen crate in Cargo.lock exactly:
#    the crate and the CLI share a SCHEMA_VERSION (facts-ci.md 1.6).
#    Skipped until the workspace lockfile exists (it arrives in task 1).
if [ -f "$here/Cargo.lock" ]; then
  locked=$(awk '/^name = "wasm-bindgen"$/{getline; sub(/^version = "/,""); sub(/"$/,""); print; exit}' "$here/Cargo.lock")
  if [ -z "$locked" ]; then
    printf 'note: Cargo.lock does not contain wasm-bindgen; skipping the CLI check\n'
  elif [ ! -x "$cargo_home/bin/wasm-bindgen" ]; then
    note "$cargo_home/bin/wasm-bindgen (Cargo.lock pins wasm-bindgen $locked)"
  else
    cli=$("$cargo_home/bin/wasm-bindgen" --version | awk '{print $2}')
    [ "$cli" = "$locked" ] || note "wasm-bindgen CLI $locked (found $cli)"
  fi
else
  printf 'note: no Cargo.lock yet; skipping the wasm-bindgen CLI check\n'
fi

# 5. the other two toolchains this repository builds with
node_major=$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true)
if [ -z "$node_major" ] || [ "$node_major" -lt 24 ]; then
  note "node >= 24 (found ${node_major:-none})"
fi
# Go is user-installed at ~/.local/go/bin on this box (facts-local-toolchain.md) and may not be
# on PATH; probe both. The minor version is compared numerically - a glob would accept go1.3 and
# reject go1.40.
go_bin=$(command -v go 2>/dev/null || true)
[ -n "$go_bin" ] || { [ -x "$HOME/.local/go/bin/go" ] && go_bin="$HOME/.local/go/bin/go"; }
if [ -z "$go_bin" ]; then
  note "go >= go1.27.0 (found none)"
else
  go_ver=$("$go_bin" version | awk '{print $3}')
  go_minor=$(printf '%s' "$go_ver" | sed -n 's/^go1\.\([0-9][0-9]*\).*$/\1/p')
  if [ -z "$go_minor" ] || [ "$go_minor" -lt 27 ]; then
    note "go >= go1.27.0 (found ${go_ver:-none})"
  fi
fi

if [ "$problems" -eq 0 ]; then
  printf 'toolchain ok: rustc %s, wasm32-unknown-unknown + wasm32-wasip1, clippy, rustfmt\n' "$want"
  exit 0
fi
printf '%d problem(s)\n' "$problems"
[ "$problems" -gt 125 ] && exit 125
exit "$problems"
