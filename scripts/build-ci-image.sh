#!/usr/bin/env bash
set -euo pipefail

# CI uses only push-to-main and pull_request. Validate before invoking Docker so
# an unexpected trigger cannot gain a registry output by accident.
case "${GITHUB_EVENT_NAME:-}:${GITHUB_REF:-}" in
  push:refs/heads/main)
    version=main
    publish=true
    ;;
  pull_request:refs/pull/*/merge)
    if [[ $GITHUB_REF =~ ^refs/pull/([0-9]+)/merge$ ]]; then
      version=pr-${BASH_REMATCH[1]}
    else
      echo "unexpected pull request ref: $GITHUB_REF" >&2
      exit 1
    fi
    publish=false
    ;;
  *) echo "image build refused for ${GITHUB_EVENT_NAME:-unset}:${GITHUB_REF:-unset}" >&2; exit 1 ;;
esac

[[ ${GITHUB_SHA:-} =~ ^[0-9a-f]{40}$ ]] || { echo 'invalid commit SHA' >&2; exit 1; }
[[ ${GITHUB_REPOSITORY:-} =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo 'invalid repository name' >&2
  exit 1
}
repository=${GITHUB_REPOSITORY,,}
image=ghcr.io/$repository/dillad
short_sha=${GITHUB_SHA:0:7}

docker buildx version
# Pin the executable BuildKit daemon image as well as the workflow tools.
docker buildx create --driver docker-container --use --bootstrap \
  --driver-opt image=moby/buildkit@sha256:f5bf1331bda8069997e7d7d4f8977d6c0e5e6f12f770ec06015a34f8bc0f5428

args=(
  --platform linux/amd64,linux/arm64
  --provenance=mode=max
  --sbom=true
  --build-arg "VERSION=$version"
  --build-arg "COMMIT=$GITHUB_SHA"
)
if [[ $publish == true ]]; then
  args+=(
    --tag "$image:latest"
    --tag "$image:main"
    --tag "$image:sha-$short_sha"
    --push
  )
else
  args+=(--output type=cacheonly)
fi
docker buildx build "${args[@]}" .

if [[ $publish == true ]]; then
  # A manifest with only one architecture must not count as a successful push.
  docker buildx imagetools inspect --raw "$image:sha-$short_sha" \
    | jq -e '[.manifests[] | select(.platform.os == "linux") | .platform.architecture] | sort == ["amd64", "arm64"]' >/dev/null
fi
