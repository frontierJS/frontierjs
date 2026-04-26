-- ─── Calendar seed ─────────────────────────────────────────────────────────────
-- Populates a 'calendar' table with one row per day from 2000-01-01 to 2100-12-31.
-- Run once: litestone seed run calendar
--
-- Requires this table in your schema:
--   model calendar {
--     date         Text @id
--     day          Integer
--     weekday      Integer
--     weekdayName  Text
--     weekNumber   Integer
--     weekOfMonth  Integer
--     month        Text
--     monthName    Text
--     quarter      Integer
--     year         Integer
--   }

CREATE TABLE IF NOT EXISTS "calendar" (
  "date"        TEXT PRIMARY KEY,
  "day"         INTEGER NOT NULL,
  "weekday"     INTEGER NOT NULL,
  "weekdayName" TEXT    NOT NULL,
  "weekNumber"  INTEGER NOT NULL,
  "weekOfMonth" INTEGER NOT NULL,
  "month"       TEXT    NOT NULL,
  "monthName"   TEXT    NOT NULL,
  "quarter"     INTEGER NOT NULL,
  "year"        INTEGER NOT NULL
) STRICT;

WITH RECURSIVE dates(date) AS (
  SELECT date('2000-01-01')
  UNION ALL
  SELECT date(date, '+1 day') FROM dates
  WHERE date < '2100-12-31'
)
INSERT OR IGNORE INTO calendar (
  date, day, weekday, weekdayName, weekNumber, weekOfMonth,
  month, monthName, quarter, year
)
SELECT
  d.date,
  CAST(STRFTIME('%d', d.date) AS INTEGER),
  CAST(STRFTIME('%w', d.date) AS INTEGER),
  CASE STRFTIME('%w', d.date)
    WHEN '0' THEN 'Sunday'   WHEN '1' THEN 'Monday'
    WHEN '2' THEN 'Tuesday'  WHEN '3' THEN 'Wednesday'
    WHEN '4' THEN 'Thursday' WHEN '5' THEN 'Friday'
    ELSE 'Saturday'
  END,
  CAST(STRFTIME('%W', d.date) AS INTEGER),
  (
    CAST(STRFTIME('%W', d.date) AS INTEGER)
    - CAST(STRFTIME('%W', STRFTIME('%Y-%m-01', d.date)) AS INTEGER)
    + 1
  ),
  STRFTIME('%m', d.date),
  CASE STRFTIME('%m', d.date)
    WHEN '01' THEN 'January'   WHEN '02' THEN 'February'
    WHEN '03' THEN 'March'     WHEN '04' THEN 'April'
    WHEN '05' THEN 'May'       WHEN '06' THEN 'June'
    WHEN '07' THEN 'July'      WHEN '08' THEN 'August'
    WHEN '09' THEN 'September' WHEN '10' THEN 'October'
    WHEN '11' THEN 'November'  ELSE 'December'
  END,
  ((CAST(STRFTIME('%m', d.date) AS INTEGER) - 1) / 3) + 1,
  CAST(STRFTIME('%Y', d.date) AS INTEGER)
FROM dates d;
