#!/usr/bin/env bash
#
# Dump the REMOTE Supabase database to supabase/backups/, for `pnpm db:restore-local` to load.
#
# Schema set: public, rag, legacy — the schemas this project owns and the exact set
# scripts/restore-local-backup.mjs restores by default. 
#
# Usage
#   export SESSION_POOLER_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres'
#   ./scripts/dump-remote-backup.sh
#   ./scripts/dump-remote-backup.sh --schema-only        # structure, no rows
#   ./scripts/dump-remote-backup.sh --with-auth          # also dump auth + storage (rarely useful)
#   SCHEMAS="public rag" ./scripts/dump-remote-backup.sh # explicit override
#
# Reads SESSION_POOLER_URL from the environment, or from .env.local if it is set there.
# Exit codes: 0 dumped, 1 dump failed, 2 could not run (missing URL / docker).

set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="supabase/backups"
SCHEMAS="${SCHEMAS:-public rag legacy}"
PG_IMAGE="${PG_IMAGE:-postgres:17}"
EXTRA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --schema-only) EXTRA_ARGS+=(--schema-only) ;;
    --with-auth)   SCHEMAS="$SCHEMAS auth storage" ;;
    -h|--help)     sed -n '2,40p' "$0"; exit 0 ;;
    *)             echo "dump-remote-backup: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# SESSION_POOLER_URL from the environment wins; otherwise pull it out of .env.local.
if [ -z "${SESSION_POOLER_URL:-}" ] && [ -f .env.local ]; then
  SESSION_POOLER_URL="$(sed -nE 's/^SESSION_POOLER_URL=["'\'']?([^"'\'']*)["'\'']?$/\1/p' .env.local | tail -1)"
fi

if [ -z "${SESSION_POOLER_URL:-}" ]; then
  echo "dump-remote-backup: SESSION_POOLER_URL is not set (env or .env.local)." >&2
  echo "  Supabase dashboard -> Project Settings -> Database -> Session pooler connection string." >&2
  exit 2
fi

case "$SESSION_POOLER_URL" in
  postgres://*|postgresql://*) ;;
  *) echo "dump-remote-backup: SESSION_POOLER_URL is not a postgres URL." >&2; exit 2 ;;
esac

command -v docker >/dev/null 2>&1 || { echo "dump-remote-backup: docker not found on PATH." >&2; exit 2; }

mkdir -p "$OUT_DIR"

SCHEMA_ARGS=()
for schema in $SCHEMAS; do
  SCHEMA_ARGS+=(-n "$schema")
done

# Assert every requested schema is actually visible to this role BEFORE dumping.

WANTED="$(printf '%s' "$SCHEMAS" | tr ' ' '\n' | sed "s/^/'/; s/\$/'/" | paste -sd, -)"
FOUND="$(docker run --rm \
  -e PGURL="$SESSION_POOLER_URL" \
  "$PG_IMAGE" \
  sh -c "exec psql \"\$PGURL\" -tAc \"select nspname from pg_namespace where nspname in ($WANTED) order by 1\"" \
  2>/dev/null | tr -d '\r' | tr '\n' ' ')"

MISSING=""
for schema in $SCHEMAS; do
  case " $FOUND " in
    *" $schema "*) ;;
    *) MISSING="$MISSING $schema" ;;
  esac
done

if [ -n "$MISSING" ]; then
  echo "dump-remote-backup: requested schema(s) not visible on the remote:$MISSING" >&2
  echo "  visible: ${FOUND:-<none — could not query the remote>}" >&2
  echo "  Either the schema does not exist, or this role cannot see it. Dumping anyway would" >&2
  echo "  produce a backup silently missing it. Fix the URL/grants, or set SCHEMAS= explicitly." >&2
  exit 2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="backup-${STAMP}.dump"

# Host shown without credentials, so the operator can confirm which database they are dumping.
HOST_ONLY="$(printf '%s' "$SESSION_POOLER_URL" | sed -E 's#^[a-z]+://[^@]*@##; s#/.*$##')"

echo
echo "  DUMP"
echo "    source    $HOST_ONLY"
echo "    schemas   $SCHEMAS"
echo "    into      $OUT_DIR/$FILE"
echo

# PGURL is expanded by the container's shell, not this one, so the password never reaches the
# host process list or this script's own argv.
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD/$OUT_DIR:/out" \
  -e PGURL="$SESSION_POOLER_URL" \
  "$PG_IMAGE" \
  sh -c 'exec pg_dump --dbname="$PGURL" "$@"' pg_dump \
    "${SCHEMA_ARGS[@]}" \
    --no-owner --no-privileges \
    "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}" \
    -Fc -f "/out/$FILE"

SIZE="$(du -h "$OUT_DIR/$FILE" | cut -f1 | tr -d ' ')"
echo
echo "  Wrote $OUT_DIR/$FILE ($SIZE)"
echo "  Load it locally with: pnpm db:restore-local"
