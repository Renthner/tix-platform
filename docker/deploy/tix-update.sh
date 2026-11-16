#!/bin/sh
# TIX Platform - update script (release __TIX_VERSION__)
#
# Updates this installation: downloads the docker-compose.yml of the target release, verifies it
# against the SHA256SUMS.txt of that release, validates it with Docker Compose and pulls the images
# BEFORE anything is replaced, then keeps a timestamped copy of the current file, installs the new
# one and restarts the stack. It never touches .env or docker-compose.override.yml.
#
#   ./tix-update.sh [--dry-run] [--force] [VERSION|CHANNEL]
#
#   (no argument)   channel from TIX_VERSION in .env (default: stable)
#   1.2.0 / v1.2.0  that exact version (also 1.2.0-rc.1)
#   stable | next | alpha | beta | rc | 1 | 1.2     newest release of that channel (highest
#                   SemVer, alpha < beta < rc < final; looked up among the 100 newest releases)
#   --dry-run       download and verify into a temporary directory and show what would change;
#                   nothing is modified, no container is touched
#   --force         allow a LOWER version than the one of the current docker-compose.yml
#
# Going back to an older version is NOT supported once a newer one migrated the database (the old
# code cannot read the newer schema), hence the refusal without --force. The automatic pre-update
# backup restores your DATA on the version you are running; it is not a downgrade path.
#
# Put the file next to docker-compose.yml and run it from anywhere. Needs curl or wget, awk and
# Docker Compose >= 2.23.1. Environment: TIX_REPOSITORY (owner/name of the GitHub repository,
# default below), TIX_API_URL / TIX_DOWNLOAD_URL (mirrors; defaults: GitHub).
set -eu

REPOSITORY="${TIX_REPOSITORY:-__TIX_REPOSITORY__}"
API_URL="${TIX_API_URL:-https://api.github.com}"
DOWNLOAD_URL="${TIX_DOWNLOAD_URL:-https://github.com}"

DRY_RUN=0
FORCE=0
TARGET=""

say() { printf '%s\n' "$*"; }
die() {
  printf 'tix-update: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,/^set -eu/p' "$0" | sed -e '/^set -eu/d' -e 's/^# \{0,1\}//' -e '/^#!/d'
}

for arg in "$@"; do
  case "$arg" in
    --dry-run | -n) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option $arg (see --help)" ;;
    *)
      [ -z "$TARGET" ] || die "only one version or channel may be given"
      TARGET="$arg"
      ;;
  esac
done

case "$REPOSITORY" in
  __TIX*) die "this copy of the script does not know its repository: set TIX_REPOSITORY=owner/name or download tix-update.sh from a release" ;;
esac
printf '%s' "$REPOSITORY" | grep -Eq '^[0-9A-Za-z._-]+/[0-9A-Za-z._-]+$' ||
  die "TIX_REPOSITORY must look like owner/name"

cd "$(dirname "$0")"
[ -f docker-compose.yml ] || die "docker-compose.yml not found next to this script"

# The three-image layout (tix-web / tix-worker / tix-realtime, bundled Caddy and MinIO) cannot be
# replaced by the single-image compose file: its volumes would be orphaned. Stop before anything
# is downloaded or changed.
if grep -Eq '^  (realtime|migrate):|/tix-(web|worker|realtime):' docker-compose.yml; then
  die "this installation still uses the three-image layout (tix-web / tix-worker / tix-realtime). Nothing was changed. Newer releases ship ONE image; moving to it is a one-time manual step that keeps your data: follow docs/MIGRATE-SINGLE-IMAGE.md (https://github.com/$REPOSITORY/blob/main/docs/MIGRATE-SINGLE-IMAGE.md), then run this script again."
fi

command -v awk > /dev/null 2>&1 || die "awk is required"
if command -v curl > /dev/null 2>&1; then
  fetch() { curl -fsSL --connect-timeout 15 --max-time 120 -H 'User-Agent: tix-update' "$1"; }
elif command -v wget > /dev/null 2>&1; then
  fetch() { wget -qO- --timeout=60 --user-agent=tix-update "$1"; }
else
  die "curl or wget is required"
fi

if command -v sha256sum > /dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum > /dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "sha256sum or shasum is required to verify the download"
fi

# TIX_VERSION of .env (last assignment wins; quotes and CR removed).
env_channel() {
  [ -f .env ] || return 0
  grep -E '^[[:space:]]*TIX_VERSION=' .env | tail -n 1 | cut -d= -f2- | tr -d '\r"'"'" | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//'
}

CHANNEL_FROM_ENV=0
if [ -z "$TARGET" ]; then
  TARGET="$(env_channel)"
  CHANNEL_FROM_ENV=1
  [ -n "$TARGET" ] || TARGET="stable"
fi
TARGET="${TARGET#v}"

# Version handling in awk (no jq, no sort -V: not on every host). Same rules as
# packages/core/src/updates.ts: MAJOR.MINOR.PATCH with an optional -alpha|beta|rc.N suffix;
# alpha < beta < rc < final; tags that do not match are ignored.
VERSION_KEY_AWK='
function key(v,   n, p, rank) {
  if (v !~ /^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*(-(alpha|beta|rc)\.[0-9][0-9]*)?$/) return ""
  n = split(v, p, /[.-]/)
  rank = 3
  if (n == 5) rank = (p[4] == "alpha") ? 0 : ((p[4] == "beta") ? 1 : 2)
  return sprintf("k%012.0f.%012.0f.%012.0f.%d.%012.0f", p[1], p[2], p[3], rank, (n == 5) ? p[5] : 0)
}
'

# version_cmp A B prints -1, 0 or 1 ("x" when either is not a release version).
version_cmp() {
  awk -v a="$1" -v b="$2" "$VERSION_KEY_AWK"'
    BEGIN {
      ka = key(a); kb = key(b)
      if (ka == "" || kb == "") { print "x"; exit }
      print (ka > kb) ? 1 : ((ka < kb) ? -1 : 0)
    }'
}

# Tags of the newest releases (one page of 100 from the GitHub API; the list order is irrelevant).
release_tags() {
  fetch "$API_URL/repos/$REPOSITORY/releases?per_page=100" |
    grep -o '"tag_name": *"v[^"]*"' |
    sed 's/.*"\(v[^"]*\)"$/\1/'
}

# newest_tag MODE [MAJOR [MINOR]]: the highest SemVer tag of a group (all, stable, alpha|beta|rc, line).
newest_tag() {
  release_tags | awk -v mode="$1" -v major="${2:-}" -v minor="${3:-}" "$VERSION_KEY_AWK"'
    {
      v = $0; sub(/^v/, "", v)
      k = key(v); if (k == "") next
      n = split(v, p, /[.-]/)
      stage = (n == 5) ? p[4] : ""
      if (mode == "stable" && stage != "") next
      if ((mode == "alpha" || mode == "beta" || mode == "rc") && stage != mode) next
      if (mode == "line") {
        if (stage != "" || p[1] + 0 != major + 0) next
        if (minor != "" && p[2] + 0 != minor + 0) next
      }
      if (best == "" || k > bestkey) { best = $0; bestkey = k }
    }
    END { if (best != "") print best }'
}

# Every branch validates its input strictly: nothing else ends up in a URL, a tag or a pattern.
TAG=""
case "$TARGET" in
  stable | latest) TAG="$(newest_tag stable)" ;;
  next) TAG="$(newest_tag all)" ;;
  alpha | beta | rc) TAG="$(newest_tag "$TARGET")" ;;
  *)
    if printf '%s' "$TARGET" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$'; then
      TAG="v$TARGET"
    elif printf '%s' "$TARGET" | grep -Eq '^[0-9]+\.[0-9]+$'; then
      TAG="$(newest_tag line "${TARGET%%.*}" "${TARGET#*.}")"
    elif printf '%s' "$TARGET" | grep -Eq '^[0-9]+$'; then
      TAG="$(newest_tag line "$TARGET")"
    else
      die "unknown version or channel \"$TARGET\" (use 1.2.3, 1.2.3-rc.1, stable, next, alpha, beta, rc, 1 or 1.2)"
    fi
    ;;
esac
[ -n "$TAG" ] || die "no release found for \"$TARGET\" in $REPOSITORY (stable releases exist from 1.0.0 on; try \"next\")"
VERSION="${TAG#v}"

# Version of the current docker-compose.yml (TIX_COMPOSE_VERSION; absent in old files).
CURRENT="$(grep -E '^[[:space:]]*TIX_COMPOSE_VERSION:' docker-compose.yml | head -n 1 | cut -d: -f2- | tr -d '\r"'"' " || true)"
if [ -n "$CURRENT" ] && [ "$(version_cmp "$VERSION" "$CURRENT")" = "-1" ]; then
  say "WARNING: $VERSION is LOWER than the version of your docker-compose.yml ($CURRENT)."
  say "         Once a newer release migrated the database, older versions cannot read it: going"
  say "         back is not supported (a pre-update backup restores your data on the NEW version)."
  if [ "$DRY_RUN" = 0 ] && [ "$FORCE" = 0 ]; then
    die "refusing to go from $CURRENT to $VERSION; use --force only if you know the database is compatible"
  fi
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "Target: $TARGET -> release $TAG of $REPOSITORY"
fetch "$DOWNLOAD_URL/$REPOSITORY/releases/download/$TAG/docker-compose.yml" > "$TMP/docker-compose.yml" ||
  die "could not download docker-compose.yml of $TAG"
fetch "$DOWNLOAD_URL/$REPOSITORY/releases/download/$TAG/SHA256SUMS.txt" > "$TMP/SHA256SUMS.txt" ||
  die "could not download SHA256SUMS.txt of $TAG"
EXPECTED="$(grep -E '[[:space:]]\*?docker-compose\.yml$' "$TMP/SHA256SUMS.txt" | head -n 1 | cut -d' ' -f1)"
[ -n "$EXPECTED" ] || die "SHA256SUMS.txt of $TAG has no entry for docker-compose.yml"
ACTUAL="$(sha256 "$TMP/docker-compose.yml")"
[ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch for docker-compose.yml of $TAG (expected $EXPECTED, got $ACTUAL); nothing was changed"
say "Checksum of docker-compose.yml verified (sha256 $ACTUAL)."

if cmp -s docker-compose.yml "$TMP/docker-compose.yml"; then
  say "docker-compose.yml is already the one of $TAG: no file change."
  CHANGED=0
else
  CHANGED=1
  if command -v diff > /dev/null 2>&1; then
    diff -u docker-compose.yml "$TMP/docker-compose.yml" > "$TMP/compose.diff" || true
    ADDED="$(grep -c '^+[^+]' "$TMP/compose.diff" || true)"
    REMOVED="$(grep -c '^-[^-]' "$TMP/compose.diff" || true)"
    say "docker-compose.yml changes: $ADDED line(s) added, $REMOVED removed."
    if [ "$DRY_RUN" = 1 ]; then
      say "--- diff (first 80 lines) ---"
      head -n 80 "$TMP/compose.diff"
    fi
  else
    say "docker-compose.yml differs from the current file."
  fi
fi

# Images are chosen by TIX_VERSION: an explicit argument wins over .env for this run.
ENV_NOTE=""
if [ "$CHANNEL_FROM_ENV" = 0 ] && [ "$(env_channel)" != "$TARGET" ]; then
  TIX_VERSION="$TARGET"
  export TIX_VERSION
  ENV_NOTE="Note: images were pulled for \"$TARGET\", but .env says TIX_VERSION=$(env_channel). Set TIX_VERSION=$TARGET in .env to keep it, otherwise the next plain 'docker compose up' switches back."
fi

if [ "$DRY_RUN" = 1 ]; then
  say ""
  say "Dry run: nothing was modified. A real run would:"
  say "  - validate the new file (docker compose config) and pull its images first"
  [ "$CHANGED" = 0 ] || say "  - save docker-compose.yml as docker-compose.yml.bak-<timestamp> and install the file of $TAG"
  say "  - docker compose up -d --remove-orphans"
  [ -z "$ENV_NOTE" ] || say "  - use TIX_VERSION=$TARGET for this run ($(env_channel | sed 's/^$/not set in .env/') in .env)"
  exit 0
fi

docker compose version > /dev/null 2>&1 || die "'docker compose' (Compose v2) is not available"

# Validate and pull with the NEW file (plus the override, as compose would load it) before the
# installed file is replaced: a broken download or an unreachable registry changes nothing.
set -- -f "$TMP/docker-compose.yml"
if [ -f docker-compose.override.yml ]; then
  set -- "$@" -f docker-compose.override.yml
fi
docker compose "$@" --project-directory . config -q ||
  die "the new docker-compose.yml is not valid together with your .env / override (see above); nothing was changed"
say "Pulling images ..."
docker compose "$@" --project-directory . pull ||
  die "pulling the images failed; nothing was changed (your running stack is untouched)"

BACKUP=""
if [ "$CHANGED" = 1 ]; then
  BACKUP="docker-compose.yml.bak-$(date +%Y%m%d%H%M%S)"
  cp -p docker-compose.yml "$BACKUP"
  cp "$TMP/docker-compose.yml" docker-compose.yml.new
  mv docker-compose.yml.new docker-compose.yml
  say "Installed docker-compose.yml of $TAG (previous file kept as $BACKUP)."
fi

say "Starting $VERSION (database migrations run first; a pre-update backup is taken automatically) ..."
if ! docker compose up -d --remove-orphans; then
  {
    say ""
    say "tix-update: 'docker compose up' failed (see above); check 'docker compose logs tix'."
    if [ -n "$BACKUP" ]; then
      say "To restore the previous compose file (the new images stay pulled):"
      say "  mv \"$BACKUP\" docker-compose.yml"
    fi
    say "If migrations already ran, do not start an older version (see --help)."
  } >&2
  exit 1
fi
say ""
docker compose ps
if [ -n "$ENV_NOTE" ]; then
  say ""
  say "$ENV_NOTE"
fi
say ""
say "Done. Check Admin > System for the running version."
