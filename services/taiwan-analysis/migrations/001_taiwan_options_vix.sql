CREATE SCHEMA IF NOT EXISTS market;

CREATE TABLE IF NOT EXISTS market.option_contracts (
    id BIGSERIAL PRIMARY KEY,
    provider_code TEXT NOT NULL UNIQUE,
    root TEXT,
    underlying_code TEXT,
    expiry_date DATE NOT NULL,
    strike_points NUMERIC(18,6) NOT NULL CHECK (strike_points > 0),
    option_type TEXT NOT NULL CHECK (option_type IN ('call','put')),
    multiplier NUMERIC(18,6) NOT NULL CHECK (multiplier > 0),
    currency TEXT NOT NULL DEFAULT 'TWD',
    raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS option_contracts_expiry_strike_idx ON market.option_contracts(expiry_date, strike_points, option_type);

CREATE TABLE IF NOT EXISTS market.option_quote_snapshots (
    id BIGSERIAL PRIMARY KEY,
    contract_id BIGINT REFERENCES market.option_contracts(id) ON DELETE CASCADE,
    provider_code TEXT NOT NULL REFERENCES market.option_contracts(provider_code) ON DELETE CASCADE,
    observed_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    bid_points NUMERIC(18,8), ask_points NUMERIC(18,8), last_points NUMERIC(18,8),
    bid_size NUMERIC(18,6), ask_size NUMERIC(18,6), volume NUMERIC(18,6), open_interest NUMERIC(18,6),
    stale BOOLEAN NOT NULL DEFAULT FALSE,
    quality TEXT NOT NULL,
    raw_quote JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS option_quote_snapshots_time_idx ON market.option_quote_snapshots(provider_code, observed_at DESC);

CREATE TABLE IF NOT EXISTS market.option_quotes_current (
    provider_code TEXT PRIMARY KEY REFERENCES market.option_contracts(provider_code) ON DELETE CASCADE,
    observed_at TIMESTAMPTZ, received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    bid_points NUMERIC(18,8), ask_points NUMERIC(18,8), last_points NUMERIC(18,8),
    bid_size NUMERIC(18,6), ask_size NUMERIC(18,6), volume NUMERIC(18,6), open_interest NUMERIC(18,6),
    stale BOOLEAN NOT NULL DEFAULT FALSE, quality TEXT NOT NULL, raw_quote JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS market.option_greeks (
    id BIGSERIAL PRIMARY KEY,
    provider_code TEXT NOT NULL REFERENCES market.option_contracts(provider_code) ON DELETE CASCADE,
    quote_snapshot_id BIGINT REFERENCES market.option_quote_snapshots(id) ON DELETE SET NULL,
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(), model TEXT NOT NULL DEFAULT 'black-76',
    forward_points NUMERIC(18,8), strike_points NUMERIC(18,8), time_to_expiry_years NUMERIC(18,10),
    rate_decimal NUMERIC(18,10), implied_volatility_decimal NUMERIC(18,10),
    delta_per_point NUMERIC(18,10), gamma_per_point_squared NUMERIC(18,10),
    vega_per_vol_decimal NUMERIC(18,10), vega_per_vol_point NUMERIC(18,10),
    theta_per_year NUMERIC(18,10), theta_per_day NUMERIC(18,10), rho_per_rate_decimal NUMERIC(18,10),
    stale BOOLEAN NOT NULL DEFAULT FALSE, quality TEXT NOT NULL, warnings JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS option_greeks_code_time_idx ON market.option_greeks(provider_code, calculated_at DESC);

CREATE TABLE IF NOT EXISTS market.taiwan_vix_observations (
    id BIGSERIAL PRIMARY KEY,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(), near_expiry DATE NOT NULL, next_expiry DATE NOT NULL,
    near_variance NUMERIC(18,10) NOT NULL, next_variance NUMERIC(18,10) NOT NULL,
    interpolated_variance NUMERIC(18,10) NOT NULL CHECK (interpolated_variance >= 0),
    vix_value NUMERIC(18,10) NOT NULL CHECK (vix_value >= 0),
    target_days NUMERIC(8,3) NOT NULL DEFAULT 30,
    methodology TEXT NOT NULL DEFAULT 'self-calculated', official BOOLEAN NOT NULL DEFAULT FALSE,
    quality TEXT NOT NULL, stale BOOLEAN NOT NULL DEFAULT FALSE, warnings JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS taiwan_vix_observations_time_idx ON market.taiwan_vix_observations(observed_at DESC);

CREATE TABLE IF NOT EXISTS market.taiwan_vix_inputs (
    id BIGSERIAL PRIMARY KEY,
    observation_id BIGINT NOT NULL REFERENCES market.taiwan_vix_observations(id) ON DELETE CASCADE,
    expiry_date DATE NOT NULL, maturity_years NUMERIC(18,10) NOT NULL, rate_decimal NUMERIC(18,10) NOT NULL,
    forward_points NUMERIC(18,8) NOT NULL, k0_points NUMERIC(18,8) NOT NULL,
    selected_strikes JSONB NOT NULL, exclusions JSONB NOT NULL DEFAULT '[]'::jsonb,
    calculation_version TEXT NOT NULL DEFAULT 'taiwan-vix-v1'
);
CREATE INDEX IF NOT EXISTS taiwan_vix_inputs_observation_idx ON market.taiwan_vix_inputs(observation_id);
