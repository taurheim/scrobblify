-- Background scrobbling schema, v1.
--
-- Portability rules (see spec "Portability requirements"): this must run on
-- D1's SQLite today and Postgres after a migration, so it avoids AUTOINCREMENT,
-- SQLite-specific types, generated columns and STRICT tables. Times are unix
-- seconds in INTEGER columns rather than a date type, because SQLite has no
-- real date type and the semantics of one would not survive the move.
--
-- Migration rules (see spec "Safe-deploy mechanics"): additive only. A column a
-- running job depends on is never dropped or renamed, because jobs live for
-- weeks and will span deploys. New columns must be nullable or carry a default
-- so rows written by older code still load.

-- Global control plane. Exactly one row, id = 1.
--
-- `paused` is the kill switch, checked first on every tick: flip it and jobs
-- freeze mid-flight rather than being torn down.
--
-- The circuit breaker is global rather than per-job because Last.fm error 29 is
-- documented as an *IP* limit. Every job shares one egress IP, so per-job
-- backoff would keep hammering a limit that is actually shared.
CREATE TABLE IF NOT EXISTS control (
  id                      INTEGER PRIMARY KEY,
  paused                  INTEGER NOT NULL DEFAULT 0,
  paused_reason           TEXT,
  -- Set on error 26 (suspended API key). Every job is dead until a human
  -- resolves it; retrying makes the suspension worse.
  halted                  INTEGER NOT NULL DEFAULT 0,
  halted_reason           TEXT,
  -- Global circuit breaker for error 29. No job may send before this time.
  breaker_open_until      INTEGER NOT NULL DEFAULT 0,
  breaker_trip_count      INTEGER NOT NULL DEFAULT 0,
  breaker_last_tripped_at INTEGER,
  -- Slots are reserved at handoff step 0, not at activation, so capacity cannot
  -- fill between a user authorising and their job going active.
  max_concurrent_jobs     INTEGER NOT NULL DEFAULT 50,
  updated_at              INTEGER NOT NULL DEFAULT 0
);

INSERT INTO control (id, paused, halted, updated_at)
SELECT 1, 0, 0, 0
WHERE NOT EXISTS (SELECT 1 FROM control WHERE id = 1);

-- The two-phase handoff (spec "The handoff is a transaction").
--
-- This table exists so the worker can verify, at callback time, something it
-- committed *before* the redirect. A digest or nonce that originates on the
-- client proves nothing.
--
-- States: issued -> exchanging -> pending_upload -> finalizing -> active,
-- plus terminal failed / reaped. Every transition is a CAS from the expected
-- prior state, which is what makes duplicate callbacks safe.
CREATE TABLE IF NOT EXISTS handoffs (
  id                 TEXT PRIMARY KEY,
  state              TEXT NOT NULL,
  username           TEXT NOT NULL,
  -- Mirrors `username` while this handoff is live and is set to NULL when it
  -- reaches a terminal state. A UNIQUE index over it therefore enforces "one
  -- live handoff per username" -- two tabs can race, so this belongs in SQL
  -- rather than application code. NULLs are not compared by a unique index in
  -- either SQLite or Postgres, so terminal rows accumulate freely.
  --
  -- Deliberately a plain column rather than a generated one: generated columns
  -- differ between SQLite and Postgres, and this must survive that migration.
  -- It is written in the same statement as every `state` change.
  live_username      TEXT,
  -- SHA-256 of the payload, committed server-side before the redirect, plus the
  -- shape we expect the upload to have. Compared against what actually arrives.
  payload_digest     TEXT NOT NULL,
  track_count        INTEGER NOT NULL,
  chunk_count        INTEGER NOT NULL,
  declared_bytes     INTEGER NOT NULL,
  algorithm_version  INTEGER NOT NULL,
  -- Set once the exchange succeeds: the job this handoff produced.
  job_id             TEXT,
  -- Retry bookkeeping for a stalled auth.getSession.
  exchange_attempts  INTEGER NOT NULL DEFAULT 0,
  failure_reason     TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  -- Reaped after this. A user who closes the tab mid-flow must not leave a
  -- permanent write credential behind.
  expires_at         INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS handoffs_live_username
  ON handoffs (live_username);

CREATE INDEX IF NOT EXISTS handoffs_expiry ON handoffs (state, expires_at);

-- One row per background job.
--
-- `generation` is the fencing token. A lease (`locked_until`) alone does not
-- provide mutual exclusion: a tick that stalls past its lease keeps running and
-- its writes can land after another tick has claimed the job. Acquisition is a
-- single atomic CAS that bumps this, and every dependent write is conditioned
-- on it still being current, so a superseded tick's writes are rejected rather
-- than silently interleaved.
--
-- Fencing protects D1, not Last.fm: a superseded tick's outbound request cannot
-- be revoked. That is the duplicate window the at-least-once decision accepts.
CREATE TABLE IF NOT EXISTS jobs (
  id                    TEXT PRIMARY KEY,
  username              TEXT NOT NULL,
  -- Same NULL-exclusion trick as handoffs: at most one live job per user.
  live_username         TEXT,
  state                 TEXT NOT NULL,
  state_reason          TEXT,

  generation            INTEGER NOT NULL DEFAULT 0,
  locked_until          INTEGER NOT NULL DEFAULT 0,

  -- Encrypted with a key held as a Worker secret, never stored beside the
  -- ciphertext. Nulled the instant the job reaches a terminal state.
  session_key_ct        TEXT,
  session_key_iv        TEXT,

  -- Pinned at creation. Immutable bytes are not immutable behaviour: new code
  -- may parse, order or timestamp the same blob differently. A worker that no
  -- longer implements this version must refuse the job, not reinterpret it.
  algorithm_version     INTEGER NOT NULL,
  schema_version        INTEGER NOT NULL DEFAULT 1,
  manifest_key          TEXT,
  manifest_digest       TEXT,

  total_tracks          INTEGER NOT NULL,
  -- Contiguous terminal prefix only. Progress counts are derived from batch
  -- outcomes, not from this: one batch of 50 can contain accepted, permanently
  -- failed, retryable and unknown entries at once, and code 5 can begin
  -- part-way through, so the failures are not even a suffix.
  cursor                INTEGER NOT NULL DEFAULT 0,
  scrobbled_count       INTEGER NOT NULL DEFAULT 0,
  failed_count          INTEGER NOT NULL DEFAULT 0,

  -- Round-robin fairness: due jobs are ordered by this ascending, so one 100k
  -- import cannot starve everything behind it for a month.
  last_run_at           INTEGER NOT NULL DEFAULT 0,
  -- No sends before this. Used for per-user code-5 daily backoff, as distinct
  -- from the global error-29 breaker.
  next_eligible_at      INTEGER NOT NULL DEFAULT 0,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,

  -- Whether Last.fm's daily cap resets on a clock or a rolling window is not
  -- documented. The scheduler therefore measures a conservative 24h from the
  -- first accepted send of the capped period and probes, rather than assuming
  -- midnight and waking every job at once into the same shared egress IP.
  daily_window_start    INTEGER,
  daily_window_count    INTEGER NOT NULL DEFAULT 0,
  probing               INTEGER NOT NULL DEFAULT 0,

  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  -- 60-day credential TTL. Admission control rejects jobs whose conservative
  -- completion estimate exceeds this, rather than accepting an import that is
  -- guaranteed to be abandoned half-finished.
  credential_expires_at INTEGER NOT NULL,
  -- Jobs parked in needs_reauth / needs_attention / paused must not squat a
  -- scarce slot for 60 days.
  inactivity_deadline   INTEGER,
  completed_at          INTEGER,
  -- Completed rows are retained without the credential so a returning user sees
  -- a summary instead of "no job found".
  purge_after           INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_live_username ON jobs (live_username);

-- The scheduler's hot query: due jobs, round-robin by last_run_at.
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (state, next_eligible_at, last_run_at);
CREATE INDEX IF NOT EXISTS jobs_purge ON jobs (purge_after);

-- Chunk manifest. Chunks are independently compressed so a tick reads exactly
-- the chunk its cursor points into, rather than decompressing a whole history
-- every tick for every job.
--
-- Chunks are written once and validated on upload; the manifest is published
-- last and the transition to active is conditional on every chunk being
-- present, hash-valid and non-overlapping. Missing, duplicated or reordered
-- chunks are detectable from these rows alone.
CREATE TABLE IF NOT EXISTS chunks (
  job_id             TEXT NOT NULL,
  chunk_index        INTEGER NOT NULL,
  r2_key             TEXT NOT NULL,
  -- Half-open [start_index, end_index) over the job's track list.
  start_index        INTEGER NOT NULL,
  end_index          INTEGER NOT NULL,
  entry_count        INTEGER NOT NULL,
  digest             TEXT NOT NULL,
  -- Both bounds are recorded because an authenticated user uploads arbitrary
  -- compressed bytes. Without an uncompressed bound, a small compression bomb
  -- exhausts Worker memory at scheduling time, taking down every job on that
  -- tick rather than just the attacker's.
  compressed_bytes   INTEGER NOT NULL,
  uncompressed_bytes INTEGER NOT NULL,
  verified           INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (job_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS chunks_lookup ON chunks (job_id, start_index);

-- One row per in-flight batch, holding per-entry granularity in packed JSON
-- columns.
--
-- Per-entry *granularity* is required for correctness; per-entry *rows* are
-- not. The feasibility spike measured that a row-per-scrobble schema exhausts
-- D1's 100k writes/day at six concurrent users, while packed columns cost about
-- 160 writes/user/day.
--
-- `assigned_timestamps` is durably written BEFORE the batch is sent. Because
-- the worker chose those timestamps and they are unique by construction, they
-- form a stable idempotency key that survives a crash: on recovery the next
-- tick fetches the narrow window covering the uncommitted mapping and looks for
-- those exact tuples. This narrows the duplicate window; it does not close it,
-- which is why the guarantee is at-least-once.
CREATE TABLE IF NOT EXISTS batches (
  id                  TEXT PRIMARY KEY,
  job_id              TEXT NOT NULL,
  -- The generation that owned the job when this batch was created. Writes from
  -- a superseded tick are rejected by comparing against jobs.generation.
  generation          INTEGER NOT NULL,
  start_index         INTEGER NOT NULL,
  entry_count         INTEGER NOT NULL,
  state               TEXT NOT NULL,
  -- JSON array of serialised `AssignedTrack` objects, positionally aligned
  -- with the batch entries. Each carries `timestampSec` — the second actually
  -- submitted — alongside the track and its index in the job's blob.
  assigned_timestamps TEXT NOT NULL,
  -- JSON array of ignore codes, positionally aligned. NULL until a response is
  -- parsed. Entries whose fate is unknown after a lost response stay behind
  -- rather than letting the cursor advance over them.
  outcomes            TEXT,
  accepted_count      INTEGER,
  ignored_count       INTEGER,
  error_code          INTEGER,
  error_message       TEXT,
  sent_at             INTEGER,
  settled_at          INTEGER,
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS batches_job ON batches (job_id, start_index);
CREATE INDEX IF NOT EXISTS batches_unsettled ON batches (state, created_at);

-- Batch audit log, so any incident can be diagnosed and its blast radius
-- established. Deliberately separate from `batches`, which is pruned as batches
-- settle.
--
-- Must never contain track names: a user's listening history is personal data,
-- and is minimised and deleted on the same schedule as the credential.
CREATE TABLE IF NOT EXISTS audit (
  id         TEXT PRIMARY KEY,
  job_id     TEXT,
  generation INTEGER,
  event      TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_job ON audit (job_id, created_at);
CREATE INDEX IF NOT EXISTS audit_time ON audit (created_at);

-- Failed tracks, retained for the completion page's downloadable failure list.
-- This is the one place track names outlive the blob, because the UI promises
-- that list; purged on the same schedule as everything else.
CREATE TABLE IF NOT EXISTS failures (
  job_id      TEXT NOT NULL,
  track_index INTEGER NOT NULL,
  artist      TEXT NOT NULL,
  track       TEXT NOT NULL,
  album       TEXT,
  reason      TEXT NOT NULL,
  ignore_code INTEGER,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (job_id, track_index)
);
