-- Hand-numbered on purpose: litestone's own generated files carry a 14-digit
-- timestamp, and the test template builder has to replay a file like this one
-- rather than skip it. A skipped migration is an empty database.
BEGIN;
CREATE TABLE "account" (
  "id"   INTEGER PRIMARY KEY,
  "name" TEXT NOT NULL
) STRICT;
COMMIT;
