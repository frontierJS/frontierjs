-- Litestone migration
-- Created:   2026-10-15T10:18:39.225Z
-- Changes:
--     ~ notification  [rebuild]
--         + col  deliveryKey TEXT
--         + UNIQUE (userId, type, deliveryKey)  (rebuild; the copy fails if existing rows violate it)


PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── modified tables ───────────────────────────────────────────────

-- rebuild "notification" — full table reconstruction required
CREATE TABLE "notification__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "data" TEXT NOT NULL,
  "contextType" TEXT,
  "contextId" TEXT,
  "deliveryKey" TEXT,
  "readAt" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("contextType" IN ('Order')),
  UNIQUE ("userId", "type", "deliveryKey")
) STRICT;

INSERT INTO "notification__new" ("id", "userId", "type", "data", "contextType", "contextId", "readAt", "createdAt")
  SELECT "id", "userId", "type", "data", "contextType", "contextId", "readAt", "createdAt" FROM "notification";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of notification lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "notification__new") = (SELECT count(*) FROM "notification") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "notification";
ALTER TABLE "notification__new" RENAME TO "notification";

COMMIT;
PRAGMA foreign_keys = ON;