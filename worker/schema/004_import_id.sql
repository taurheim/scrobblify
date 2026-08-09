-- 004: queue identity.
--
-- Everything the client uses to decide whether it may send is keyed on the
-- *user*, and that is not the question. `GET /scrobblify/job/live?username=`
-- answers "is a job running right now", which does not imply "this queue is
-- safe to send". A worker can scrobble 20,000 tracks and then complete, or hit
-- `needs_reauth` — at which point `live` is false and a browser holding the
-- same saved import replays every one of them. Last.fm silently discards a
-- repeat of (artist, track, timestamp) while reporting it accepted, so the
-- user sees success and loses the plays.
--
-- The missing fact is which *queue* a job was created from. `import_id` is a
-- high-entropy id the browser mints once, when the user makes a selection, and
-- carries in its saved state. It travels with the handoff and is copied onto
-- the job, so afterwards the server can answer "has this exact queue ever been
-- handed over, and how far did it get" — regardless of which device is asking,
-- whether it still holds a session, or whether the job has since finished.
--
-- Not unique, deliberately. A queue can be handed over, taken back and handed
-- over again, and each attempt is its own row. Lookups take the live row if
-- there is one and the most recent otherwise.
--
-- Nullable, deliberately. Rows created before this migration have no id, and a
-- cached SPA bundle will keep omitting it for as long as it is cached. The
-- client treats "no id" as "cannot prove anything", which is the same posture
-- it takes when the server cannot be reached.
ALTER TABLE handoffs ADD COLUMN import_id TEXT;
ALTER TABLE jobs ADD COLUMN import_id TEXT;

CREATE INDEX IF NOT EXISTS handoffs_import_id ON handoffs (import_id);
CREATE INDEX IF NOT EXISTS jobs_import_id ON jobs (import_id);
