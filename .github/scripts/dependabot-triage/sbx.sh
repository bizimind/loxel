#!/usr/bin/env bash
# Runs one shell command as the unprivileged `sandbox` user, in its copy of the repo, with a clean
# environment. The triage agent runs everything through this: the PR's freshly updated
# dependencies execute here, where they cannot read the runner user's processes or secrets.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: sbx '<command>'" >&2
  exit 2
fi

exec sudo -u sandbox -H -- env -i \
  PATH=/usr/local/bin:/usr/bin:/bin \
  HOME=/home/sandbox \
  LANG=C.UTF-8 \
  CI=true \
  bash -c 'cd /srv/triage/repo && eval "$1"' sbx "$1"
