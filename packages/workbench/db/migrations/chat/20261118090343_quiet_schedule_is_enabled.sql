-- Litestone migration (database: chat)
-- Created:   2026-11-18T09:03:43.873Z
-- Class:     contract
-- Operations:
--   rename QuietSchedule.enabled → isEnabled  (the values stay)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── operations ────────────────────────────────────────────────────
ALTER TABLE "quiet_schedule" RENAME COLUMN "enabled" TO "isEnabled";

COMMIT;
PRAGMA foreign_keys = ON;