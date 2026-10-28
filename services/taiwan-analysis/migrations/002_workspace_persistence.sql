-- Additive, non-market persistence for the browser/install workspace.
CREATE TABLE IF NOT EXISTS workspace_persistence (
    identity_kind TEXT NOT NULL,
    identity_key TEXT NOT NULL,
    workspace JSONB NOT NULL,
    profiles JSONB NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (identity_kind, identity_key)
);
CREATE INDEX IF NOT EXISTS workspace_persistence_updated_at_idx
    ON workspace_persistence (updated_at);
