#!/usr/bin/env bash
#
# Reproducible build of the committed plugin/ bundles (T-0322).
#
# The root package-lock.json is gitignored (upstream and CI resolve from
# package.json), so a plain `npm install` drifts with whatever npm publishes
# next. The bundles the fork ships come from the dependency set pinned in
# build-lock/package-lock.json instead: it is copied in for `npm ci`, removed
# afterwards, and nothing else about the build changes. See build-lock/README.md.
#
#   scripts/build-reproducible.sh            install pinned deps, build
#   scripts/build-reproducible.sh --verify   same, then fail if any committed
#                                            bundle (*.cjs / *.js) differs
#
# Source maps record where node_modules sat on the building machine, so they are
# not part of the --verify comparison.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

verify=0
[[ "${1:-}" == "--verify" ]] && verify=1

if [[ -e package-lock.json ]]; then
  echo "package-lock.json already exists at the repo root; move it away first." >&2
  exit 1
fi

cp build-lock/package-lock.json package-lock.json
trap 'rm -f "$root/package-lock.json"' EXIT

npm ci --no-audit --no-fund
npm run build

if (( verify )); then
  changed="$(git status --porcelain --untracked-files=all -- plugin | grep -E '\.c?js$' || true)"
  if [[ -n "$changed" ]]; then
    echo "Rebuilt bundles differ from the committed ones:" >&2
    echo "$changed" >&2
    exit 1
  fi
  echo "All committed bundles match the reproducible build."
fi
