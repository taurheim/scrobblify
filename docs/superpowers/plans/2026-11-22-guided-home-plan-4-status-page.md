# Guided home, part 4: the status page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a user has a background (server) job, Home *is* its status page: progress for the whole import, one status line, and the controls (Pause/Resume, Reconnect, Scrobble the rest locally, Cancel). `/scrobble` sends you there instead of showing a job banner over an empty upload step.

**Architecture:** A new `BackgroundStatus.vue` renders a job view computed by pure helpers in a new `src/services/JobStatus.ts`, from whatever Home can learn: the worker job (with a worker session), the public `/import/:id` lookup (this browser handed it over), or `/job/live` (a remembered username; "other device"). Pause/Resume/Cancel/Reconnect call the existing `BackgroundScrobbling.ts` API from Home. Take-back stays in `Scrobblify.vue` (it is tied to the scrobble state): Home records a `takeBack` sign-in intent and opens `/scrobble`, through Last.fm first if this browser has no Last.fm session (with an explainer). The worker records why a job went on hold (`dormant_from`) and a reconnect resumes the job.

**Tech Stack:** Vue 3 + Vuetify 3 (Options API), TypeScript, Playwright; Cloudflare Worker + D1 (Node-script tests, `cd worker; npm test`).

**Spec:** `docs/superpowers/specs/2026-11-20-guided-home-and-background-design.md` sections 6 and 7.2–7.3, **amended**: the status page lives on Home (not on `/scrobble` instead of the stepper), and `/scrobble` redirects to Home while a job is shown. Copy: `docs/superpowers/specs/2026-11-20-guided-home-strings.md` (`status.*`, `moveBack.explain.*`) — verbatim. Where the two disagree with the user's later decisions, these win: the card keeps "Scrobbling to {username}" as its title, and an active job keeps "Scrobbling remotely, it's safe to close this tab." under its line.

**Also fixes:** #148 (take-back blocks its own tab), #163 (`all_re_tagged` on confirm declines), #166 (Back from Last.fm with a leftover worker session), #167 (import lookup counts a never-finalised cancelled job).

## Ground rules for every task

- Read `AGENTS.md` first. Never use port 8080: run Playwright as `$env:PORT=8644; npx playwright test …` in the same command. Worker-configured suite: `npx playwright test -c playwright.unreachable-worker.config.ts` (own server on 8471). Worker: `cd worker; npm test`. Don't edit files during a Playwright run.
- Never commit `package-lock.json`. Trailer: `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- `npm run lint:check` 0 errors; `npm run build` succeeds. Bugs found outside the task: file an issue per AGENTS.md.

## The status view (shared contract)

`src/services/JobStatus.ts` exports:

```ts
export type StatusAction =
  | 'pause' | 'resume' | 'reconnect' | 'signInAgain' | 'tryAgain'
  | 'signIn' | 'moveBack' | 'cancel' | 'checkItOut' | 'newImport';

export interface StatusView {
  /** Progress over the whole import when known (handover record), else the job's. */
  bar: { done: number; total: number; pct: number } | null;
  line: string;            // one status line (copy below)
  sub: string;             // second line, may be ''
  tooltip: string;         // server reason, for needs_attention / failed
  primary: StatusAction | null;
  primaryDisabled: boolean;
  secondary: StatusAction[];   // shown as buttons under the bar
  showRejected: number;        // completed with failed > 0
}

export function viewFromJob(job: JobStatus, opts: { nowSec: number; originalTotal?: number; doneBefore?: number }): StatusView;
export function viewFromImport(status: ImportStatus, opts: { nowSec: number; originalTotal?: number }): StatusView; // no session, this browser handed it over
export function viewOtherDevice(): StatusView;   // no session, no record, /job/live says live
```

States (copy from the strings file; `{date}` = `toLocaleDateString([], { month: 'long', day: 'numeric' })` of `estimatedCompletionSec` or, for the public lookup, now + ceil(remaining / 700) days; `{time}` = `toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })` of `waitingUntil`/`nextRunAt`):

| Job | line | sub | primary | secondary |
| --- | --- | --- | --- | --- |
| `pending`, `active` | `status.active` | "Scrobbling remotely, it's safe to close this tab." | pause | moveBack, cancel |
| `active`, `reason` is the worker's `DAY_FULL_REASON` | `status.dayFull` (time = next run) | same | pause | moveBack, cancel |
| `paused` | `status.paused` | '' | resume | moveBack, cancel |
| `needs_reauth` | `status.needsReauth` | '' | signInAgain (disabled if `reconnectAvailable === false`) | moveBack, cancel |
| `needs_attention` | `status.needsAttention` (tooltip = reason) | '' | tryAgain | moveBack, cancel |
| `dormant`, `dormantFrom` `paused` or null | `status.dormant` (date = `inactivityDeadline`) | '' | reconnect | moveBack, cancel |
| `dormant`, `dormantFrom` `needs_reauth` | `status.dormant.signedOut` | '' | reconnect | moveBack, cancel |
| `dormant`, `dormantFrom` `needs_attention` | `status.dormant.errors` | '' | reconnect | moveBack, cancel |
| `dormant`, `reconnectAvailable === false` | `status.dormant.full` (links: buy me a coffee; "scrobble locally" = moveBack) | '' | reconnect, disabled | moveBack, cancel |
| `exporting` | `status.exporting` | '' | none | none |
| `exporting`, this tab's take-back of it failed | `notice.moveBackFailed` | '' | none | moveBack |
| `completed` | `status.completed` (+ `status.rejected` when failed > 0) | '' | checkItOut | newImport |
| `failed` | `status.failed` (tooltip = reason) | '' | newImport | none |
| `cancelled` | never shown | | | |
| no session, handed over here, sending (`live`, `active`/`pending`) | `status.noSession` | `status.noSession.hint` | signIn | none |
| no session, handed over here, `paused` | `status.paused` | `status.noSession.hint` | signIn | none |
| no session, handed over here, any other state | `status.noSession.stopped` | '' | signIn | none |
| no session, other device | `status.noSession.otherDevice` | `status.noSession.hint` | signIn | none |

`DAY_FULL_REASON`: import it if `src/shared/` can host it, otherwise mirror the worker's string in `JobStatus.ts` with a comment pointing at `worker/src/scheduler.ts` (test that they match in `worker/test`, which can import client files the way `client-*.test.ts` do).

Dismissed finished jobs: `localStorage['scrobblify.background.dismissedJob']` = job id (`dismissJob(id)`, `isJobDismissed(id)` in `BackgroundScrobbling.ts`). A job is **shown** when it exists, is not `cancelled`, and is not dismissed.

---

### Task 1: Worker — `dormant_from`, reconnect resumes, import lookup (#167)

**Files:** `worker/schema/007_dormant_from.sql` (new), `worker/src/housekeeping.ts` (`markDormant`), `worker/src/api.ts` (`reattachCredential`, `describeJob`, `/scrobblify/import/:id`), `worker/src/store.ts` (`JobRow`), tests in `worker/test/housekeeping.test.ts`, `worker/test/api.test.ts`; `tests/backgroundMock.js`.

- Migration 007: `ALTER TABLE jobs ADD COLUMN dormant_from TEXT;` (nullable; follow worker/README.md migration rules; the test schema loads all files).
- `markDormant` sets `dormant_from = state` (the state it left: `paused`, `needs_reauth`, `needs_attention`) in the same UPDATE.
- `describeJob` returns `dormantFrom: job.dormant_from ?? null` (only meaningful while `dormant`; return null otherwise).
- `reattachCredential`: restore to `paused` when the job is `dormant` with `dormant_from = 'paused'`, otherwise to `active`; clear `dormant_from`. Update its doc comment (it said `paused` so continuing stays explicit; now signing in again is the only step, except for a job the user had paused). Keep the audit event, adding `to`.
- `needs_attention` "Try again": check that `POST /scrobblify/job/:id/resume` accepts `needs_attention`; if not, allow it (to `active`, `consecutive_failures = 0`, clear `state_reason`). Test it.
- #167: the import lookup leaves out job rows with `state = 'cancelled' AND manifest_key IS NULL` (never finalised). Read the issue (`gh issue view 167`) and add its regression tests.
- Tests: `dormant_from` set by `markDormant` for each parked state; `describeJob` exposes it; reconnect from `needs_reauth` → `active`; from dormant/`needs_attention` → `active`; from dormant/`paused` → `paused`; `dormant_from` cleared; resume from `needs_attention` (if added); #167 cases.
- Mock (`tests/backgroundMock.js`): keep `dormantFrom` on the mock job (set by `setState` when entering `dormant` from a parked state; `__mock/job` accepts `dormantFrom` too), expose it in `jobView()`, and the sign-in reattach moves to `active` (or `paused` when `dormantFrom === 'paused'`).
- Commit `Worker: record why a job went on hold, and resume it on reconnect` (body `Fixes #167`).

### Task 2: `JobStatus.ts`, `BackgroundStatus.vue`, Home as the status page

**Files:** create `src/services/JobStatus.ts`, `src/components/BackgroundStatus.vue`; modify `src/views/Home.vue`, `src/services/ReturningVisitor.ts`, `src/components/home/HomeReturning.vue` (drop its server-job branch), `src/services/BackgroundScrobbling.ts` (`JobStatus.dormantFrom`, dismissed-job helpers, `ImportStatus` export if needed); tests in `tests/unreachable-worker/unreachable-worker.spec.ts`.

Home decides what to show (`detectReturning` grows a `kind: 'job'` result, or Home calls a new `loadJobForHome()` first):
1. Worker session → `fetchJob()`. A shown job → status page from `viewFromJob`, with the whole-import bar when the handed-over record matches (`importId`/`username`): `overallProgress` already does this math.
2. No session, handed-over record, public lookup `known` and not ended → `viewFromImport`.
3. No session, no record, remembered username and `liveJobForUsername` says live → `viewOtherDevice`. Asked only without a worker session (or after the job lookup's 401 cleared it), in parallel with the other lookups.
4. Otherwise today's cards, unchanged.

`BackgroundStatus.vue` (props: `view: StatusView`, `username`, `busy`; emits one event per action): card titled "Scrobbling to {username}" with a labelled bar (`{done} / {total} · {pct}%`, as Home's card draws it today), Pause/Resume as a small button to the right of the bar when `primary` is pause/resume, otherwise the primary as a block button under the line; the line, the sub-line, a tooltip icon for `tooltip`; secondary actions as text buttons; Cancel opens the confirm dialog (`status.cancel.confirm.*`, body with `{done}`). `checkItOut` links to `https://www.last.fm/user/{username}` (new tab).

Home wires the actions:
- pause / resume / tryAgain → `jobAction(id, 'pause' | 'resume')`, then refetch.
- reconnect / signInAgain / signIn → `startReauth(username || '')` and redirect (today's `reauthenticate` logic; on no URL show "Couldn't reach our server. Try again in a few minutes.").
- cancel (confirmed) → `jobAction(id, 'cancel')`; on success clear the handed-over record and re-detect (Home falls back to the normal cards).
- newImport → `dismissJob(id)`, `$router.push('/scrobble')`.
- moveBack → Task 3.
Polling moves here from `Scrobblify.vue` (same rules: re-fetch `JOB_POLL_AFTER_RUN_SECONDS` after `nextRunAt`, clamped 15 s–10 min, only while active and visible, check on becoming visible, keep the last view on a failed check, discard results that land after an action). New: a `dormant` job with `reconnectAvailable === false` re-checks every 5 minutes while visible and on becoming visible. `showingServerJob` (BETA tag) is set while the status page shows.

Tests first (worker-configured suite; mock worker with `mock.world.job` / `setState`): every row of the table renders its line and buttons, including each `dormantFrom`, the full-server dormant row (Reconnect disabled) re-enabling after capacity returns (advance time with `page.clock` if available, or expose the interval via a short test override), the no-session rows with and without a handed-over record, pause → paused → resume, cancel → confirm → back to the first-visit page, completed → "Check it out!" link + "Start a new import" → `/scrobble` upload step and not redirected back (Task 3), whole-import bar after a handover (e.g. 10,233 / 18,523).

Commit `Home is the status page for a server job`.

### Task 3: `/scrobble` sends you to Home; Scrobble the rest locally; #148

**Files:** `src/components/Scrobblify.vue`, `src/services/SignInIntent.ts`, `src/views/Home.vue`, `src/components/BackgroundStatus.vue` (explainer dialog or a small `MoveBackExplainer.vue`); tests.

- `Scrobblify.vue`: once `mounted` has settled the handoff return and `refreshBackgroundJob()`, and whenever a later refresh first finds one, if a **shown** job exists (not cancelled, not dismissed) and no take-back is under way (`takeBack` intent being acted on, or `backgroundBusy`), `this.$router.replace({ name: 'home' })`. Delete the `job` banner template and the job-card-only computeds/polling that moved to Home; keep `backgroundJob` and everything the authority and offer logic read from it. The worker lookup's `result: 'job'` and the "Sign in to see it" return now land on Home through the same rule.
- `SignInIntent`: new kind `{ kind: 'takeBack'; jobId: string }`. `continueSignInIntent` handles it: if the job is still listed and in a state take-back accepts, run `takeBackProgress()` (no redirect to Home meanwhile), else drop it.
- Home's moveBack: signed in to Last.fm here (`api.isAuthenticated()`) → `setSignInIntent({ kind: 'takeBack', jobId })` and push `/scrobble`. Not signed in → explainer dialog (`moveBack.explain.*`), "Continue to Last.fm" → `startSignIn(api, { kind: 'takeBack', jobId })`, "Cancel" closes. Events: `move_back_explainer_shown`, `move_back_explainer_choice` (`continue` / `cancel`).
- A successful take-back cancels the job, so it's never shown again (cancelled). Check what `/scrobble` shows after it (success notice + Resume) and that nothing redirects.
- #148 (`gh issue view 148`): the take-back tab ignores its own ownership release (flag naming the job set before `releaseQueueOwnerIfUnclaimed`, checked in the `onServerOwnershipChange` listener before `revalidateAfterRelease`); sibling tabs still revalidate. Test: take-back from the UI ends with Resume available and no "out of date" notice.
- Tests: `/scrobble` with a live job → Home status page; with a dismissed completed job → upload step stays; moveBack signed in → `/scrobble`, tracks restored, Resume offered; moveBack signed out → explainer → Continue → Last.fm (`routeLastFmSignIn`) → back → take-back runs → Resume offered; explainer Cancel → nothing happens.
- Commit `Scrobble page sends you to the status page; scrobble the rest locally from it` (body `Fixes #148`).

### Task 4: #166 and #163

- #166 (`gh issue view 166`): apply the suggested fix (own preflighted freeze settles by the public import check whether or not a worker session exists, in both `ownHandoffWasTaken` and `recoverFromBfcache`); regression test as in the issue.
- #163 (`gh issue view 163`): pass `allReTagged` from `SelectStep` to `ScrobbleConfirmDialog` and report it; regression test as in the issue.
- Commit per issue (`Fixes #166`, `Fixes #163`).

### Task 5: Docs

`AGENTS.md`: the status page on Home (states, sources, polling incl. the dormant re-check, dismissed jobs, the `/scrobble` redirect, take-back intent and explainer events), `dormant_from`/`dormantFrom` and reconnect-resumes, the #167 lookup rule, removal of the `/scrobble` job banner (and any text describing it, e.g. "The job card refreshes itself"). Also (#173 and its review): the redirect hands Home the job it found (`statusHandover` in the store, used if under 30 s old) and a refused worker sign-in's notice; Home's unanswered job lookup with a worker session shows `status.checking` and asks again with /scrobble's 8 s budget; an `exporting` job is re-checked every 30 s, and a take-back that failed in this tab records its claim (sessionStorage `scrobblify.background.failedTakeBack`, 15 min) so the status page can offer "Scrobble the rest locally" again and the retry presents the claim the worker still holds. Spec section 6: an "As built (Plan 4)" note for the move to Home. Strings file: any new or changed strings in an "Added in Plan 4 (drafts)" section. This plan: an "As built" section. Commit `Docs: the status page`.

### Task 6: Verify

- `cd worker; npm test`; both Playwright suites; `npm run lint:check`; `npm run build`.
- Real browser on `$env:PORT=8662; npm run dev:mock:bg`: every status row (drive states with `POST /mock/worker/scrobblify/__mock/job`), the header "Scrobble" link landing on Home, move back signed in and signed out, cancel, finished job → new import.
- Before/after screenshots (master vs branch) of every changed screen.
