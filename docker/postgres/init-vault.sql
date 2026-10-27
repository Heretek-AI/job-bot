-- ============================================================================
-- ATS Multi-Tenant Credential Vault & Gmail IMAP Sync Tables
-- Initialized automatically on first Postgres startup alongside JobPilot tables
-- ============================================================================

CREATE TABLE IF NOT EXISTS ats_credentials (
    id SERIAL PRIMARY KEY,
    portal_hostname VARCHAR(255) NOT NULL UNIQUE,
    ats_family VARCHAR(64) NOT NULL DEFAULT 'generic',
    company_name VARCHAR(255),
    email VARCHAR(255) NOT NULL,
    encrypted_password TEXT NOT NULL,
    iv VARCHAR(64) NOT NULL,
    auth_tag VARCHAR(64) NOT NULL,
    account_verified BOOLEAN NOT NULL DEFAULT FALSE,
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ats_credentials_hostname ON ats_credentials(portal_hostname);

CREATE TABLE IF NOT EXISTS imap_processed_emails (
    message_id VARCHAR(512) PRIMARY KEY,
    uid BIGINT,
    from_address VARCHAR(255),
    subject TEXT,
    classification VARCHAR(64),
    verification_code VARCHAR(32),
    verification_link TEXT,
    board_domain VARCHAR(255),
    received_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_imap_board_domain ON imap_processed_emails(board_domain, received_at DESC);
