#!/bin/sh
set -eu

fail() {
  printf '%s\n' "backup error: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "usage: $0 /absolute/path/database-backup.env"
env_file=$1
case "$env_file" in /*) ;; *) fail "the environment file path must be absolute" ;; esac
[ -f "$env_file" ] || fail "environment file not found"
[ "$(stat -c '%a' "$env_file")" = "600" ] || fail "environment file must have mode 600"

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

: "${DATABASE_BACKUP_SERVICE:?DATABASE_BACKUP_SERVICE is required}"
: "${PGSERVICEFILE:?PGSERVICEFILE is required}"
: "${PGPASSFILE:?PGPASSFILE is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_PREFIX:?S3_PREFIX is required}"
: "${AWS_REGION:?AWS_REGION is required}"
: "${BACKUP_RECEIPT_DIRECTORY:?BACKUP_RECEIPT_DIRECTORY is required}"
[ "${CONFIRM_NAYORI_DATABASE_BACKUP:-}" = "yes" ] || fail "explicit backup confirmation is required"

case "$S3_BUCKET" in *[!a-z0-9.-]*|'') fail "invalid S3 bucket" ;; esac
case "$S3_PREFIX" in *[!A-Za-z0-9/_.=-]*|'') fail "invalid S3 prefix" ;; esac
case "$DATABASE_BACKUP_SERVICE" in *[!A-Za-z0-9_.-]*|'') fail "invalid libpq service name" ;; esac
case "$PGSERVICEFILE" in /*) ;; *) fail "PGSERVICEFILE must be absolute" ;; esac
case "$PGPASSFILE" in /*) ;; *) fail "PGPASSFILE must be absolute" ;; esac
[ -f "$PGSERVICEFILE" ] || fail "PGSERVICEFILE not found"
[ -f "$PGPASSFILE" ] || fail "PGPASSFILE not found"
[ "$(stat -c '%a' "$PGSERVICEFILE")" = "600" ] || fail "PGSERVICEFILE must have mode 600"
[ "$(stat -c '%a' "$PGPASSFILE")" = "600" ] || fail "PGPASSFILE must have mode 600"
case "$BACKUP_RECEIPT_DIRECTORY" in /*) ;; *) fail "receipt directory must be absolute" ;; esac

for command_name in pg_dump pg_restore psql aws sha256sum jq mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/nayori-db-backup.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM
timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
backup_name="nayori-evaluator-${timestamp}"
dump_file="$work_dir/${backup_name}.dump"
catalog_file="$work_dir/${backup_name}.catalog.txt"
checksum_file="$work_dir/${backup_name}.sha256"
receipt_file="$work_dir/${backup_name}.json"
object_prefix="${S3_PREFIX%/}/${backup_name}"

database_dsn="service=${DATABASE_BACKUP_SERVICE}"
pg_dump --format=custom --no-owner --no-privileges --file "$dump_file" --dbname "$database_dsn"
pg_restore --list "$dump_file" > "$catalog_file"
[ -s "$catalog_file" ] || fail "pg_restore returned an empty catalog"

relation_exists() {
  psql --dbname "$database_dsn" --no-psqlrc --tuples-only --no-align --command \
    "select case when to_regclass('public.$1') is null then 'absent' else 'present' end"
}

evaluation_rows=-1
migration_rows=-1
if [ "$(relation_exists evaluations)" = "present" ]; then
  evaluation_rows=$(psql --dbname "$database_dsn" --no-psqlrc --tuples-only --no-align \
    --command "select count(*) from public.evaluations")
fi
if [ "$(relation_exists schema_migrations)" = "present" ]; then
  migration_rows=$(psql --dbname "$database_dsn" --no-psqlrc --tuples-only --no-align \
    --command "select count(*) from public.schema_migrations")
fi

checksum=$(sha256sum "$dump_file" | awk '{print $1}')
printf '%s  %s\n' "$checksum" "${backup_name}.dump" > "$checksum_file"
jq -n \
  --arg createdAt "$timestamp" \
  --arg bucket "$S3_BUCKET" \
  --arg key "${object_prefix}.dump" \
  --arg sha256 "$checksum" \
  --argjson evaluationRows "$evaluation_rows" \
  --argjson migrationRows "$migration_rows" \
  '{version:1,status:"verified_and_uploaded",createdAt:$createdAt,bucket:$bucket,key:$key,sha256:$sha256,evaluationRows:$evaluationRows,migrationRows:$migrationRows}' \
  > "$receipt_file"

aws s3 cp "$dump_file" "s3://${S3_BUCKET}/${object_prefix}.dump" \
  --region "$AWS_REGION" --sse AES256 --only-show-errors
aws s3 cp "$catalog_file" "s3://${S3_BUCKET}/${object_prefix}.catalog.txt" \
  --region "$AWS_REGION" --sse AES256 --only-show-errors
aws s3 cp "$checksum_file" "s3://${S3_BUCKET}/${object_prefix}.sha256" \
  --region "$AWS_REGION" --sse AES256 --only-show-errors
aws s3 cp "$receipt_file" "s3://${S3_BUCKET}/${object_prefix}.json" \
  --region "$AWS_REGION" --sse AES256 --only-show-errors

mkdir -p "$BACKUP_RECEIPT_DIRECTORY"
chmod 700 "$BACKUP_RECEIPT_DIRECTORY"
final_receipt="$BACKUP_RECEIPT_DIRECTORY/${backup_name}.json"
install -m 600 "$receipt_file" "$final_receipt"
printf '%s\n' "$final_receipt"
