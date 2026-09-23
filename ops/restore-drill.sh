#!/bin/sh
set -eu

fail() {
  printf '%s\n' "restore drill error: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || fail "usage: $0 /absolute/path/database-backup.env /absolute/path/receipt.json"
env_file=$1
receipt_file=$2
case "$env_file" in /*) ;; *) fail "the environment file path must be absolute" ;; esac
case "$receipt_file" in /*) ;; *) fail "the receipt path must be absolute" ;; esac
[ -f "$env_file" ] || fail "environment file not found"
[ -f "$receipt_file" ] || fail "receipt not found"
[ "$(stat -c '%a' "$env_file")" = "600" ] || fail "environment file must have mode 600"

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a
: "${AWS_REGION:?AWS_REGION is required}"
[ "${CONFIRM_NAYORI_DATABASE_RESTORE_DRILL:-}" = "yes" ] || fail "explicit restore drill confirmation is required"

for command_name in aws docker sha256sum jq mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done

bucket=$(jq -er '.bucket' "$receipt_file")
key=$(jq -er '.key' "$receipt_file")
expected_sha256=$(jq -er '.sha256' "$receipt_file")
expected_evaluations=$(jq -er '.evaluationRows' "$receipt_file")
expected_migrations=$(jq -er '.migrationRows' "$receipt_file")

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/nayori-db-restore.XXXXXX")
container="nayori-restore-drill-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT HUP INT TERM
dump_file="$work_dir/backup.dump"

aws s3 cp "s3://${bucket}/${key}" "$dump_file" --region "$AWS_REGION" --only-show-errors
actual_sha256=$(sha256sum "$dump_file" | awk '{print $1}')
[ "$actual_sha256" = "$expected_sha256" ] || fail "downloaded backup checksum mismatch"

docker run --detach --rm --name "$container" \
  --network none \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=1g \
  --env POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine >/dev/null

attempt=0
until docker exec "$container" pg_isready --username postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || fail "ephemeral PostgreSQL did not become ready"
  sleep 1
done

docker run --rm --network "container:${container}" --volume "$work_dir:/backup:ro" \
  postgres:17-alpine pg_restore --host 127.0.0.1 --username postgres --dbname postgres \
  --no-owner --no-privileges /backup/backup.dump

restored_count() {
  table_name=$1
  expected=$2
  exists=$(docker exec "$container" psql --username postgres --dbname postgres --no-psqlrc \
    --tuples-only --no-align --command "select case when to_regclass('public.${table_name}') is null then 'absent' else 'present' end")
  if [ "$exists" = "absent" ]; then
    actual=-1
  else
    actual=$(docker exec "$container" psql --username postgres --dbname postgres --no-psqlrc \
      --tuples-only --no-align --command "select count(*) from public.${table_name}")
  fi
  [ "$actual" = "$expected" ] || fail "restored ${table_name} row count mismatch"
}

restored_count evaluations "$expected_evaluations"
restored_count schema_migrations "$expected_migrations"
printf '%s\n' "restore_drill_ok sha256=${actual_sha256} evaluations=${expected_evaluations} migrations=${expected_migrations}"
