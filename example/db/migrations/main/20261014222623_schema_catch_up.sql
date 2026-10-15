-- Litestone migration
-- Created:   2026-10-14T22:26:23.477Z
-- Changes:
--     + SubscriptionPeriod  (new table)
--     ~ credential  [alter]
--         + idx  (type, value)
--     ~ verification  [rebuild]
--         + col  userId TEXT
--         + col  code TEXT
--         + col  attempts INTEGER
--         ~ CHECK constraints changed (an enum's members, or an @check)
--     ~ oauth_flow  [alter]
--         + col  invitation TEXT
--     ~ outbox_message  [alter]
--         + col  tenantId TEXT
--     ~ subscription  [rebuild]
--         - col  currentPeriodStart
--         - col  currentPeriodEnd
--     ~ invoice  [alter]
--         + col  graceDays INTEGER  ⚠ NOT NULL no default
--         + col  dunningDays INTEGER  ⚠ NOT NULL no default
--         + col  reminded INTEGER
--     ~ product  trigger product_fts_insert  (recreate)
--     ~ product  trigger product_fts_delete  (recreate)
--     ~ product  trigger product_fts_update  (recreate)
--     ~ product  trigger product_search_insert  (recreate)
--     ~ product  trigger product_search_delete  (recreate)
--     ~ product  trigger product_search_update  (recreate)
--     ~ product  full-text index product_fts  (recreate + rebuild)
--     ~ _search  shared search index  (recreate)
--     ~ product  re-indexed in _search

-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ DESTRUCTIVE — applying this deletes the values in these columns and the rows of these tables:
-- ║     subscription.currentPeriodStart, currentPeriodEnd
-- ║
-- ║ To keep them, copy the values before the old table is dropped, then delete this box.
-- ║ To lose them, change the "no" below to "yes".
-- ║ migrate apply refuses this file until one of the two is done.
-- ║
-- ║ Accept data loss: yes
-- ╚══════════════════════════════════════════════════════════════════════════╝
PRAGMA foreign_keys = OFF;
BEGIN;

-- ─── new tables ────────────────────────────────────────────────────

-- One cycle of a subscription — the days it has been charged for.
-- 
-- **Renewal is this row closing** (`FJS-D367`). A subscription stays `active`
-- across a renewal, so there is no move on `Subscription` to make one, and
-- `@@transitions` refuses a self-loop; a period is a thing with a start, an
-- end and a state, so the move is here. `close` is owed at `endsOn`, and
-- junction's `commitments()` makes it; `renewPeriod` in `api/src/domain/billing`
-- is the hook that runs in the same transaction — it issues the next invoice
-- and opens the next period, or ends the arrangement when the subscription
-- was asked to stop or already has.
-- 
-- The state machine is the once-ness: a second fire for one period meets a
-- row already `closed`, and the constraint below refuses a second open period
-- whatever path tries to write one.
CREATE TABLE IF NOT EXISTS "subscription_period" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "subscriptionId" INTEGER NOT NULL,
  "startsOn" TEXT NOT NULL,
  "endsOn" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "userId" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("status" IN ('open', 'closed')),
  CHECK (startsOn < endsOn),
  FOREIGN KEY ("subscriptionId") REFERENCES "subscription" ("id") ON DELETE RESTRICT
) STRICT;
CREATE INDEX IF NOT EXISTS "idx_subscription_period_subscriptionId_startsOn" ON "subscription_period" ("subscriptionId", "startsOn");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_subscription_period_subscriptionId" ON "subscription_period" ("subscriptionId") WHERE "status" = 'open';

-- ─── modified tables ───────────────────────────────────────────────

-- "credential": add indexes
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_credential_type_value" ON "credential" ("type", "value") WHERE ((("type" != 'password' AND "type" != 'totp') AND "type" != 'totpPending') AND "type" != 'recoveryCode');

-- rebuild "verification" — full table reconstruction required
CREATE TABLE "verification__new" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
  "purpose" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL UNIQUE,
  "provider" TEXT,
  "subject" TEXT,
  "userId" TEXT,
  "code" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ("purpose" IN ('passwordReset', 'emailVerify', 'oauthLink', 'magicLink', 'emailChange'))
) STRICT;

INSERT INTO "verification__new" ("id", "purpose", "identifier", "value", "provider", "subject", "expiresAt", "createdAt")
  SELECT "id", "purpose", "identifier", "value", "provider", "subject", "expiresAt", "createdAt" FROM "verification";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of verification lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "verification__new") = (SELECT count(*) FROM "verification") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "verification";
ALTER TABLE "verification__new" RENAME TO "verification";

-- recreate indexes for "verification"
CREATE INDEX IF NOT EXISTS "idx_verification_purpose_identifier" ON "verification" ("purpose", "identifier");
CREATE INDEX IF NOT EXISTS "idx_verification_expiresAt" ON "verification" ("expiresAt");

-- "oauth_flow": add columns
ALTER TABLE "oauth_flow" ADD COLUMN "invitation" TEXT;

-- "outbox_message": add columns
ALTER TABLE "outbox_message" ADD COLUMN "tenantId" TEXT;

-- rebuild "subscription" — full table reconstruction required
CREATE TABLE "subscription__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "reference" TEXT NOT NULL UNIQUE,
  "customerId" INTEGER NOT NULL,
  "planVersionId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'trialing',
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "trialEndsAt" TEXT,
  "cancelledAt" TEXT,
  "cancelAtPeriodEnd" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "userId" TEXT,
  CHECK ("status" IN ('trialing', 'active', 'pastDue', 'cancelled')),
  FOREIGN KEY ("customerId") REFERENCES "customer" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("planVersionId") REFERENCES "plan_version" ("id") ON DELETE RESTRICT
) STRICT;

INSERT INTO "subscription__new" ("id", "reference", "customerId", "planVersionId", "status", "quantity", "trialEndsAt", "cancelledAt", "cancelAtPeriodEnd", "createdAt", "userId")
  SELECT "id", "reference", "customerId", "planVersionId", "status", "quantity", "trialEndsAt", "cancelledAt", "cancelAtPeriodEnd", "createdAt", "userId" FROM "subscription";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of subscription lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "subscription__new") = (SELECT count(*) FROM "subscription") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "subscription";
ALTER TABLE "subscription__new" RENAME TO "subscription";

-- recreate indexes for "subscription"
CREATE INDEX IF NOT EXISTS "idx_subscription_customerId" ON "subscription" ("customerId");
CREATE INDEX IF NOT EXISTS "idx_subscription_planVersionId" ON "subscription" ("planVersionId");

-- "invoice": add columns
ALTER TABLE "invoice" ADD COLUMN "reminded" INTEGER NOT NULL DEFAULT 0;

-- "invoice": rebuild — graceDays and dunningDays are terms stamped at issue (FJS-D355); an invoice
-- issued before they existed was owed on its own due date, so 0 days of grace and of dunning.
-- rebuild "invoice" — full table reconstruction required
CREATE TABLE "invoice__new" (
  "id" INTEGER NOT NULL PRIMARY KEY,
  "number" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "customerId" INTEGER NOT NULL,
  "subscriptionId" INTEGER,
  "subtotal" INTEGER NOT NULL CHECK ("subtotal" BETWEEN -9007199254740991 AND 9007199254740991),
  "tax" INTEGER NOT NULL DEFAULT 0 CHECK ("tax" BETWEEN -9007199254740991 AND 9007199254740991),
  "total" INTEGER NOT NULL CHECK ("total" BETWEEN -9007199254740991 AND 9007199254740991),
  "periodStart" TEXT NOT NULL,
  "periodEnd" TEXT NOT NULL,
  "issuedAt" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "dueOn" TEXT NOT NULL,
  "graceDays" INTEGER NOT NULL,
  "dunningDays" INTEGER NOT NULL,
  "paidAt" TEXT,
  "reminded" INTEGER NOT NULL DEFAULT 0,
  "userId" TEXT,
  CHECK ("status" IN ('draft', 'issued', 'paid', 'void')),
  CHECK (total = subtotal + tax),
  FOREIGN KEY ("customerId") REFERENCES "customer" ("id") ON DELETE RESTRICT,
  FOREIGN KEY ("subscriptionId") REFERENCES "subscription" ("id") ON DELETE RESTRICT
) STRICT;

INSERT INTO "invoice__new" ("id", "number", "status", "customerId", "subscriptionId", "subtotal", "tax", "total", "periodStart", "periodEnd", "issuedAt", "dueOn", "graceDays", "dunningDays", "paidAt", "userId")
  SELECT "id", "number", "status", "customerId", "subscriptionId", "subtotal", "tax", "total", "periodStart", "periodEnd", "issuedAt", "dueOn", 0 /* "graceDays" */, 0 /* "dunningDays" */, "paidAt", "userId" FROM "invoice";

-- the copy must not have lost rows — the next statement drops the original
CREATE TEMP TABLE "_litestone_rowcount" (
  ok INTEGER CONSTRAINT "rebuild of invoice lost rows" CHECK (ok = 1)
);
INSERT INTO "_litestone_rowcount" (ok)
  SELECT CASE WHEN (SELECT count(*) FROM "invoice__new") = (SELECT count(*) FROM "invoice") THEN 1 ELSE 0 END;
DROP TABLE "_litestone_rowcount";

DROP TABLE "invoice";
ALTER TABLE "invoice__new" RENAME TO "invoice";

-- recreate indexes for "invoice"
CREATE INDEX IF NOT EXISTS "idx_invoice_customerId" ON "invoice" ("customerId");
CREATE INDEX IF NOT EXISTS "idx_invoice_subscriptionId" ON "invoice" ("subscriptionId");
-- 

-- ─── full-text indexes (drop + create + rebuild) ──────────────────

DROP TABLE IF EXISTS "product_fts";
CREATE VIRTUAL TABLE "product_fts" USING fts5(
  "name", "description",
  content="product",
  content_rowid=rowid
);
INSERT INTO "product_fts"("product_fts") VALUES('rebuild');

-- ─── shared search index ───────────────────────────────────────────

DROP TABLE IF EXISTS "_search";
CREATE VIRTUAL TABLE IF NOT EXISTS "_search" USING fts5(
  model, rid UNINDEXED, title, body,
  tokenize='trigram'
);

-- ─── generated triggers (drop + recreate) ──────────────────────────

DROP TRIGGER IF EXISTS "product_fts_insert";
CREATE TRIGGER "product_fts_insert" AFTER INSERT ON "product" BEGIN
  INSERT INTO "product_fts"(rowid, "name", "description") VALUES (new.rowid, new."name", new."description");
END;
DROP TRIGGER IF EXISTS "product_fts_delete";
CREATE TRIGGER "product_fts_delete" AFTER DELETE ON "product" BEGIN
  INSERT INTO "product_fts"("product_fts", rowid, "name", "description") VALUES ('delete', old.rowid, old."name", old."description");
END;
DROP TRIGGER IF EXISTS "product_fts_update";
CREATE TRIGGER "product_fts_update" AFTER UPDATE ON "product" BEGIN
  INSERT INTO "product_fts"("product_fts", rowid, "name", "description") VALUES ('delete', old.rowid, old."name", old."description");
  INSERT INTO "product_fts"(rowid, "name", "description") VALUES (new.rowid, new."name", new."description");
END;
DROP TRIGGER IF EXISTS "product_search_insert";
CREATE TRIGGER "product_search_insert" AFTER INSERT ON "product" BEGIN
  INSERT INTO "_search"(model, rid, title, body) VALUES ('product', new.rowid, new."name", COALESCE(new."name", '') || ' ' || COALESCE(new."description", ''));
END;
DROP TRIGGER IF EXISTS "product_search_delete";
CREATE TRIGGER "product_search_delete" AFTER DELETE ON "product" BEGIN
  DELETE FROM "_search" WHERE model = 'product' AND rid = old.rowid;
END;
DROP TRIGGER IF EXISTS "product_search_update";
CREATE TRIGGER "product_search_update" AFTER UPDATE ON "product" BEGIN
  DELETE FROM "_search" WHERE model = 'product' AND rid = old.rowid;
  INSERT INTO "_search"(model, rid, title, body) VALUES ('product', new.rowid, new."name", COALESCE(new."name", '') || ' ' || COALESCE(new."description", ''));
END;

-- ─── shared search index (re-index) ────────────────────────────────

DELETE FROM "_search" WHERE model = 'product';
INSERT INTO "_search"(model, rid, title, body) SELECT 'product', rowid, "name", COALESCE("name", '') || ' ' || COALESCE("description", '') FROM "product";

COMMIT;
PRAGMA foreign_keys = ON;