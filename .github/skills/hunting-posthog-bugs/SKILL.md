---
name: hunting-posthog-bugs
description: Use when looking for bugs, regressions or anomalies in scrobblify's production PostHog telemetry - triaging scrobblify_error events, checking whether a merged fix actually worked, investigating a user's bug report, or auditing the end-to-end journey (auth, upload, select, scrobble, resume) for silent failures such as progress going backwards, users stuck in a loop, or runs that vanish.
---

# Hunting bugs in PostHog telemetry

## Overview

Error events show what the app *noticed*. Journey invariants show what it
didn't: lost progress, dead ends and loops rarely throw. Run both, then prove
every finding with **one user's timeline and the code path**. An aggregate on
its own is only a lead.

**REQUIRED BACKGROUND:** the "Debugging with PostHog" section of `AGENTS.md`
(event semantics, which fields are resume-stable, known inflated date windows).
All SQL lives in [queries.md](queries.md) and was validated against the live
project; adapt it instead of writing from scratch.

## Ground rules

- Every query filters `properties.app = 'scrobblify'` (the project is shared
  with LastWave) and is time-bounded.
- Progress is `total_succeeded` / `completion_pct` per
  `(distinct_id, original_total_tracks)`. **Never** `scrobbled_tracks /
  total_tracks`: those are per-session and shrink on every resume. A changed
  `original_total_tracks` is a new import, not a regression.
- Sample progress from **all** run events, not just `scrobble_paused` (pacing
  noise), and don't keep one row per day: rollbacks happen within minutes.
- The code is the source of truth for event names and error contexts:
  `grep trackError\(|trackEvent\(|trackStopped\( src`. The `AGENTS.md` tables
  can lag behind it.
- Absence of events proves nothing: localhost is never captured and analytics
  failures are swallowed.

## Workflow

1. **Inventory** (Q1). New, vanished or per-user-rate-jumping events are leads.
2. **Errors** (Q2, Q3). Group by `context` + `message`, rank by **users**. Same
   error on several days for one user = no way out.
3. **Invariants.** Run every row of the table below.
4. **Deploy split** (Q11). For each lead, get the merge time of any related fix
   (`git --no-pager log --date=iso-strict --format="%cd %s" -30`, convert to
   UTC). All occurrences before it → *already fixed*. New shapes after it →
   *regression candidate* — often the most valuable finding. With several
   related merges, split at each one.
5. **Timeline** (Q10) for 1–2 example users per lead. Narrate the sequence.
6. **Code.** Find the path that produces that sequence; cite `file:line`.
7. **Classify and report** (below). Don't fix anything unless asked.

## Invariants

| Invariant | Violation usually means | Query |
| --- | --- | --- |
| `total_succeeded` never drops within an import; a resume never restores less than the prior max | stale saved state; re-sent tracks become phantom duplicates for `reTagged` plays | Q4 |
| Every `scrobble_stopped` has `auto_saved: true` | the save itself failed | Q5 |
| `completion_pct ≤ 100`, `total_succeeded ≤ original_total_tracks`, `succeeded + failed ≤ scrobbled + 1` | accounting bug, or tracks consumed without being sent | Q6 |
| Runs end in `scrobble_stopped` / `scrobble_completed` | tab closed mid-run — harmless alone, the cause of Q4 when nothing checkpoints | Q7 |
| `upload_parse_started` → completed, an `upload.*` error, or `upload_no_matching_files` | silent parse failure | Q8 |
| A fresh sign-in is not rejected with error 9 within minutes | token exchange keeps a dead key | Q9 |
| A terminal stop is followed by a working way back (not the same error again) | dead end or loop | Q3, Q10 |

## Classify

| Verdict | Test |
| --- | --- |
| **Bug** | Invariant broken, timeline shows the sequence, code path identified |
| **Regression** | As above, and only appears after a merge |
| **Silent failure** | Invariant broken but the trail just stops (tab killed, reload, OOM), so there is no code path to cite. Report it as an instrumentation or resilience gap, with the timeline |
| **Already fixed** | Every occurrence predates the relevant merge |
| **Expected** | Last.fm throttling (`burst_limit`, `rate_limit`, `daily_limit`); `scrobble_ignored` code 1; `window.onerror` "Script error." (cross-origin, no stack — noise unless it spikes); wrong Spotify export, which already has its own message |
| **Telemetry artifact** | Falls in a known-inflated window in `AGENTS.md`, or predates the fields it's missing |

## Report

Ranked by users affected. For each: verdict, one-line mechanism, impact (users,
occurrences, first/last seen, before/after deploy), the query, a short timeline
excerpt, suspected `file:line`, suggested next step. State uncertainty plainly.
Usernames are Last.fm handles: fine in a local report, **never** in commits,
PRs or issues.

## Common mistakes

| Mistake | Instead |
| --- | --- |
| Reporting a bug as live when its last occurrence predates the fix | Deploy split, step 4 |
| Reading two events for one user as contradictory ("got `session_invalid` *and* `repeated_failures`") | Read the timeline — it is usually a sequence, and the sequence is the bug |
| Stopping at "progress went backwards" | Name the mechanism: which save was stale, and why nothing newer was saved |
| Ranking errors by count | One stuck user produces dozens; rank by users |
| Treating every drop-off as a bug | Drop-off with no error and plausible timing is abandonment; flag only silent failures |
