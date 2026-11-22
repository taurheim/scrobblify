# Guided home, part 3: the server choice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Beta users choose "Let Scrobblify scrobble for me" right in the "Scrobble N tracks?" dialog, signing in to the worker's Last.fm application only (no browser sign-in), with an over-60-days warning and a higher job limit; "Already scrobbling on scrobblify?" becomes a worker sign-in.

**Architecture:** The worker learns to take a handoff and a sign-in **without a username**: preflight reserves a slot with no owner, and the Last.fm callback adopts the username `auth.getSession` returns (checking the per-user live slot then), returning it to the browser in the redirect. The client gets a `ServerChoice` component shown inside `ScrobbleConfirmDialog` (entry point `confirm`) and inside a slimmed `BackgroundOffer` dialog (mid-run, resume). Choosing the server saves the selection and runs the existing `startBackgroundHandoff` with whatever username the browser knows, possibly none.

**Tech Stack:** Vue 3 + Vuetify 3 (Options API), TypeScript, Playwright; Cloudflare Worker + D1 (worker tests are Node scripts run by `worker/scripts/run-tests.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-20-guided-home-and-background-design.md` sections 4.1, 4.4, 5, 7.1. Copy: `docs/superpowers/specs/2026-11-20-guided-home-strings.md` (`choice.*`, `signin.nothing.*`, `scrobble.savedHint.background`) — use it verbatim.

**Out of scope (Plan 4):** the status page, `dormant_from`, reconnect-resumes-to-active, dormant re-check, move-back explainer. "Already scrobbling" with a job lands on today's job banner on `/scrobble`.

## Ground rules for every task

- Read `AGENTS.md` first. Never use port 8080: run Playwright as `$env:PORT=8644; npx playwright test …` in the same command. The worker-configured suite: `npx playwright test -c playwright.unreachable-worker.config.ts` (its own server on 8471). Worker tests: `cd worker; npm test`.
- Never commit `package-lock.json`. Commit trailer: `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- Lint with `npm run lint:check` (0 errors). Bugs found outside the task: file a GitHub issue (see AGENTS.md), don't fix.

## File map

| File | Change |
| --- | --- |
| `worker/src/api.ts` | preflight and `/auth/signin` accept no username; callback adds `user=` to the fragment |
| `worker/src/handoff.ts` | `handleCallback` adopts the username for an anonymous handoff; `already_live` at callback; `MAX_TRACKS_PER_JOB` raised |
| `worker/src/store.ts` | `reserveSlot` reserves an anonymous handoff (no live-username check, `live_username` NULL) |
| `worker/src/chunks.ts` | comment on the measured size |
| `worker/test/handoff.test.ts`, `worker/test/api.test.ts`, `worker/test/jobsize.test.ts` (new) | tests |
| `src/services/BackgroundScrobbling.ts` | `preflight`/`startReauth` with `''`; fragment readers return `user` |
| `src/components/ServerChoice.vue` (new) | the choice content |
| `src/components/BackgroundOffer.vue` | rewritten as a dialog around `ServerChoice` |
| `src/components/ScrobbleConfirmDialog.vue` | shows `ServerChoice` when offered; emits `server` |
| `src/components/SelectStep.vue` | passes `hasReTagged`, forwards `server` |
| `src/components/ScrobbleStep.vue` | mid-run link replaces the "Finish this in the background" alert |
| `src/components/Scrobblify.vue` | server path from confirm; remember the worker's username; `already_live` notice; "Nothing to resume" banner |
| `src/views/Home.vue` | "Already scrobbling?" → worker sign-in |
| `tests/backgroundMock.js`, `vue.config.js` | anonymous preflight/sign-in, `user` and `fail` in the shim |
| `tests/unreachable-worker/unreachable-worker.spec.ts` | client tests (this build has a worker URL) |
| `AGENTS.md`, spec, strings | docs |

---

### Task 1: Worker — a handoff without a username

**Files:**
- Modify: `worker/src/store.ts` (`reserveSlot`, ~line 729)
- Modify: `worker/src/handoff.ts` (`preflight`, `CallbackResult`, `handleCallback`)
- Modify: `worker/src/api.ts` (preflight route ~line 386; callback success redirect ~line 535)
- Test: `worker/test/handoff.test.ts`, `worker/test/api.test.ts`

Behaviour:
- `POST /scrobblify/handoff/preflight` accepts a body with `username` absent, or `''`. A present non-string `username` is still `bad_request`. An anonymous preflight reserves a capacity slot exactly like a named one but skips the per-user `already_live` check and stores `username = ''`, `live_username = NULL` (the unique index allows many NULLs).
- `handleCallback` on an anonymous handoff: after `getSession`, normalise the returned name; if a live job or another live handoff holds that name (`SELECT 1 … FROM jobs WHERE live_username = ? UNION ALL SELECT 1 … FROM handoffs WHERE live_username = ? LIMIT 1`), `failHandoff(sql, id, 'already_live', nowSec)` and return `{ ok: false, reason: 'already_live' }` (the key is discarded, as on a mismatch). Otherwise `UPDATE handoffs SET username = ?, live_username = ? WHERE id = ? AND state = 'exchanging' AND username = ''` — if it throws (unique index race) treat as `already_live`; if `changes === 0` return `bad_state`. Then continue exactly as today, using the adopted name for the job row.
- A named handoff keeps the existing mismatch check, unchanged.
- `CallbackResult` success gains `username: string` (Last.fm's spelling from `getSession`; on the replay/`alreadyDone` paths use the row's `username`). The failure union gains `'already_live'`.
- The callback redirect on success adds `&user=<encodeURIComponent(username)>` to the fragment (after `session` and `handoff`). On `already_live` the existing failure redirect (`?handoff=failed&reason=already_live`) applies; no session is issued (the browser can't prove it started this flow, so it signs in separately — Task 7).

- [ ] **Step 1: Write the failing tests.** In `worker/test/handoff.test.ts`, following the file's existing `check(...)` style and its fake client (whose `getSession` returns a fixed `{ sessionKey, username }`):
  - anonymous preflight succeeds and the handoff row has `username = ''`, `live_username IS NULL`;
  - two anonymous preflights both succeed (no uniqueness clash between them);
  - anonymous preflight still fails `at_capacity` when slots are full;
  - callback on an anonymous handoff: handoff row now has the Last.fm username in `username` and `live_username`, the job row has it in `username`/`live_username`, result `ok` with `username`;
  - callback on an anonymous handoff when that user already has a live job: result `already_live`, handoff `failed`, no job row created for it, no credential stored;
  - a named handoff with a mismatching Last.fm user still fails `username_mismatch`.
  In `worker/test/api.test.ts`: preflight with no `username` field → 200 `ok`; with `username: 42` → 400; the callback redirect `Location` fragment contains `user=` with the Last.fm name.
- [ ] **Step 2: Run** `cd worker; npm test` — the new checks fail.
- [ ] **Step 3: Implement** as described. In `reserveSlot`:

```ts
  const anonymous = handoff.username === '';
  if (!anonymous) {
    // existing live / liveJob checks, unchanged
  }
  // …capacity check unchanged…
  // INSERT: live_username param becomes `anonymous ? null : handoff.username`
```

  In `api.ts` preflight:

```ts
    if (!body || (body.username !== undefined && typeof body.username !== 'string')
      || typeof body.payloadDigest !== 'string') {
      return json(env, { ok: false, reason: 'bad_request' }, 400);
    }
    // …
        username: typeof body.username === 'string' ? body.username : '',
```

  Add a comment at the adoption in `handleCallback` explaining why the per-user check moves to the callback for an anonymous handoff (the browser had no username to commit to; the Last.fm answer is the only identity there is).
- [ ] **Step 4: Run** `cd worker; npm test` — all pass, typecheck included.
- [ ] **Step 5: Commit** `Worker: accept a handoff without a username, adopting it at the callback`.

### Task 2: Worker — a sign-in without a username

**Files:**
- Modify: `worker/src/api.ts` (`/scrobblify/auth/signin` ~line 435; callback sign-in branch ~line 456)
- Test: `worker/test/api.test.ts`

Behaviour:
- `POST /scrobblify/auth/signin` accepts `username` absent or blank (anonymous). Nonce rules unchanged. A present non-string `username` is `bad_request`. Anonymous signs state with `u: ''`.
- Callback sign-in branch: `if (signinState.u && normalizeUsername(identity.username) !== signinState.u)` → failed (named sign-ins keep their check). Anonymous adopts `identity.username`. `issueSession` and `reattachCredential` get the adopted, normalised name.
- The success fragment becomes `session=…&nonce=…&user=<encodeURIComponent(identity.username)>`.
- Update the comment above the route: an anonymous sign-in is bound to its browser by the nonce, so issuing a session for whoever authorised gives that person only their own job.

- [ ] **Step 1: Failing tests** in `worker/test/api.test.ts`: signin with no username → 200 with `authoriseUrl`; callback for that state with the stub's `getSession` user → 302 with `signin=ok` and a fragment containing `user=`; the issued session authorises `GET /scrobblify/job` for that user; a named signin whose Last.fm user differs still redirects `signin=failed`; `username: 7` → 400.
- [ ] **Step 2: Run** `cd worker; npm test` — fail.
- [ ] **Step 3: Implement.** Check `verifyHandoffState` (or whatever parses the signed state) doesn't reject an empty `u`; if it does, allow `''` only for `k: 'signin'`.
- [ ] **Step 4: Run** `cd worker; npm test` — pass.
- [ ] **Step 5: Commit** `Worker: accept a sign-in without a username`.

### Task 3: Worker — measure and raise `MAX_TRACKS_PER_JOB`

**Files:**
- Create: `worker/test/jobsize.test.ts` (register it wherever `worker/scripts/run-tests.mjs` lists tests, if it lists them)
- Modify: `worker/src/handoff.ts` (`MAX_TRACKS_PER_JOB`), `worker/src/chunks.ts` (comment on `MAX_JOB_COMPRESSED_BYTES`), `tests/backgroundMock.js` (`MAX_TRACKS`)

The limit must be **measured**, worst case: every play distinct. Build plays with the client's chunk format (copy `encodeChunk` from `src/services/BackgroundScrobbling.ts`: one `JSON.stringify({ artist, track, album, originalTimestampSec, reTagged })` per line, `\n`-joined), chunked by `CHUNK_TRACKS`, each chunk gzipped (`zlib.gzipSync`, level default — matches `CompressionStream('gzip')` closely; note any difference in the comment). Worst-case generator, deterministic (seeded PRNG): artist 24, track 40, album 40 random characters from `[a-z0-9 ]`; `originalTimestampSec` increasing by a random 120–400 s; `reTagged: true` on all.

- [ ] **Step 1:** Write `jobsize.test.ts` with a helper `compressedBytes(n)` (sum of gzipped chunk sizes for `n` plays) and checks:
  - `compressedBytes(MAX_TRACKS_PER_JOB) <= MAX_JOB_COMPRESSED_BYTES * 0.9` (10% headroom for gzip implementation differences);
  - preflight (via `handoff.preflight` with a stub control row, as `handoff.test.ts` does) accepts `trackCount = MAX_TRACKS_PER_JOB` and rejects `MAX_TRACKS_PER_JOB + 1` with `too_large`.
  Also print `compressedBytes` per 1,000 plays so the measurement is visible in the test output.
- [ ] **Step 2:** Run it against the current 42,000; it passes (it is the old limit). Find the largest multiple of 1,000 for which the first check still holds (a one-off loop in the test file is fine; remove the loop afterwards).
- [ ] **Step 3:** Set `MAX_TRACKS_PER_JOB` to that number as a literal with a comment giving the measurement (bytes, date, generator) and why it is not `TRACKS_PER_DAY * 60` any more (jobs longer than 60 days re-authenticate; the client warns with `choice.over60`). Update the `chunks.ts` comment's "measured at about 5 MB" sentence to the new figure. Set `MAX_TRACKS` in `tests/backgroundMock.js` to the same number.
- [ ] **Step 4:** `cd worker; npm test` passes.
- [ ] **Step 5: Commit** `Worker: raise the job limit to the measured storage bound`.

### Task 4: Client API and mock worker — no username

**Files:**
- Modify: `src/services/BackgroundScrobbling.ts` (`preflight` ~2371, `startReauth` ~2683, `consumeRedirectFragment` ~2636, `consumeReauthFragment` ~2715)
- Modify: `src/services/BackgroundHandoff.ts` (`beginHandoff` must not refuse `username === ''`; check)
- Modify: `tests/backgroundMock.js`, `vue.config.js` (shim callers)

Behaviour:
- `preflight(username, …)` sends `username` only when non-empty (omit the field otherwise). `startReauth(username)` likewise.
- `consumeRedirectFragment()` returns `{ session, handoffId, user }` (`user` = fragment `user` or `''`). `consumeReauthFragment()` returns `{ user: string } | null` instead of a boolean (truthy on success, so existing `if (reauthed)` callers keep working; update its type and callers).
- Mock worker (`createMockWorker`): option `username` (default `'testuser'`, the Last.fm mock's user). `handlePreflight` with an empty `username`: if a job is live, return `ok` with `authoriseUrl: ${appOrigin}/mock-auth?fail=already_live` (the real worker only finds out at the callback); otherwise record the handoff with the adopted name and add `&user=<name>` to the shim URL. Signin with an empty `username` adds `&user=<name>` too. `shimHtml(session, handoffId, user = '', fail = '')`: with `user`, also `localStorage.setItem('scrobblifyLfmUserName', user)`; with `fail`, skip storage and `location.replace('/?handoff=failed&reason=' + fail + '#/scrobble')`. Update both callers (the Playwright route in `interceptBackgroundWorker` and the dev middleware in `vue.config.js`) to pass `user` and `fail` from the shim URL's query.

- [ ] **Step 1:** Make the changes; `npx vue-cli-service lint --no-fix` on the touched files; `npm run build` compiles (type errors fail it).
- [ ] **Step 2:** Run the worker-configured suite `npx playwright test -c playwright.unreachable-worker.config.ts` — still 28/28 (nothing user-visible changed yet).
- [ ] **Step 3: Commit** `Client: preflight and worker sign-in without a username`.

### Task 5: `ServerChoice` and the slimmed `BackgroundOffer`

**Files:**
- Create: `src/components/ServerChoice.vue`
- Modify: `src/components/BackgroundOffer.vue`, `src/components/ScrobbleStep.vue` (lines ~66–98), `src/components/Scrobblify.vue` (`onBackgroundRequested`, resume offer, `backgroundAllReTagged` → `backgroundAnyReTagged`)
- Test: `tests/unreachable-worker/unreachable-worker.spec.ts`

`ServerChoice.vue` (content only, no dialog):

```vue
<template>
  <div class="server-choice">
    <p class="choice-lede">
      This will take {{ days.toLocaleString() }} days to scrobble. Scrobblify can now do it for you,
      or you can do it yourself by returning each day to scrobble.
    </p>
    <p v-if="showDateNote" class="choice-dates">
      Plays older than 2 weeks <strong>will not have the correct date</strong> and instead show the
      date of whenever they got scrobbled.
    </p>
    <v-alert v-if="over60" type="warning" variant="tonal" density="compact" class="choice-over60 mb-3">
      That's more than 60 days of scrobbling, so you'll need to come back after 60 days and sign in
      again to finish.
    </v-alert>
    <v-btn color="primary" size="large" block :loading="busy" @click="$emit('server')">
      Let Scrobblify scrobble for me
    </v-btn>
    <div class="choice-fine text-body-medium mt-2">
      You'll need to sign in
      <a role="button" tabindex="0" @click="details = !details" @keydown.enter="details = !details">Details</a>
    </div>
    <div v-if="details" class="choice-details text-body-medium mt-2">
      <p>Only your username and tracks listened to are uploaded, nothing else. Once the scrobbling
        is done, your tracks are removed from the service.</p>
      <p>You can stop the import at any time by returning here, or by
        <a href="https://www.last.fm/settings/applications" target="_blank" rel="noopener">revoking access</a>
        in last.fm</p>
      <p class="mb-0">This is in BETA. See anything weird? Email me at
        <a href="mailto:niko@savas.ca?subject=Scrobblify%20background%20scrobbling">niko@savas.ca</a></p>
    </div>
    <div class="choice-tab text-center mt-4">
      or <a role="button" tabindex="0" :aria-disabled="busy" @click="local" @keydown.enter="local">scrobble locally</a>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { importBudget } from '@/shared/lastfm/dailyCap';

/** The worker's pace, and the figure its job card divides by (`describeJob`). */
const DAILY_LIMIT = importBudget(0);
/** The worker's Last.fm key lasts 60 days; longer jobs need a second sign-in. */
const CREDENTIAL_DAYS = 60;

export default defineComponent({
  name: 'ServerChoice',
  props: {
    count: { type: Number, required: true },
    /** Some of these plays were moved to today ("Scrobble tracks older than 2 weeks"). */
    showDateNote: { type: Boolean, default: false },
    busy: { type: Boolean, default: false },
  },
  emits: ['server', 'local'],
  data() {
    return { details: false };
  },
  computed: {
    days(): number { return Math.max(1, Math.ceil(this.count / DAILY_LIMIT)); },
    over60(): boolean { return this.days > CREDENTIAL_DAYS; },
  },
  methods: {
    local() {
      if (!this.busy) { this.$emit('local'); }
    },
  },
});
</script>
```

`BackgroundOffer.vue` becomes:

```vue
<template>
  <v-dialog v-model="visible" max-width="520" scrollable>
    <v-card class="background-offer">
      <v-card-title>{{ remaining.toLocaleString() }} plays</v-card-title>
      <v-card-text class="pt-2">
        <server-choice :count="remaining" :show-date-note="anyReTagged" :busy="busy"
          @server="$emit('accept')" @local="decline" />
      </v-card-text>
    </v-card>
  </v-dialog>
</template>
```

with props `modelValue`, `remaining`, `anyReTagged` (replaces `allReTagged`), `busy`; emits unchanged (`update:modelValue`, `accept`, `decline`); `decline()` closes and emits `decline` as today.

In `Scrobblify.vue` wherever the offer is opened (`onBackgroundRequested`, and the resume entry point — find it via `pendingEntryPoint = 'resume'`): compute `backgroundAnyReTagged` from the remaining upload list (`uploadListFromState(state, nowSec).some((t) => t.reTagged)`), and pass `:any-re-tagged`. Keep `all_re_tagged` in `background_offer_declined` (compute it from the same list with `every`) so the event is unchanged.

`ScrobbleStep.vue` stopped panel: replace the `v-alert v-if="canOfferBackground"` block with

```vue
      <div v-if="canOfferBackground" class="mb-4 text-center">
        <v-btn color="primary" variant="text" :disabled="handoffHalted" @click="requestBackground">
          Scrobble the rest for me →
        </v-btn>
      </div>
```

and the auto-saved line: when `canOfferBackground`, show `Stopped. You can resume at any time, or <a …@click="requestBackground">have scrobblify scrobble the rest for you</a>.` (`scrobble.savedHint.background`); otherwise keep today's text. Leave `backgroundHint()` as it is.

#149 (dead "Finish this in the background" button while a job is listed): read the issue. If the new link would show in that situation, make `canOfferBackground` false there too (the parent already refuses in `onBackgroundRequested` when `backgroundJob` is set — pass that down or zero `backgroundAvailable` while a job is listed), add a test, and mention `Fixes #149` in the commit. If #149's cause is elsewhere, leave it.

- [ ] **Step 1: Tests first** in `tests/unreachable-worker/unreachable-worker.spec.ts` (it builds with a worker URL; follow `openUploadStep`, `WILLING_WORKER`, `OFFER`). Update every existing assertion on the old offer copy ("Finish this in the background", "Continue to Last.fm", "Not now", "What you're agreeing to") to the new copy. Add: the mid-run link reads "Scrobble the rest for me" and opens a dialog titled "{n} plays" with "Let Scrobblify scrobble for me"; "Details" expands the three paragraphs; "scrobble locally" closes it and emits `background_offer_declined` (use the suite's console-event capture, `captureEvents`, if present; else the `[scrobblify:event]` console echo).
- [ ] **Step 2:** Run the suite — new tests fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Suite passes; `$env:PORT=8644; npx playwright test -g "Scrobble Step|Session Resume"` (default config) still passes.
- [ ] **Step 5: Commit** `Server choice: one component for the offer, simpler copy`.

### Task 6: The choice in the confirm dialog

**Files:**
- Modify: `src/components/ScrobbleConfirmDialog.vue`, `src/components/SelectStep.vue`, `src/components/Scrobblify.vue` (`onSelectionComplete`, handoff return)
- Test: `tests/unreachable-worker/unreachable-worker.spec.ts`

Dialog:
- New prop `hasReTagged: Boolean` (SelectStep passes `reTagged > 0`, which it already computes in the confirm handler; store it in data). New emit `server`.
- `showServerChoice` computed: `backgroundTrackLimit > 0 && trackCount >= LASTFM_DAILY_CAP && trackCount <= backgroundTrackLimit`. (`backgroundTrackLimit` is already 0 unless beta, the server has room, no job is listed and the browser can compress.)
- Internal `stage: 'saved' | 'choice' | 'plain'`, set when the dialog opens (watch `modelValue`): `savedProgress` → `'saved'`; else `showServerChoice` → `'choice'`; else `'plain'`.
  - `'saved'`: today's saved-progress warning and buttons; **Start over** moves to `'choice'` when `showServerChoice`, else emits `confirm` as today.
  - `'choice'`: title `{trackCount} plays`, body `<server-choice :count="trackCount" :show-date-note="hasReTagged">`, no estimate paragraph, actions: Cancel only. `server` → close, emit `server`. `local` → close, emit `confirm`, and `trackEvent('background_offer_declined', { entry_point: 'confirm', track_count: trackCount, all_re_tagged: false })`. Entering `'choice'` emits `trackEvent('background_offer_shown', { entry_point: 'confirm', track_count: trackCount, offer_source: backgroundOfferSource() })`.
  - `'plain'`: today's content, unchanged (the "Finish this in the background" sentences in the estimate stay; they only render when `backgroundCanFinish`, which can't hold here when the choice would have shown — check, and if it can, drop those sentences in favour of the choice).
- SelectStep: `@server="scrobbleSelectedTracks('server')"`; `scrobbleSelectedTracks(path: 'tab' | 'server' = 'tab')` adds `path` to `tracks_selected` and emits `complete` with `path`. (Vue passes the event payload to a handler bound without arguments — bind `@confirm="scrobbleSelectedTracks('tab')"` explicitly.)

Scrobblify `onSelectionComplete(path: 'tab' | 'server' = 'tab')`:
- Extract the signed-out block's "refuse while `sendingBlocked`" + "#102 disk check" + "build and persist the 0-progress state" into `async saveSelectionBeforeLeaving(): Promise<ScrobbleState | null>` (null = refused or failed, having already shown the message). The signed-out tab path uses it and then calls `startSignIn` as today.
- `path === 'server'` (signed in or not): `const state = await this.saveSelectionBeforeLeaving(); if (!state) return;` then set `pendingState = state`, `pendingSnapshot = null`, `pendingEntryPoint = 'confirm'`, `backgroundRemaining = state.tracks.length`, `backgroundAnyReTagged = state.tracks.some((t) => t.reTagged)`, `hasResumableState = false`, and `await this.startBackgroundHandoff()`. It takes the username from `lfmApi.getUserName() || state.userName || ''` — empty for a browser that never signed in, which is now allowed. On failure it shows its notice and the selection stays saved (the resume prompt offers it).
- Handoff return (`resumeHandoffIfReturning` / wherever `consumeRedirectFragment` is called): if the fragment carried `user` and `lfmApi.getUserName()` is empty, `api.setUserName(user)` (persists `scrobblifyLfmUserName`; no session key, so the browser stays signed out of the browser app) and `identifyUser(user)`. `completeHandoff` records `handedOverImport` with `state.userName || <that user>` — pass it in or read it after setting. Without it Home can't show "Scrobbling to {user}".
- `?handoff=failed&reason=already_live`: `backgroundNotice = 'You already have an import running on Scrobblify.'` with the re-auth button labelled `Sign in to see it` (add a label override alongside `reauthFixNow`); its click is the existing `reauthenticate`, which must now work with no username (calls `startReauth('')`). The selection stays saved.

- [ ] **Step 1: Tests first** (worker-configured suite). Generate a zip of ≥ 750 plays with the suite's zip helpers (find `makeZip`/`play` or the equivalent; plays dated within the last week so no checkbox is needed, or tick "Scrobble tracks older than 2 weeks" and assert the date note).
  1. Beta, signed out, 800 plays → "Scrobble N selected tracks" → dialog title "800 plays", "Let Scrobblify scrobble for me" → click → shim → back on `/scrobble` with the job banner; `localStorage.scrobblifyLfmUserName === 'testuser'`; `scrobblifyLfmAuthKey` absent; no `track.scrobble` request was made; `handedOverImport` names `testuser`.
  2. Same but "scrobble locally" → Last.fm browser sign-in (route with `routeLastFmSignIn`) → back on Send with 800 tracks ready.
  3. Not offered: 700 plays (plain dialog), non-beta (`?beta=0`), capacity full (`WILLING_WORKER` with `available: false`).
  4. Saved progress first: seed saved progress, select 800 → saved-progress buttons → "Start over" → the choice.
  5. Signed in (mock auth) → server choice → handoff preflight carries `username: testuser` (assert on the request body).
  6. Anonymous handoff while a job is live (seed the mock's job) → back with "You already have an import running on Scrobblify." and a "Sign in to see it" button.
  7. Over 60 days: resume a seeded saved state of 43,000 remaining tracks (beta, signed in) → resume offer shows the over-60 warning; with 41,000 it doesn't. (The mock's `MAX_TRACKS` from Task 3 must exceed 43,000.)
- [ ] **Step 2:** Run — fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Worker-configured suite passes; default suite `$env:PORT=8644; npx playwright test` passes (confirm-dialog tests there run without a worker URL, so the plain stage must be unchanged).
- [ ] **Step 5: Commit** `Confirm dialog: choose the server before signing in`.

### Task 7: "Already scrobbling on scrobblify?" signs in to the worker

**Files:**
- Modify: `src/views/Home.vue` (`go('resume')` signed-out branch, ~line 162)
- Modify: `src/components/Scrobblify.vue` (mounted, `banner`, template)
- Test: `tests/unreachable-worker/unreachable-worker.spec.ts`

Behaviour:
- Home, signed out, `isBackgroundConfigured()`: `sessionStorage.setItem('scrobblify.background.lookup', '1')`, `const url = await startReauth('')`; with a URL, `trackEvent('worker_lookup_started')` and `window.location.href = url`. Without one (unreachable), remove the flag and fall back to today's `startSignIn(api, { kind: 'reconnect' })`. Not configured: today's behaviour.
- Scrobblify mounted: after the worker session and the saved-state exposure have settled (after `refreshBackgroundJob` and `exposeSavedStateUnlessStale`), take the flag (`getItem` then `removeItem`). If set: if the re-auth fragment or the mock shim gave a username and `lfmApi.getUserName()` is empty, `setUserName` + `identifyUser` (same helper as Task 6). Then: `backgroundJob` → nothing more (the job banner shows), `trackEvent('worker_lookup_result', { result: 'job' })`; `hasResumableState` → `result: 'saved'` (the resume prompt shows); otherwise `nothingToResume = true`, `result: 'nothing'`. If there is no worker session at all (sign-in failed), `result: 'failed'` and leave the existing "Signing in to the background service didn't work" notice.
- New banner kind `'nothing'`, after `retry` and before `resume` in `banner`: `type="info"`, prominent:

```vue
      <template v-else-if="banner === 'nothing'">
        <div><strong>Nothing to resume</strong></div>
        <div class="mt-1">Scrobblify isn't scrobbling anything for you, and this browser has no saved progress.</div>
        <div class="mt-2">
          <v-btn color="primary" @click="nothingToResume = false">Upload Spotify zip</v-btn>
        </div>
        <div class="mt-2">Have a progress file?
          <a role="button" tabindex="0" @click="importStateFile" @keydown.enter="importStateFile">Upload it here</a>.
        </div>
      </template>
```

  Move the hidden `<input ref="importFileInput">` out of the `resume` template to just after the `v-alert`, so both banners can open it. `nothingToResume` clears when the user leaves step 2 or a file is imported.

- [ ] **Step 1: Tests first** (worker-configured suite): fresh browser, beta not required, Home → "Re-connect to last.fm" → shim → `/scrobble`: (a) mock has a live job for `testuser` → job banner, username remembered; (b) no job, nothing saved → "Nothing to resume", "Upload Spotify zip" dismisses it and the upload step is there; "Upload it here" opens a file chooser (`page.waitForEvent('filechooser')`); (c) worker unreachable for `/auth/signin` → falls back to the Last.fm browser sign-in (assert navigation to the Last.fm authorize URL via `routeLastFmSignIn` or a request listener).
- [ ] **Step 2:** Run — fail. **Step 3:** Implement. **Step 4:** Both suites pass.
- [ ] **Step 5: Commit** `Already scrobbling: sign in to the worker, and say when there's nothing to resume`.

### Task 8: Docs

**Files:** `AGENTS.md`, the spec, the strings file.

- [ ] `AGENTS.md`: in "Background scrobbling beta gate" / handoff docs, describe the anonymous handoff and sign-in (username adopted at the callback, `already_live` at the callback, `user=` in the fragment, the browser remembering the name without a session key); the confirm-dialog choice (`entry_point: confirm`, `tracks_selected.path`); `worker_lookup_started` / `worker_lookup_result` in the funnel events; the new job limit; the over-60 warning. Correct the "Signing in after choosing" section's table: "Already scrobbling" is a worker sign-in when the worker is configured.
- [ ] Spec: in 4.1 / 4.4 / 5 replace the "For now (Plan 2)" notes with "As built (Plan 3)" notes, including: the duplicate check is **not** run on the server path for a signed-out user (the queue is committed at preflight, before the username is known; re-dated plays, the bulk of a server-sized import, are exempt from the check anyway).
- [ ] Strings file: add under "Added in Plan 3 (drafts)": `notice.alreadyLive` "You already have an import running on Scrobblify.", `notice.alreadyLive.button` "Sign in to see it".
- [ ] Commit `Docs: the server choice and worker-only sign-in`.

### Task 9: Verify

- [ ] `cd worker; npm test`; `$env:PORT=8644; npx playwright test`; `npx playwright test -c playwright.unreachable-worker.config.ts`; `npm run lint:check`; `npm run build`.
- [ ] Real browser (Orca) against `$env:PORT=8650; npm run dev:mock:bg`: signed-out beta user, 800-play zip → choice → server → job banner, Home shows "Scrobbling to testuser"; "scrobble locally"; Already-scrobbling with and without a job.
- [ ] Before/after screenshots of every changed screen (confirm dialog small/beta/over-60/details, mid-run link, offer dialog, nothing-to-resume, already-live notice) for the user.
