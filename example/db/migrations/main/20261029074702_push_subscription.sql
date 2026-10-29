-- Litestone migration
-- Created:   2026-10-29T07:47:02.982Z
-- Changes:
--     + PushSubscription  (new table)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

-- One browser's Web Push handle, copied from `notification.lite` as
-- Notification is. Its presence is what makes the notifications plugin serve
-- `push-subscriptions`; whoever holds the endpoint and both keys can put a
-- notification on that screen, so the keys are encrypted and every operation
-- is the owner's alone.
CREATE TABLE IF NOT EXISTS "push_subscription" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL UNIQUE,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "userAgent" TEXT,
  "lastSeenAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "deletedAt" TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_push_subscription_deletedAt" ON "push_subscription" ("deletedAt") WHERE "deletedAt" IS NULL;

COMMIT;
PRAGMA foreign_keys = ON;