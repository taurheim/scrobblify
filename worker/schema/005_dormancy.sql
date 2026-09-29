-- Stalled jobs give their slot back.
--
-- A job parked in `paused`, `needs_reauth` or `needs_attention` holds one of
-- the scarce concurrency slots, and nothing used to take it away: a user who
-- paused and never came back held a slot, their credential and their whole
-- listening history for good. The hourly housekeeping pass now moves a job
-- that has been parked past `inactivity_deadline` to `dormant` (no slot, no
-- credential, tracks kept for take-back), and a job dormant past it to
-- `cancelled`.
--
-- The deadline is set here rather than at each call site. Fifteen statements
-- across the API and the scheduler move a job into a parked state, several of
-- them through CASE expressions, and any one that forgot would leave a job that
-- never expires. A trigger cannot be forgotten by the next one either.
--
-- `updated_at` is not usable as the clock: the background drain rewrites it
-- every tick for a parked job whose in-flight batch it cannot settle, so that
-- job would never look idle.
--
-- Only *entering* a state starts the clock. Every user action on a stalled job
-- (pause, reconnect, take-back) is a state change, so it restarts it; reading
-- the status does not.
--
-- The durations must match DORMANT_AFTER_SECONDS (14 days) and
-- EXPIRE_AFTER_SECONDS (30 days) in src/housekeeping.ts; a test asserts it.
CREATE TRIGGER IF NOT EXISTS jobs_inactivity_deadline
AFTER UPDATE OF state ON jobs
WHEN NEW.state IS NOT OLD.state
  AND NEW.state IN ('paused', 'needs_reauth', 'needs_attention', 'dormant')
BEGIN
  UPDATE jobs
     SET inactivity_deadline = NEW.updated_at
       + CASE WHEN NEW.state = 'dormant' THEN 2592000 ELSE 1209600 END
   WHERE id = NEW.id;
END;

-- Jobs already parked when this migration runs never had a deadline set.
-- Without one they would fall back to `updated_at`, which the drain can keep
-- pushing forward indefinitely (see above).
UPDATE jobs
   SET inactivity_deadline = updated_at + 1209600
 WHERE inactivity_deadline IS NULL
   AND state IN ('paused', 'needs_reauth', 'needs_attention');
