-- A second file, so ordering is exercised: this column does not exist until
-- 001 has run, and the template is only correct if both replay in filename order.
BEGIN;
ALTER TABLE "account" ADD COLUMN "note" TEXT;
COMMIT;
