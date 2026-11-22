-- Litestone migration
-- Created:   2026-11-22T20:19:37.094Z
-- Class:     expand
-- Changes:
--     ~ oauth_flow  [alter]
--         + col  grant TEXT
--         + col  initiator TEXT


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "oauth_flow": add columns
ALTER TABLE "oauth_flow" ADD COLUMN "grant" TEXT;
ALTER TABLE "oauth_flow" ADD COLUMN "initiator" TEXT;

COMMIT;
PRAGMA foreign_keys = ON;