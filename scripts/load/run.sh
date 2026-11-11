#!/usr/bin/env bash
# Load test in an isolated Docker Compose project ("tixload"); see docs/LOAD-TEST.md.
# All options are passed through to run.mjs, e.g.:
#   scripts/load/run.sh --vus 200
#   scripts/load/run.sh --vus 1200 --scenarios seat-rush,checkout-rush --keep
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node scripts/load/run.mjs "$@"
