# Taiwan options analysis

The active integration is hosted inside the existing Vite process in
`src/server/taiwan-analysis-api.ts`; it does not start this Python directory as
another service or open port 21400. The Python implementation below is retained
as calculation/reference material only and is not part of the production
request path. It does not expose Shioaji or PostgreSQL credentials to the
browser.

## Configuration

The service reads these server-process environment variables:

- `DATABASE_URL`: PostgreSQL DSN for the existing `market` schema.
- `SHIOAJI_BASE_URL`: existing Shioaji HTTP server, default `http://127.0.0.1:21323`.
- `SHIOAJI_AUTH`: optional Shioaji bearer value, kept server-side.
- `TAIWAN_ANALYSIS_STALE_SECONDS`: quote age threshold, default `15`.
- `HOST` / `PORT`: bind address and service port, default `127.0.0.1:21400`.

Do not put `DATABASE_URL`, `SHIOAJI_AUTH`, API keys, or secret keys in `VITE_*` variables.

## Install and migrate

From the repository root:

```sh
cd services/taiwan-analysis
uv venv
. .venv/bin/activate
uv pip install -r requirements.txt
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_taiwan_options_vix.sql
```

Use the existing protected environment file for `DATABASE_URL` in the service process; do not copy its contents into this repository.

## Run

```sh
cd services/taiwan-analysis
. .venv/bin/activate
python -m analysis.service
```

Endpoints:

- `GET /health`
- `POST /api/options/txo/refresh`: discovers all `TX*` roots and contracts from Shioaji, snapshots quotes, calculates/persists Greeks and VIX when two usable expiries exist.
- `GET /api/options/txo/chain?expiry=YYYY-MM-DD`: normalized dynamic contracts, latest quotes, and calculation timestamps.
- `GET /api/vix/taiwan/history`: persisted history, marked `methodology=self-calculated` and `official=false`.

The refresh path is read-only against Shioaji market-data endpoints. It never places orders.

## Frontend and same-process API

The frontend calls the same-origin API namespace:

- `/api/taiwan-analysis/options/txo/chain`
- `/api/taiwan-analysis/options/txo/refresh`
- `/api/taiwan-analysis/vix/taiwan/history`

These routes are handled by the existing Vite Node process on port 5173. The
generic `/api/*` route remains the original Shioaji proxy. No second service or
21400 listener is required. The current safe empty state returns
`INSUFFICIENT_DATA` until a server-side provider/database adapter is configured;
it never invents market data.

`DATABASE_URL` and `SHIOAJI_AUTH` must remain in the service process environment.
Never put them, or any API/secret key, in `VITE_*` variables or send them to the
browser. Do not call the refresh endpoint unless the service already has its
server-side Shioaji credentials configured.

## Tests

The deterministic tests do not require Shioaji, PostgreSQL, or credentials:

```sh
cd services/taiwan-analysis
python -m unittest discover -s tests -p 'test_*.py' -v

# Requires an existing server-side DATABASE_URL. Inserts/selects inside a
# transaction, rolls back, and verifies no marker remains; no schema reset,
# database drop, or volume operation.
./scripts/postgres-smoke.sh
```

Black-76 units: index-point prices/strikes; annualized decimal volatility; `T` in years; delta per index point; gamma per point squared; vega per decimal volatility and per volatility point; theta per year and per day. Quotes with missing/crossed/non-positive bid-ask or over-age timestamps are excluded from IV/VIX and retained with quality/stale flags.
