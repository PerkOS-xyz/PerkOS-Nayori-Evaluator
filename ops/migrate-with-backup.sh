#!/bin/sh
set -eu

fail() {
  printf '%s\n' "migration gate error: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || fail "usage: $0 /absolute/path/database-backup.env /absolute/path/database-admin.env"
backup_env=$1
admin_env=$2
case "$admin_env" in /*) ;; *) fail "the admin environment file path must be absolute" ;; esac
[ -f "$admin_env" ] || fail "admin environment file not found"
[ "$(stat -c '%a' "$admin_env")" = "600" ] || fail "admin environment file must have mode 600"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
receipt=$($script_dir/backup-postgres.sh "$backup_env")
[ -f "$receipt" ] || fail "verified backup receipt was not created"
$script_dir/restore-drill.sh "$backup_env" "$receipt"

set -a
# shellcheck disable=SC1090
. "$admin_env"
set +a
: "${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL is required}"
: "${DATABASE_RUNTIME_ROLE:?DATABASE_RUNTIME_ROLE is required}"
[ "${CONFIRM_NAYORI_DATABASE_MIGRATION:-}" = "yes" ] || fail "explicit migration confirmation is required"

node dist/migrate.js
printf '%s\n' "migration_gate_ok backup_receipt=${receipt}"
