-- 003: export claim identity.
--
-- Taking a job back moves it into `exporting`, which nothing schedules and
-- nothing resumes. Two columns make that claim exclusive and reversible.
--
-- `export_claim` is the claimant's token. Without it, "re-claiming from
-- exporting is allowed" meant *anyone* could, so two tabs could read the queue
-- concurrently; one could then save and cancel — deleting the blobs — while
-- the other was still reading, and the second would return a silently partial
-- export that overwrites the complete local save. Retries must present the
-- same token.
--
-- `export_prev_state` is what to go back to. An abandoned claim is reverted by
-- the sweep, and reverting unconditionally to `paused` would quietly clear a
-- `needs_attention` or `needs_reauth` that the user still has to act on.
ALTER TABLE jobs ADD COLUMN export_claim TEXT;
ALTER TABLE jobs ADD COLUMN export_prev_state TEXT;
