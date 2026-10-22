#!/usr/bin/env bash
# Fetches the previous release's metadata (and with --binary its dillad-linux-amd64) into DIR and verifies it against the
# release's own SHA256SUMS. Used by release.yml (to compute sfu_restart) and ci.yml's sfu-compat job (the SFU binary to
# run), so both read the same release by the same rule (scripts/release-meta.mjs).
#
#   fetch-previous-release.sh DIR [--exclude-from TAG] [--binary]
#
# DIR gets: previous-tag (empty when there is no earlier release), SHA256SUMS, release.json when SHA256SUMS lists it
# (a release from before web3.12 has none: release-meta.mjs then counts web3.11 and later as media level 1), and with
# --binary dillad-linux-amd64 (executable). The previous release is the newest one below TAG on the web3 line, or the
# newest of all without --exclude-from. Needs gh and GH_TOKEN. Writes previous_tag= to $GITHUB_OUTPUT when it is set.
set -euo pipefail

dir=${1:?usage: fetch-previous-release.sh DIR [--exclude-from TAG] [--binary]}
shift
exclude=""
binary=0
while [ $# -gt 0 ]; do
  case "$1" in
    --exclude-from) exclude=${2:?--exclude-from needs a tag}; shift 2 ;;
    --binary) binary=1; shift ;;
    *) echo "fetch-previous-release: unknown argument $1" >&2; exit 2 ;;
  esac
done

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
rm -rf "$dir"
mkdir -p "$dir"

gh release list --exclude-drafts --limit 200 --json tagName >"$dir/list.json"
tag=$(node "$here/release-meta.mjs" previous-tag --list "$dir/list.json" --exclude-from "$exclude")
rm -f "$dir/list.json"
printf '%s\n' "$tag" >"$dir/previous-tag"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "previous_tag=$tag" >>"$GITHUB_OUTPUT"; fi
if [ -z "$tag" ]; then
  echo "no earlier release exists"
  exit 0
fi

gh release download "$tag" --pattern SHA256SUMS --dir "$dir"
assets=()
if node "$here/release-meta.mjs" lists-release-json "$dir/SHA256SUMS"; then
  gh release download "$tag" --pattern release.json --dir "$dir"
  assets+=(release.json)
fi
if [ "$binary" -eq 1 ]; then
  gh release download "$tag" --pattern dillad-linux-amd64 --dir "$dir"
  assets+=(dillad-linux-amd64)
fi

# Exactly one SHA-256 line per downloaded asset, by exact name; a SHA256SUMS that leaves one out cannot pass for it.
: >"$dir/check.sums"
for name in "${assets[@]}"; do
  line=$(awk -v n="$name" '($2 == n || $2 == "*" n) && $1 ~ /^[0-9a-f]+$/ && length($1) == 64' "$dir/SHA256SUMS")
  if [ "$(printf '%s\n' "$line" | grep -c .)" -ne 1 ]; then
    echo "fetch-previous-release: $tag SHA256SUMS does not hold exactly one SHA-256 line for $name" >&2
    exit 1
  fi
  printf '%s\n' "$line" >>"$dir/check.sums"
done
if [ "${#assets[@]}" -gt 0 ]; then
  (cd "$dir" && sha256sum -c --strict check.sums)
fi
rm -f "$dir/check.sums"
if [ "$binary" -eq 1 ]; then chmod +x "$dir/dillad-linux-amd64"; fi
echo "previous release $tag fetched and verified: ${assets[*]:-SHA256SUMS only}"
