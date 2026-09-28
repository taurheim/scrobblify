-- Uploaded track chunks, in their own D1 database.
--
-- These used to live in R2. R2 bills for anything past its free tier and has no
-- spending cap, whereas D1 on the Workers Free plan refuses writes at its limit
-- instead of charging. Keeping the bytes in a *separate* database means the
-- worst a full one can do is refuse new uploads: the scheduler's own database,
-- which holds every running job, never shares its 500 MB with them.
--
-- The chunk manifest (digest, sizes, index range) stays in the main database's
-- `chunks` table. This table only maps a key to bytes.
CREATE TABLE IF NOT EXISTS blobs (
  key        TEXT PRIMARY KEY,
  data       BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
