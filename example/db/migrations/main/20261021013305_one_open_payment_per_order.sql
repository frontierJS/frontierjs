-- Litestone migration
-- Created:   2026-10-21T01:33:05.453Z
-- Changes:
--     ~ payment  [alter]
--         + idx  (orderId)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- "payment": add indexes
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_payment_orderId" ON "payment" ("orderId") WHERE ("status" = 'pending' OR "status" = 'requiresAction');

COMMIT;
PRAGMA foreign_keys = ON;
