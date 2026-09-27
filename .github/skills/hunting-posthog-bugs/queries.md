# Bug-hunting queries

HogQL for the PostHog `execute-sql` tool. Every query was run against the live
project. All are scoped to `properties.app = 'scrobblify'` and a time bound —
keep both when adapting them. Change `INTERVAL 30 DAY` to suit.

HogQL gotchas hit while writing these:

- An output alias may not reuse the name of an inner column that is itself an
  aggregate (`countIf(x) AS x` over a subquery column `x` fails with "aggregate
  inside another aggregate"). Prefix inner columns (`has_x`).
- Self-joins on `events` run out of memory unless **both** sides are filtered
  subqueries (`FROM (SELECT … WHERE …) AS a JOIN (SELECT … WHERE …) AS e`).
- `$session_id` must be back-quoted: `` `$session_id` ``.

## Q1. Event inventory, week over week

A new event, a vanished one, or a jump in `per_user` is a lead: vanished means
a broken code path or instrumentation; a per-user jump means a loop or a
heartbeat (how `scrobble_paused` went from ~15/day to 734/day).

```sql
SELECT event,
  countIf(timestamp >= now() - INTERVAL 7 DAY) AS last_7d,
  countIf(timestamp <  now() - INTERVAL 7 DAY) AS prev_7d,
  uniqIf(distinct_id, timestamp >= now() - INTERVAL 7 DAY) AS users_7d,
  uniqIf(distinct_id, timestamp <  now() - INTERVAL 7 DAY) AS users_prev_7d,
  round(last_7d / nullIf(users_7d, 0), 1) AS per_user_7d,
  round(prev_7d / nullIf(users_prev_7d, 0), 1) AS per_user_prev_7d
FROM events
WHERE properties.app = 'scrobblify' AND timestamp >= now() - INTERVAL 14 DAY
GROUP BY event ORDER BY last_7d DESC LIMIT 100
```

## Q2. Errors by context and message

Rank by `users`, not `n` — one stuck user retrying produces dozens of rows.

```sql
SELECT properties.context AS context,
  substring(toString(properties.message), 1, 120) AS msg,
  count() AS n, uniq(distinct_id) AS users,
  min(timestamp) AS first_seen, max(timestamp) AS last_seen
FROM events
WHERE event = 'scrobblify_error' AND properties.app = 'scrobblify'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY context, msg ORDER BY users DESC, n DESC LIMIT 40
```

## Q3. Stuck users — same error on several days

Coming back days later and failing identically means the app gave them no way
out (the error-9 loop that stranded one user for 8 days looked like this).

```sql
SELECT distinct_id AS user, properties.context AS context,
  substring(toString(properties.message), 1, 80) AS msg,
  uniq(toDate(timestamp)) AS days, count() AS n,
  min(timestamp) AS first_seen, max(timestamp) AS last_seen
FROM events
WHERE properties.app = 'scrobblify' AND event = 'scrobblify_error'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY user, context, msg HAVING days >= 2
ORDER BY days DESC, n DESC LIMIT 30
```

## Q4. Progress must never go backwards

Invariant: within one import — one `(distinct_id, original_total_tracks)` —
`total_succeeded` only rises. A different `original_total_tracks` is a new
import and resetting is fine. The same `original_total_tracks` is *not* proof of
the same import: re-uploading the same export gives the same count, so a fresh
`scrobble_started` at `total_succeeded = 0` also starts a new import
(`import_seq` below). Without that split, 4a over-counts rollbacks by ~15%.
Every run event carries these fields, not just `scrobble_paused`, so sample all
of them and do **not** collapse to one row per day: rollbacks happen within
minutes.

**4a. Rollbacks on resume, split by where the state came from.** `saved` is
this browser's IndexedDB; `file` is an imported progress file (a stale file is
at least partly the user's doing; stale `saved` state is purely ours).

```sql
SELECT source, count() AS resumes,
  countIf(succ < prev_max - 0.5) AS rolled_back,
  uniqIf(user, succ < prev_max - 0.5) AS users_rolled_back,
  sumIf(prev_max - succ, succ < prev_max - 0.5) AS tracks_rolled_back
FROM (
  SELECT user, event, source, succ,
    max(succ) OVER (
      PARTITION BY user, otot, import_seq
      ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS prev_max
  FROM (
    SELECT distinct_id AS user, timestamp AS ts, event,
      toString(properties.source) AS source,
      toFloat(properties.total_succeeded) AS succ,
      toFloat(properties.original_total_tracks) AS otot,
      sum(if(event = 'scrobble_started' AND toFloat(properties.total_succeeded) = 0, 1, 0)) OVER (
        PARTITION BY distinct_id, toFloat(properties.original_total_tracks)
        ORDER BY timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS import_seq
    FROM events
    WHERE properties.app = 'scrobblify'
      AND properties.total_succeeded IS NOT NULL
      AND properties.original_total_tracks IS NOT NULL
      AND timestamp >= now() - INTERVAL 30 DAY
  )
)
WHERE event = 'session_resumed'
GROUP BY source ORDER BY resumes DESC
```

**4b. Example regressions to drill into** (any event, previous-row comparison).
Excludes `100` → `scrobble_started`, which is a user re-running a finished
import: a duplicate-scrobble risk for re-tagged plays, not lost work. Drop that
line to look at those separately.

```sql
SELECT user, ts, event, otot, prev_pct, pct, prev_succ, succ
FROM (
  SELECT distinct_id AS user, timestamp AS ts, event,
    toFloat(properties.original_total_tracks) AS otot,
    toFloat(properties.completion_pct) AS pct,
    toFloat(properties.total_succeeded) AS succ,
    lagInFrame(toFloat(properties.completion_pct)) OVER w AS prev_pct,
    lagInFrame(toFloat(properties.original_total_tracks)) OVER w AS prev_otot,
    lagInFrame(toFloat(properties.total_succeeded)) OVER w AS prev_succ,
    row_number() OVER w AS rn
  FROM events
  WHERE properties.app = 'scrobblify' AND properties.completion_pct IS NOT NULL
    AND timestamp >= now() - INTERVAL 30 DAY
  WINDOW w AS (PARTITION BY distinct_id ORDER BY timestamp
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
)
WHERE rn > 1 AND otot = prev_otot AND pct < prev_pct - 0.05
  AND NOT (prev_pct >= 100 AND event = 'scrobble_started')
ORDER BY ts DESC LIMIT 50
```

## Q5. Every terminal stop must have saved

`auto_saved: false` on `scrobble_stopped` means the save itself failed.

```sql
SELECT properties.reason AS reason, count() AS n,
  countIf(properties.auto_saved != true) AS not_saved,
  uniqIf(distinct_id, properties.auto_saved != true) AS users_not_saved
FROM events
WHERE properties.app = 'scrobblify' AND event = 'scrobble_stopped'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY reason ORDER BY n DESC
```

## Q6. Impossible counter values

Any non-zero column is an accounting bug (or an unrecognised event shape).
`succeeded + failed` may exceed `scrobbled` by exactly **1**: on
`repeated_failures` the last failing track is counted as failed but
deliberately left unconsumed so a resume retries it. Hence the `+ 1`.

```sql
SELECT event, count() AS n,
  countIf(toFloat(properties.completion_pct) > 100) AS pct_over_100,
  countIf(toFloat(properties.total_succeeded) > toFloat(properties.original_total_tracks)) AS succ_over_total,
  countIf(toFloat(properties.scrobbled_tracks) > toFloat(properties.total_tracks)) AS session_over_total,
  countIf(toFloat(properties.total_succeeded) < toFloat(properties.previously_scrobbled)) AS succ_below_prev,
  countIf(toFloat(properties.succeeded_tracks) + toFloat(properties.failed_tracks) > toFloat(properties.scrobbled_tracks) + 1) AS succ_plus_fail_over_done
FROM events
WHERE properties.app = 'scrobblify' AND properties.original_total_tracks IS NOT NULL
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY event ORDER BY n DESC
```

## Q7. How runs end

Per browser session, the last run event. Anything other than `scrobble_stopped`
/ `scrobble_completed` is a run that vanished (tab closed, crash, mobile tab
killed). Harmless on its own; it is the precondition for Q4 rollbacks, since
state is only saved on a terminal stop. Excludes the last day so live runs don't
count. Circumstantial only: `$session_id` is a PostHog *browser* session, not a
run or an import, so one row can span several runs. Tie a vanished run to a
rollback per user with Q10.

```sql
SELECT last_event, count() AS runs, uniq(user) AS users
FROM (
  SELECT distinct_id AS user, `$session_id` AS sid, argMax(event, timestamp) AS last_event
  FROM events
  WHERE properties.app = 'scrobblify'
    AND event IN ('scrobble_started', 'scrobble_resumed', 'scrobble_stopped',
      'scrobble_completed', 'scrobble_paused', 'scrobble_pacing_ended',
      'scrobble_rate_limited', 'scrobble_rate_limit_cooldown_complete',
      'scrobble_network_error', 'scrobble_ignored')
    AND timestamp >= now() - INTERVAL 30 DAY AND timestamp < now() - INTERVAL 1 DAY
  GROUP BY user, sid
)
GROUP BY last_event ORDER BY runs DESC
```

## Q8. Journey funnel with silent stalls

Per user, which steps they reached. `silent_parse_stall` = started parsing but
got no result, no upload error and no "no matching files" — a failure the app
never reported (or a user who left mid-parse). Drill in with Q10: a return to
`step_viewed authenticate` seconds later, repeatedly, on a large file points at
a reload or tab kill (memory), not abandonment.

```sql
SELECT count() AS users, countIf(has_auth) AS authed,
  countIf(has_ps) AS parse_started, countIf(has_pc) AS parse_done,
  countIf(has_ps AND NOT has_pc AND NOT has_ue AND NOT has_nm) AS silent_parse_stall,
  countIf(has_sel) AS selected, countIf(has_run) AS started,
  countIf(has_sel AND NOT has_run) AS selected_never_started,
  countIf(has_done) AS completed
FROM (
  SELECT distinct_id,
    max(event = 'auth_success') AS has_auth,
    max(event = 'upload_parse_started') AS has_ps,
    max(event = 'upload_parse_completed') AS has_pc,
    max(event = 'scrobblify_error' AND startsWith(toString(properties.context), 'upload.')) AS has_ue,
    max(event = 'upload_no_matching_files') AS has_nm,
    max(event = 'tracks_selected') AS has_sel,
    max(event IN ('scrobble_started', 'scrobble_resumed')) AS has_run,
    max(event = 'scrobble_completed') AS has_done
  FROM events
  WHERE properties.app = 'scrobblify' AND timestamp >= now() - INTERVAL 30 DAY
  GROUP BY distinct_id
)
```

## Q9. Fresh sign-in followed by "Invalid session key"

A brand-new key must not be rejected within minutes. Hits here mean the token
exchange is keeping or reusing a dead key.

```sql
SELECT a.user AS user, a.auth_at AS auth_at, min(e.err_at) AS first_error_at,
  dateDiff('second', a.auth_at, min(e.err_at)) AS secs_after_auth
FROM (
  SELECT distinct_id AS user, timestamp AS auth_at FROM events
  WHERE event = 'auth_success' AND properties.returning = false
    AND properties.app = 'scrobblify' AND timestamp >= now() - INTERVAL 30 DAY
) AS a
JOIN (
  SELECT distinct_id AS user, timestamp AS err_at FROM events
  WHERE event = 'scrobblify_error' AND properties.app = 'scrobblify'
    AND timestamp >= now() - INTERVAL 30 DAY
    AND toString(properties.message) LIKE '%error 9 %'
) AS e ON e.user = a.user
WHERE e.err_at >= a.auth_at AND e.err_at <= a.auth_at + INTERVAL 10 MINUTE
GROUP BY user, auth_at ORDER BY auth_at DESC LIMIT 30
```

## Q10. One user's timeline

The proof step. Drop the chatty events so the story is readable; add them back
if you need pacing detail.

```sql
SELECT timestamp, event, properties.context AS context,
  substring(toString(properties.message), 1, 80) AS msg,
  properties.reason AS reason, properties.source AS source,
  properties.step_name AS step, properties.total_succeeded AS succ,
  properties.completion_pct AS pct, properties.scrobbled_tracks AS done,
  properties.failed_tracks AS failed, properties.auto_saved AS auto_saved,
  `$session_id` AS sid
FROM events
WHERE properties.app = 'scrobblify' AND distinct_id = '<username>'
  AND timestamp >= '<from>' AND timestamp < '<to>'
  AND event NOT IN ('scrobble_paused', 'scrobble_pacing_ended', '$set')
ORDER BY timestamp LIMIT 300
```

## Q11. Everything since a deploy

Use the merge time of the fix under suspicion (`git log --date=iso-strict`,
convert to UTC). New error shapes or terminal reasons after it are regressions
candidates; old ones that stop appearing confirm the fix.

```sql
SELECT timestamp, distinct_id, event, properties.context AS context,
  substring(toString(properties.message), 1, 100) AS msg,
  properties.reason AS reason, properties.total_succeeded AS succ
FROM events
WHERE properties.app = 'scrobblify' AND timestamp >= '<deploy UTC>'
  AND event IN ('scrobblify_error', 'scrobble_stopped', 'user_logged_out',
                'auth_failed', 'auth_token_invalid')
ORDER BY timestamp LIMIT 200
```
