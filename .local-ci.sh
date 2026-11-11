#!/usr/bin/env bash
# The FounderOS gate for `local-ci` / `merge-ready`, bounded in memory.
#
# The default local-ci shape runs the whole vitest suite (358 files) at full parallelism and then
# `next build`, which peaks well over 5 GB. On the shared Alienware, where other chats run renders
# and CI at the same time, that gets OOM-killed. This runs the same checks (typecheck, every test,
# production build) with two test workers and capped heaps, about 2 GB at its peak.
# Nothing is skipped: a failing test, a type error or a broken build still fails the gate.
#
# Runs in a repo checkout or in a git worktree under it (node_modules lives in the main checkout).
set -euo pipefail

ROOT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
# A worktree that adds a dependency has its own node_modules. Use it, or `next` from the main
# checkout renders with the worktree's React and the build dies with two React copies.
HERE="$(git rev-parse --show-toplevel)"
if [ -x "$HERE/node_modules/.bin/tsc" ]; then ROOT="$HERE"; fi
BIN="$ROOT/node_modules/.bin"
[ -x "$BIN/tsc" ] || { echo "local-ci: dependencies are not installed in $ROOT (run npm ci there)" >&2; exit 1; }

echo "== typecheck"
NODE_OPTIONS=--max-old-space-size=2048 "$BIN/tsc" --noEmit

echo "== test (2 workers)"
NODE_OPTIONS=--max-old-space-size=1536 "$BIN/vitest" run \
  --pool=forks --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=2

echo "== build"
# Static page generation runs several workers that all open the app's SQLite file. On a fresh file each
# one tries to switch it to WAL at the same moment and the loser dies with "database is locked" when the
# machine is busy. Give the build a database that is already in WAL mode (a throwaway file, not the
# operator's data).
BUILD_DB="$(mktemp -d)/build.db"
trap 'rm -rf "$(dirname "$BUILD_DB")"' EXIT
node -e "const D=require('$ROOT/node_modules/better-sqlite3'); const d=new D(process.argv[1]); d.pragma('journal_mode = WAL'); d.close();" "$BUILD_DB"
GLADOS_DB="$BUILD_DB" NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=3072 "$BIN/next" build
