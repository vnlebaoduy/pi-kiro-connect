#!/usr/bin/env bash
# Installs pi-kiro-connect into pi and/or Oh My Pi (omp).
#
#   curl -fsSL https://raw.githubusercontent.com/vnlebaoduy/pi-kiro-connect/main/scripts/install.sh | bash
#
# Options:
#   --version vX.Y.Z   Install that release (default: latest GitHub release)
#   --pi               Install into pi only
#   --omp              Install into Oh My Pi only
#   --uninstall        Remove pi-kiro-connect instead
#   -h, --help         Show this help
#
# With neither --pi nor --omp, every host found on PATH is used.

set -euo pipefail

REPO="vnlebaoduy/pi-kiro-connect"
PACKAGE="pi-kiro-connect"
# The upstream package registers the same `kiro` provider; both loaded at once
# means two providers fighting over one name.
LEGACY_PACKAGE="pi-provider-kiro"

version=""
want_pi=0
want_omp=0
uninstall=0

usage() {
  cat <<'EOF'
Install pi-kiro-connect into pi and/or Oh My Pi (omp).

Options:
  --version vX.Y.Z   Install that release (default: latest GitHub release)
  --pi               Install into pi only
  --omp              Install into Oh My Pi only
  --uninstall        Remove pi-kiro-connect instead
  -h, --help         Show this help

With neither --pi nor --omp, every host found on PATH is used.
EOF
}
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || die "--version needs a value, e.g. --version v0.13.0"
      version="$2"; shift 2 ;;
    --version=*) version="${1#*=}"; shift ;;
    --pi) want_pi=1; shift ;;
    --omp) want_omp=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

has() { command -v "$1" >/dev/null 2>&1; }

if [ "$want_pi" -eq 0 ] && [ "$want_omp" -eq 0 ]; then
  has pi && want_pi=1
  has omp && want_omp=1
  [ "$want_pi" -eq 1 ] || [ "$want_omp" -eq 1 ] || die "neither pi nor omp found on PATH.
  pi:  https://github.com/badlogic/pi-mono
  omp: https://github.com/can1357/oh-my-pi"
fi
[ "$want_pi" -eq 0 ] || has pi || die "--pi given but pi is not on PATH"
[ "$want_omp" -eq 0 ] || has omp || die "--omp given but omp is not on PATH"

if [ "$uninstall" -eq 0 ] && [ -z "$version" ]; then
  has curl || die "curl is required to look up the latest release (or pass --version)"
  version="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] || die "could not determine the latest release; pass --version vX.Y.Z"
fi
case "$version" in ""|v[0-9]*.[0-9]*.[0-9]*) ;; *) die "version must look like v1.2.3, got: $version" ;; esac

# --- pi --------------------------------------------------------------------
# pi git installs clone and run `npm install --omit=dev`, never the build, so
# they point at release/<tag>: the tag's tree plus the CI-built dist/.
# `pi list` prints each source on a two-space line and its install path on a
# four-space line beneath; only the source is accepted by `pi remove`.
pi_installed_sources() {
  pi list 2>/dev/null | sed -n -E "s/^  ([^ ]*(${PACKAGE}|${LEGACY_PACKAGE})[^ ]*)( \(filtered\))?$/\1/p" || true
}

if [ "$want_pi" -eq 1 ]; then
  for source in $(pi_installed_sources); do
    say "pi: removing ${source}"
    pi remove "$source" || warn "pi: could not remove ${source}"
  done
  if [ "$uninstall" -eq 0 ]; then
    say "pi: installing ${PACKAGE} ${version}"
    pi install "git:github.com/${REPO}@release/${version}"
  fi
fi

# --- omp -------------------------------------------------------------------
# omp installs with bun and loads src/index.ts directly, so the plain tag works.
if [ "$want_omp" -eq 1 ]; then
  for name in "$LEGACY_PACKAGE" "$PACKAGE"; do
    if omp plugin list 2>/dev/null | grep -q -E "(^|[[:space:]])${name}@"; then
      say "omp: removing ${name}"
      omp plugin uninstall "$name" || warn "omp: could not remove ${name}"
    fi
  done
  if [ "$uninstall" -eq 0 ]; then
    say "omp: installing ${PACKAGE} ${version}"
    omp plugin install "github:${REPO}#${version}"
  fi
fi

if [ "$uninstall" -eq 1 ]; then
  say "Removed ${PACKAGE}."
  exit 0
fi

say "Done. Start pi or omp and run /login, then pick Kiro."
if has kiro-cli; then
  echo "    Already signed in with kiro-cli? That session is picked up automatically."
fi
