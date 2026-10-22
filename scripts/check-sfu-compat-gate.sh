#!/usr/bin/env bash
# The release gate on ci.yml's sfu-compat job: the commit being released must have a completed ci.yml push run whose
# sfu-compat job concluded success (scripts/release-meta.mjs compatGate). Needs gh, GH_TOKEN (actions: read), REPO and SHA.
set -euo pipefail
: "${REPO:?REPO is owner/name}"
: "${SHA:?SHA is the commit being released}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d)
gh api "repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$SHA&event=push&status=completed&per_page=50" >"$work/runs.json"
run=$(node "$here/release-meta.mjs" pick-run --runs "$work/runs.json")
gh api "repos/$REPO/actions/runs/$run/jobs?per_page=100" >"$work/jobs.json"
node "$here/release-meta.mjs" gate --jobs "$work/jobs.json"
