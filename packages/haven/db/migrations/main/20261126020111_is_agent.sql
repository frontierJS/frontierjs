-- Litestone migration
-- Created:   2026-11-26T02:01:11.193Z
-- Class:     contract
-- Operations:
--   rename Member.agent → isAgent  (the values stay)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── operations ────────────────────────────────────────────────────
ALTER TABLE "member" RENAME COLUMN "agent" TO "isAgent";

COMMIT;
PRAGMA foreign_keys = ON;