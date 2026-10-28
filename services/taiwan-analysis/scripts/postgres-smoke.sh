#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"

marker='__taiwan_analysis_postgres_smoke__'

# The marker is inserted and selected only inside a transaction, then rolled back.
# Suppress driver diagnostics so a malformed DSN or server error cannot echo secrets.
if ! psql --no-psqlrc "$DATABASE_URL" \\
  -v ON_ERROR_STOP=1 \\
  -v smoke_marker="$marker" \\
  -X -q >/dev/null 2>&1 <<'SQL'
BEGIN;
INSERT INTO market.option_contracts
  (provider_code, root, underlying_code, expiry_date, strike_points, option_type, multiplier, currency, raw_metadata)
VALUES
  (:'smoke_marker', 'SMOKE', 'SMOKE', DATE '2099-01-01', 1,
   'call', 1, 'TWD', '{}'::jsonb);
SELECT provider_code, root, expiry_date, strike_points, option_type
  FROM market.option_contracts
 WHERE provider_code = :'smoke_marker';
ROLLBACK;
SQL
then
  printf '%s\n' 'PostgreSQL smoke test failed'
  exit 1
fi

remaining=$(psql --no-psqlrc "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -Atq \
  -c "SELECT count(*) FROM market.option_contracts WHERE provider_code = '$marker';" \
  2>/dev/null) || {
  printf '%s\n' 'PostgreSQL smoke test failed'
  exit 1
}

if [ "$remaining" != '0' ]; then
  printf '%s\n' 'PostgreSQL smoke test failed: rollback verification was non-zero'
  exit 1
fi

printf '%s\n' 'PostgreSQL smoke test passed: transaction insert/select rolled back'
