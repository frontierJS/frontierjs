-- ============================================================
-- Migration 002 — server docker_state column
-- Added in a separate migration so existing installs can upgrade
-- without a full schema rebuild.
-- ============================================================

ALTER TABLE server ADD COLUMN IF NOT EXISTS docker_state TEXT;
ALTER TABLE server ADD COLUMN IF NOT EXISTS agent_url     TEXT;
