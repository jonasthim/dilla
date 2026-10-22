#!/usr/bin/env bash
# Keeps the .deb files `playwright install --with-deps` downloads in an actions/cache directory, so a
# slow apt mirror on one runner cannot stall a browser job (PR #75: 21-23 minutes for 55 MB).
#   key      print the cache key suffix for this runner image (written to $GITHUB_OUTPUT by the workflow)
#   prepare  make apt keep what it downloads, and put the cached debs where apt looks for them
#   stash    copy the debs apt downloaded back into the cache directory
set -euo pipefail

dir="${APT_DEB_CACHE_DIR:-$HOME/.cache/apt-debs}"
archives=/var/cache/apt/archives

case "${1:-}" in
key)
  # ImageVersion is set in the runner's environment (not in the workflow `env` context).
  . /etc/os-release
  echo "${ID}-${VERSION_ID}-${ImageVersion:-unknown}"
  ;;
prepare)
  mkdir -p "$dir"
  # The image may keep apt from retaining downloads (docker-clean style config).
  echo 'APT::Keep-Downloaded-Packages "true";' | sudo tee /etc/apt/apt.conf.d/99keep-debs >/dev/null
  sudo rm -f /etc/apt/apt.conf.d/docker-clean
  if compgen -G "$dir/*.deb" >/dev/null; then
    sudo cp "$dir"/*.deb "$archives"/
    echo "restored $(ls "$dir"/*.deb | wc -l) cached debs"
  else
    echo "no cached debs"
  fi
  ;;
stash)
  mkdir -p "$dir"
  if compgen -G "$archives/*.deb" >/dev/null; then
    sudo cp "$archives"/*.deb "$dir"/
  fi
  sudo chown -R "$(id -u):$(id -g)" "$dir"
  echo "cached $(find "$dir" -name '*.deb' | wc -l) debs"
  ;;
*)
  echo "usage: $0 key|prepare|stash" >&2
  exit 2
  ;;
esac
