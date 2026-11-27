<template>
  <div>
    <!-- Pre-scrobble view -->
    <div v-if="!scrobbling">
      <p>
        {{ tracksToScrobble.length }} tracks ready to scrobble.
        Please review them and then click Scrobble to begin.
      </p>
      <p v-if="isResumed" class="overall-progress">
        Resuming: {{ previouslyScrobbled }} of {{ originalTotalTracks }} already scrobbled in
        earlier sessions.
      </p>
      <div class="final-list">
        <span v-for="(track, i) in tracksToScrobble" :key="i">
          {{ track.track }} - {{ track.artist }} @ {{ track.timestamp.toString() }}<br>
        </span>
      </div>
      <v-btn color="primary" @click="scrobble">Scrobble</v-btn>
    </div>

    <!-- Scrobbling view (active, not paused) -->
    <div v-else-if="!paused && !completed">
      <p>Scrobbling... <b>{{ currentTrackName }}</b></p>
      <v-progress-linear :model-value="progress" class="mb-4"></v-progress-linear>

      <!--
        Preventive pacing is normal operation, not an interruption: it stays put
        for the whole throttled stretch rather than flipping the view into the
        paused panel once per track.
      -->
      <v-alert v-if="pacing" type="info" density="compact" variant="tonal" class="mb-4">
        {{ pacingNotice }}
      </v-alert>

      <v-card class="pa-3 mb-4" variant="outlined">
        <div class="overall-progress">
          Overall: {{ totalSucceeded }} of {{ originalTotalTracks }} scrobbled
        </div>
        <div v-if="pending.length > 0">
          <template v-if="libraryUnreadable">
            {{ pending.length }} more sent, but {{ libraryUnreadableNote }}
          </template>
          <template v-else>{{ pending.length }} more sent, being checked on Last.fm</template>
        </div>
        <div>
          This session: {{ scrobbledTracks }} of {{ tracksToScrobble.length }}
          ({{ failedTracks.length }} failed)
        </div>
        <div>Recent: {{ burstCount }} / {{ burstLimit }} in the last 10 minutes</div>
        <div v-if="storedToday !== null">Today on Last.fm (UTC): {{ storedToday }} / {{ dailyCap }}</div>
      </v-card>

      <v-alert
        v-if="saveFailed"
        type="warning"
        variant="tonal"
        density="compact"
        class="mb-4 text-left save-failed"
      >
        Scrobblify couldn't save your progress in this browser. If you close this page,
        plays sent since the last save will be sent again. Press "Pause &amp; Save", then
        "Download progress file", to keep it.
      </v-alert>

      <v-btn variant="outlined" @click="manualPause">Pause &amp; Save</v-btn>
    </div>

    <!-- Paused view -->
    <div v-else-if="paused">
      <!--
        Not while held back by a worker that couldn't be reached: the parent's
        banner explains that, and "Checking…" would read as stuck.
      -->
      <v-alert v-if="!(blockedByAuthority && workerUnreachable)" :type="pauseAlertType" prominent>
        {{ pauseReason }}
      </v-alert>

      <!--
        This is where the offer belongs. Telemetry says this screen is where
        large imports are abandoned: the user has been told to come back in a
        day, and most never do.
      -->
      <div v-if="canOfferBackground" class="mb-4 text-center">
        <v-btn color="primary" variant="text" :disabled="handoffHalted" @click="requestBackground">
          Scrobble the rest for me →
        </v-btn>
      </div>

      <v-card class="pa-4 mb-4 text-center" variant="outlined">
        <div v-if="countdown > 0" class="text-headline-small mb-2">
          Auto-resuming in {{ formattedCountdown }}
        </div>
        <div v-if="countdown > 0" class="mb-2 text-body-medium">
          You can save progress and leave now, then resume later at any time.
        </div>
        <div v-if="canResume && autoSaved && canOfferBackground" class="mb-2 text-body-medium">
          Stopped. You can resume at any time, or
          <a
            role="button"
            tabindex="0"
            @click="requestBackground"
            @keydown.enter="requestBackground"
            @keydown.space.prevent="requestBackground"
          >have
            scrobblify scrobble the rest for you</a>.
        </div>
        <div v-else-if="canResume && autoSaved" class="mb-2 text-body-medium">
          Your progress has been saved automatically — just come back to this page later
          and choose "Resume".
        </div>
        <v-alert
          v-else-if="saveFailed"
          type="warning"
          variant="tonal"
          density="compact"
          class="mb-2 text-left save-failed"
        >
          Scrobblify couldn't save your progress in this browser. Press
          "Save Progress &amp; Leave" to download it as a file before you close this page.
        </v-alert>
        <div class="mb-3 overall-progress">
          {{ totalSucceeded }} of {{ originalTotalTracks }} completed so far
          <span v-if="pending.length > 0" class="font-weight-regular">
            <template v-if="libraryUnreadable">
              ({{ pending.length }} more sent, but {{ libraryUnreadableNote }})
            </template>
            <template v-else>({{ pending.length }} more sent, checked on Last.fm when you resume)</template>
          </span>
        </div>

        <v-btn color="primary" class="mr-2" @click="saveAndExit">Save Progress &amp; Leave</v-btn>
        <!--
          Anything terminal needs a way back in. Without this a manual pause was
          a dead end: a disabled button waiting on an auto-resume that the loop
          had already returned from. A rejected session key is the exception:
          retrying with it can only fail again, so the way back is signing in.
        -->
        <v-btn v-if="sessionInvalid" color="primary" :href="authorizeUrl">
          Sign in to Last.fm again
        </v-btn>
        <!--
          The loop finishes the send it is waiting on before it stops, and
          `scrobble()` ignores a click until then. An enabled button here
          swallowed that click and left the run paused (#123).
        -->
        <v-btn v-else-if="canResume && loopActive" variant="outlined" disabled>
          {{ manuallyPaused ? 'Pausing…' : 'Stopping…' }}
        </v-btn>
        <v-btn v-else-if="canResume" variant="outlined" :disabled="handoffHalted" @click="scrobble">
          {{ manuallyPaused ? 'Resume Now' : 'Try Again Now' }}
        </v-btn>
        <v-btn v-else variant="outlined" disabled>Wait Here</v-btn>
        <div v-if="canResume && !loopActive && !leaving" class="mt-2">
          <v-btn variant="text" size="small" @click="downloadProgress">Download progress file</v-btn>
        </div>
      </v-card>
    </div>

    <!-- Completed view -->
    <div v-else-if="completed">
      <v-alert type="success">
        Scrobbling complete!
        <span class="overall-progress">
          {{ totalSucceeded }} of {{ originalTotalTracks }} tracks scrobbled.
        </span>
      </v-alert>
      <!--
        Only plays read back from the user's library are counted. When the
        library can't be read (network, private profile), say so rather than
        quietly counting what Last.fm merely accepted.
      -->
      <v-alert v-if="pending.length > 0" type="warning" variant="tonal" class="mt-2">
        <template v-if="libraryUnreadable">
          {{ pending.length }} more were sent, but {{ libraryUnreadableNote }}. They aren't counted above.
        </template>
        <template v-else>
          {{ pending.length }} more were sent, but Scrobblify couldn't read your Last.fm library to
          confirm them, so they aren't counted above.
        </template>
      </v-alert>
    </div>

    <!-- Failed tracks section -->
    <v-expansion-panels v-if="reportedFailures.length > 0" class="mt-4">
      <v-expansion-panel>
        <v-expansion-panel-title>
          {{ reportedFailures.length }} failed track(s)
        </v-expansion-panel-title>
        <v-expansion-panel-text>
          <div v-for="(item, i) in reportedFailures" :key="i" class="mb-1">
            <strong>{{ item.name }}</strong> — {{ item.error }}
          </div>
          <div v-if="carriedFailuresDropped > 0" class="mt-2">
            …and {{ carriedFailuresDropped }} more that couldn't be listed here.
          </div>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <error-dialog v-model="showError" :message="errorMessage" :details="errorDetails"></error-dialog>
  </div>
</template>
<style>
.final-list {
  text-align: left;
  margin-top: 20px;
}
.overall-progress {
  font-weight: 500;
}
</style>
<script lang="ts">
import { defineComponent } from 'vue';
import Scrobble, { PendingScrobble } from '@/models/Scrobble';
import LastFm from '@/api/LastFm';
import ErrorDialog from '@/components/ErrorDialog.vue';
import { trackEvent, trackError } from '@/services/Analytics';
import RateLimitTracker from '@/services/RateLimitTracker';
import {
  LASTFM_DAILY_CAP,
  OWN_LISTENING_HEADROOM,
  importBudget,
  nextUtcDayStartSec,
  utcDayStartSec,
} from '@/shared/lastfm/dailyCap';
import { canCompress } from '@/services/BackgroundScrobbling';
import * as background from '@/services/BackgroundScrobbling';
import StateManager from '@/services/StateManager';
import { formatDuration } from '@/services/ScrobbleEstimate';

/**
 * One day's worth of scrobbles: below this, finishing in the browser takes
 * about a day and the extra moving parts of a handoff are not worth it. Must
 * match the worker's `MIN_TRACKS_FOR_BACKGROUND`, which rejects a smaller
 * preflight outright.
 */
const MIN_TRACKS_FOR_BACKGROUND = LASTFM_DAILY_CAP;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/*
  Shown when this browser can't store what a backdated send needs. Says
  nothing about whether progress was saved: the panel reports that from the
  actual outcome of the save, and the usual cause of this stop is the same
  storage refusal that would make a save fail too.
*/
const STORAGE_STOP_REASON = 'Scrobblify couldn\'t store data in this browser, and it needs to before it sends plays older than two weeks. It has stopped so they don\'t get scrobbled twice. Private browsing or strict cookie settings usually cause this. Allow this site to store data, then press "Try Again Now".';

// Escalating backoff between retries of a rate-limited track.
//
// The old behaviour was a flat 1-minute retry, forever. Across 2,135 observed
// rate limits it produced only 33 recoveries, and where recovery did happen the
// median elapsed time was 130 minutes — i.e. it effectively never worked, it
// just kept the user staring at a countdown. Two users sat through 200+
// consecutive retries.
const RATE_LIMIT_BACKOFF_MS = [
  5 * MS_PER_MINUTE,
  15 * MS_PER_MINUTE,
  30 * MS_PER_MINUTE,
];

// After the ladder above is exhausted (~50 minutes) we stop retrying, save the
// user's progress and tell them to come back later. Nobody watches a browser
// tab for two hours; an honest "come back later" beats an infinite countdown.
const MAX_RATE_LIMIT_RETRIES = RATE_LIMIT_BACKOFF_MS.length;

const NETWORK_ERROR_COOLDOWN_MS = 30 * MS_PER_SECOND;
const NETWORK_ERROR_COOLDOWN_SECONDS = Math.ceil(NETWORK_ERROR_COOLDOWN_MS / MS_PER_SECOND);

// Preventive pacing waits shorter than this are ordinary throughput control,
// not something to interrupt the user with.
//
// `msUntilBurstSafe()` frees exactly one slot at a time, so once the rolling
// window is saturated *every* remaining track waits a fraction of a second
// (observed median: 630ms). Treating each of those as a pause flipped the whole
// view into the paused panel and emitted a `scrobble_paused` event once per
// track — roughly one analytics event per scrobble. Above this threshold the
// wait is long enough to be worth an explicit countdown, which happens when a
// window saturated by an earlier session has to drain before we can start.
const PACING_COUNTDOWN_THRESHOLD_MS = 10 * MS_PER_SECOND;
const MANUAL_PAUSE_REASON = 'Paused. Resume whenever you like.';

// How many consecutive tracks must need *no* wait before a pacing stretch is
// considered over.
//
// A saturated rolling window frees exactly one slot at a time and the loop
// consumes it immediately, so `msUntilBurstSafe()` alternates between a small
// positive wait and zero on every single track. Ending the stretch on the first
// zero therefore ended it once per track: telemetry showed a median
// `paced_tracks` of 1 with waits of 4-40ms, i.e. two events per track rather
// than one per stretch. At saturation two zero-wait tracks in a row are
// impossible, so requiring a short streak keeps one continuous stretch, while
// still exiting promptly when the window genuinely clears or the adaptive
// burst limit is raised and frees a block of slots at once.
const PACING_EXIT_CLEAR_TRACKS = 3;

const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * How long a tab refused the send lock waits before trying again.
 *
 * The wait resolves on its own — the winner finishes, or is closed and the
 * browser releases its lock — so there is nothing for the user to press. Short
 * enough that closing the other tab feels immediate, long enough to be free:
 * `ifAvailable` makes a failed attempt a synchronous "no" rather than a queued
 * request, so this never accumulates waiters behind a loop that may run for
 * weeks.
 */
const SEND_LOCK_RETRY_MS = 5 * MS_PER_SECOND;

// Progress used to be saved only when a run stopped for good or the user
// clicked a save button, so closing or reloading the tab mid-run lost
// everything since. The resume then re-sent those tracks: telemetry showed 42%
// of resuming users going *backwards* in completion, replaying a median of 340
// tracks each — burning daily budget and, for re-tagged plays (which get a
// fresh timestamp on every send), creating duplicate scrobbles. A checkpoint
// every this-many tracks bounds that loss. Countdown waits checkpoint too,
// since that is exactly where users walk away.
const CHECKPOINT_EVERY_TRACKS = 25;

// Plays are confirmed by reading the user's library back, because Last.fm
// answers plays over its daily cap as accepted and keeps none of them (see
// shared/lastfm/dailyCap.ts). A play missing from the first read is re-checked once after this
// long before it is called lost, in case Last.fm lists it a moment late.
const VERIFY_RECHECK_MS = 5 * MS_PER_SECOND;

// Unconfirmed plays are read back one UTC day at a time, over just the span
// they cover that day, rather than in one range spanning all of them: plays
// dated in the last 14 days keep their real timestamps, and a single range from
// those to today's re-tagged ones could cover a fortnight of the user's
// library. A day holds at most LASTFM_DAILY_CAP plays, so each range fits in
// one page.

// Re-tagged plays (see Scrobble.reTagged) are stamped at send time, starting
// this far back and stepping forward one second per scrobble. Last.fm rejects
// timestamps in the future and anything older than 14 days.
//
// Outside a reserved range the cursor also never goes back past today's UTC
// midnight. Last.fm's daily cap is per UTC day of the *timestamp*, so this keeps
// a whole run inside the one day whose budget it checked.
const RETAG_BACKFILL_SECONDS = 6 * 60 * 60;

// Just after UTC midnight the floor above leaves less room than there are
// sends, so the cursor can overtake the clock by a few seconds. A gap this
// small is waited out; a larger one means the clock moved backwards, and the
// run stops instead (see `retag_no_second`).
const RETAG_CLOCK_WAIT_MAX_SECONDS = 60;

/**
 * Outer bound on how far back a re-tagged scrobble may be placed, matching the
 * worker's `WINDOW_SECONDS`. Only consulted for a *reserved* range handed over
 * by a background job, since the ordinary six-hour window is always well
 * inside it.
 */
const RETAG_WINDOW_LIMIT_SECONDS = 13 * 86400;

// Last.fm ignoredMessage code 5: the account is out of scrobbles for the day.
// Retrying is pointless until tomorrow.
const IGNORE_CODE_DAILY_LIMIT = 5;

/*
  Last.fm ignoredMessage codes 3 and 4: the second we chose was outside the
  window it accepts.

  Unlike every other rejection these are answers about *our* arithmetic rather
  than about the track, and they are the one rejection that can be trusted to
  mean nothing was stored *this time*. Whether something was stored under that
  second earlier is a different question, and the answer decides what happens
  next: a second this loop just minted can be replaced for free, while an
  inherited one may already carry a play and must not be re-timed.
*/
const IGNORE_CODE_TIMESTAMP_TOO_OLD = 3;
const IGNORE_CODE_TIMESTAMP_TOO_NEW = 4;

export default defineComponent({
  components: { 'error-dialog': ErrorDialog },
  props: {
    /**
     * Largest queue the server would take now (its `maxTracks`), or 0 when the
     * parent hasn't confirmed that background mode is live and accepting jobs.
     * Defaults to 0 so the offer stays hidden unless something has positively
     * established otherwise.
     */
    backgroundTrackLimit: {
      type: Number,
      default: 0,
    },
    /**
     * Set while this browser has not established that it owns the queue.
     *
     * Covers a known remote owner *and* an unresolved one. The parent gates
     * its Resume alert on the same thing, but a fresh import walks into this
     * step through the Upload and Select handlers without passing that alert,
     * so the refusal has to live where the sending does.
     */
    sendingBlocked: {
      type: Boolean,
      default: false,
    },
    /**
     * Set once the parent has failed to reach the background worker, and held
     * across its retries. Its own banner explains the block then.
     */
    workerUnreachable: {
      type: Boolean,
      default: false,
    },
    /**
     * Awaitable durable save, used where an emit is not enough.
     *
     * `$emit` hands the parent a snapshot and returns immediately, so a loop
     * that saved and then returned had no idea whether the write had landed.
     * That was fine while nothing raced it, but the send lock is released when
     * the loop returns — and a freezing tab that acquires it then re-reads
     * IndexedDB would see progress from before the save and hand those tracks
     * to the worker to send again.
     */
    persistProgress: {
      type: Function,
      default: null,
    },
    /**
     * Durable save that refuses to move progress backwards, for halts.
     *
     * A halt is the one moment several tabs persist at once, and a plain `put`
     * is last-writer-wins — the slowest tab's snapshot lands last and erases
     * the furthest progress, which the freezing tab then uploads and the
     * worker scrobbles a second time. Distinct from `persistProgress`, which
     * is used where this tab is the only writer and a monotonic guard would
     * silently discard a legitimately shorter queue.
     *
     * Unlike `persistProgress` this one **rejects** when the write fails.
     * Reporting a halt as safely persisted when it was not is precisely how a
     * freeze reads stale progress.
     */
    persistProgressIfAhead: {
      type: Function,
      default: null,
    },
    /**
     * Awaitable mid-run checkpoint save. Rejects when the write fails or times
     * out, which is how the loop learns that its progress is not landing: the
     * `checkpoint` emit confirms nothing, and a run that could not save used to
     * carry on with no word to the user (#144).
     */
    persistCheckpoint: {
      type: Function,
      default: null,
    },
  },
  emits: ['complete', 'auto-save', 'save-and-exit', 'download-progress', 'checkpoint', 'background'],
  data() {
    return {
      scrobbling: false,
      currentTrackName: '',
      // Tracks *processed* this session (successes + permanent failures). Also
      // the loop index / resume point, so it must count both.
      scrobbledTracks: 0,
      // Plays read back from the user's Last.fm library this session. Only
      // these count as scrobbled: an `accepted` reply is not proof of storage.
      confirmedTracks: 0,
      // Plays Last.fm accepted and then did not keep.
      droppedTracks: 0,
      // Sent and accepted, not yet seen in the library.
      pending: [] as PendingScrobble[],
      // Scrobbles Last.fm holds per UTC day (keyed by the day's start, in unix
      // seconds), counting this run's sends since the last read.
      dayStored: {} as Record<number, number>,
      verifyErrorReported: false,
      // Last.fm refused to read the library back (error 17) this run. Not a
      // blip, so the plays are no longer described as "being checked" and are
      // not read again until the next run.
      libraryUnreadable: false,
      // High-water mark of the send-time timestamp allocator for re-tagged
      // plays. Persisted so a resume cannot reuse an earlier run's seconds.
      reTagCursorSec: 0,
      // Synthetic second already given to the track at the head of the queue,
      // while its outcome is unknown. Persisted with progress so a resume
      // retries the identical tuple rather than minting a phantom play.
      pendingReTagSec: 0,
      paused: false,
      // True only while the send loop is actually executing. `scrobbling`
      // stays set across a pause so the paused view keeps rendering, so it
      // cannot tell a handoff whether the loop has really stopped.
      loopActive: false,
      // Set while a background handoff is being negotiated, so the paused view
      // explains itself instead of offering a "Resume" that would race it.
      handoffHalted: false,
      // Set when a halt could not durably persist. `haltForHandoff` reports
      // "not stopped" while it holds, so a freeze refuses rather than
      // uploading a queue whose latest sends never reached disk.
      persistFailed: false,
      /*
        Progress exists in memory that no confirmed write has captured.

        `persistFailed` records that one attempt failed; this records that the
        *queue on disk is behind*, which is the condition that actually
        matters and which outlives any single attempt. Without it a second
        handoff attempt finds the loop already stopped, answers "yes, safe",
        and lets the freezing tab upload the stale queue it read back — every
        track sent since the last good save going out a second time.
      */
      progressDirty: false,
      // Pending re-attempt of the send lock, while another tab holds it.
      sendLockRetryTimer: null as number | null,
      // Set when `scrobble()` refused because ownership was unresolved. The
      // watcher below uses it to retry once it resolves, so a transient
      // outage costs a pause rather than a dead end.
      blockedByAuthority: false,
      // A pause the loop will not resume from on its own. Distinguishes "wait a
      // moment" from "we've given up for now, come back later".
      stopped: false,
      // A terminal pause the *user* asked for. Terminal like `stopped`, but not
      // an error, so it gets its own flag rather than colouring a deliberate
      // action as a failure.
      manuallyPaused: false,
      // Set by "Save Progress & Leave". The loop must return rather than carry
      // on once its countdown ends: the save has already been taken, so every
      // track sent after it would be re-sent by the next resume.
      leaving: false,
      // Last.fm rejected the stored session key (error 9). Terminal, and the
      // only way forward is a fresh sign-in, so it replaces the retry button.
      sessionInvalid: false,
      // A save this browser confirmed. Never set on the strength of an attempt:
      // it is what tells the user they can safely close the page.
      autoSaved: false,
      // The latest save was attempted and did not land.
      saveFailed: false,
      // Why a storage write the run depended on failed, for telemetry.
      storageFailure: '',
      tracksSinceCheckpoint: 0,
      // Counts checkpoints issued, so only the newest one's outcome is shown.
      checkpointSeq: 0,
      pauseReason: '',
      countdown: 0,
      countdownTimer: null as number | null,
      /**
       * Settles the promise `pauseWithCountdown` returned, so that cancelling a
       * countdown from outside releases the loop rather than stranding it.
       */
      countdownResolve: null as (() => void) | null,
      // Preventive pacing is a *stretch* of throttled sends, not a single
      // pause: it is entered once when the rolling window fills and left once
      // the window has room again. Telemetry and UI both describe the stretch,
      // so neither fires per track.
      pacing: false,
      pacingStartedAtMs: 0,
      pacedTracks: 0,
      pacedWaitMs: 0,
      // Consecutive tracks that needed no pacing wait. See
      // PACING_EXIT_CLEAR_TRACKS — a single free slot does not end a stretch.
      unpacedStreak: 0,
      // Mirrors of RateLimitTracker state. The tracker itself is deliberately
      // non-reactive (see created()), so these are refreshed explicitly.
      burstCount: 0,
      dailyCount: 0,
      burstLimit: 0,
      dailyCap: LASTFM_DAILY_CAP,
      rateLimitPauseCount: 0,
      firstRateLimitAtMs: null as number | null,
      failedTracks: [] as Array<{ track: Scrobble; error: string }>,
      completed: false,
      showError: false,
      errorMessage: '',
      errorDetails: '',
    };
  },
  watch: {
    /*
      Ownership resolved after a send was refused for not knowing it. The user
      asked to scrobble and never withdrew that; re-entering here is what turns
      a worker blip into a pause instead of a dead end.

      Only when it resolves *favourably*, and only if the halt has not since
      been taken by something with a better claim.
    */
    sendingBlocked(blocked: boolean) {
      if (blocked || !this.blockedByAuthority) {
        return;
      }
      this.blockedByAuthority = false;
      if (this.handoffHalted || this.loopActive || this.manuallyPaused) {
        return;
      }
      this.scrobble();
    },
    runActive(active: boolean) {
      this.$store.commit('setScrobbleRunActive', active);
    },
  },
  computed: {
    tracksToScrobble(): Scrobble[] {
      return this.$store.state.selectedScrobbles;
    },
    /**
     * Tracks completed in an earlier session that is being resumed. The store
     * only ever holds the *remaining* tracks, so this is the only signal that
     * distinguishes a resume from a fresh start.
     */
    previouslyScrobbled(): number {
      return this.$store.state.resumedScrobbleCount || 0;
    },
    isResumed(): boolean {
      return this.previouslyScrobbled > 0;
    },
    /**
     * Every failure this import has accumulated, not just this session's.
     *
     * Display only — the counters and analytics stay on `failedTracks`, which
     * measures what *this* browser did. The carried half names tracks the
     * background worker wrote off; they are not in the queue and no index
     * describes them, so if this list does not show them nothing does.
     */
    reportedFailures(): Array<{ name: string; error: string }> {
      const carried = (this.$store.state.carriedFailures as Array<{
        artist: string; track: string; reason: string;
      }>) || [];
      return [
        ...carried.map((f) => ({
          name: f.artist ? `${f.track} - ${f.artist}` : f.track,
          error: f.reason,
        })),
        ...this.failedTracks.map((f) => ({
          name: f.track.toString(),
          error: f.error,
        })),
      ];
    },
    /**
     * How many carried failures could not be kept, so an incomplete list can
     * say so rather than reading as exhaustive.
     */
    carriedFailuresDropped(): number {
      return this.$store.state.carriedFailuresDropped || 0;
    },
    /**
     * Size of the whole import. `tracksToScrobble.length` shrinks every time a
     * session is saved and resumed, so it is useless as a completion
     * denominator — this does not shrink.
     */
    originalTotalTracks(): number {
      return this.$store.state.originalTotalTracks || this.tracksToScrobble.length;
    },
    /** Successful scrobbles across every session of this import. */
    totalSucceeded(): number {
      return this.previouslyScrobbled + this.confirmedTracks;
    },
    storedToday(): number | null {
      const today = utcDayStartSec(Math.floor(Date.now() / MS_PER_SECOND));
      return today in this.dayStored ? this.dayStored[today] : null;
    },
    progress(): number {
      return (100 * this.scrobbledTracks) / this.tracksToScrobble.length;
    },
    formattedCountdown(): string {
      const minutes = Math.floor(this.countdown / 60);
      const seconds = this.countdown % 60;
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    },
    pacingNotice(): string {
      return `Pacing to stay under Last.fm's rate limit — ${this.burstCount} scrobbles in the`
        + ' last 10 minutes. Scrobbling continues automatically.';
    },
    authorizeUrl(): string {
      return (this.$store.state.lfmApi as LastFm).getAuthorizeUrl();
    },

    /*
      Whether the loop has returned for good and the user must restart it. Both
      giving up on an error and pausing on purpose qualify; only the transient
      waits (which clear `paused` themselves) do not.
    */
    canResume(): boolean {
      // `leaving` only lingers on this step if the save itself failed, and the
      // loop has already returned, so the user needs the way back in too.
      return this.stopped || this.manuallyPaused || this.leaving;
    },

    // A deliberate pause is not a failure, so it must not be styled as one.
    pauseAlertType(): string {
      if (this.manuallyPaused) {
        return 'info';
      }
      return this.stopped ? 'error' : 'warning';
    },

    libraryUnreadableNote(): string {
      return 'Last.fm won\'t let Scrobblify read your recent listening to confirm them'
        + ' (this happens when it is hidden in your Last.fm privacy settings)';
    },

    /** Tracks in this session that have not been processed yet. */
    tracksRemaining(): number {
      return Math.max(0, this.tracksToScrobble.length - this.scrobbledTracks);
    },

    /**
     * Whether to advertise background mode on the paused screen.
     *
     * `backgroundTrackLimit` is the parent's live answer from the server, so an
     * undeployed or full worker never advertises itself, and a queue over its
     * limit (which the worker refuses as `too_large`) gets no button the
     * parent would then ignore. `canCompress` is checked here too because the
     * upload needs it, and discovering that after a redirect through Last.fm
     * would strand the user.
     */
    canOfferBackground(): boolean {
      return this.backgroundTrackLimit > 0
        && !this.handoffHalted
        && canCompress()
        && this.tracksRemaining >= MIN_TRACKS_FOR_BACKGROUND
        && this.tracksRemaining <= this.backgroundTrackLimit;
    },

    // Transient countdowns count as running: the loop resumes by itself.
    runActive(): boolean {
      return this.scrobbling && !this.completed && !this.canResume;
    },
  },
  created() {
    this.syncRateLimitCounters();
  },
  beforeUnmount() {
    this.$store.commit('setScrobbleRunActive', false);
    // Routed through `cancelCountdown` so an unmount mid-countdown also settles
    // the promise the loop is awaiting, rather than leaving it pending forever.
    this.cancelCountdown();
    if (this.sendLockRetryTimer !== null) {
      window.clearTimeout(this.sendLockRetryTimer);
      this.sendLockRetryTimer = null;
    }
  },
  methods: {
    /**
     * The rolling-window rate-limit tracker, created lazily and cached
     * off-reactivity (assigned straight onto the instance, outside data()). It is
     * keyed by Last.fm username, which is not reliably known until the user
     * actually reaches this step.
     */
    rateLimitTracker(): RateLimitTracker {
      const api = this.$store.state.lfmApi as LastFm;
      const userName = api.getUserName();
      const self = this as any;
      if (!self._rateLimitTracker || self._rateLimitTrackerUser !== userName) {
        self._rateLimitTracker = new RateLimitTracker(userName);
        self._rateLimitTrackerUser = userName;
      }
      return self._rateLimitTracker as RateLimitTracker;
    },

    syncRateLimitCounters() {
      const tracker = this.rateLimitTracker();
      this.burstCount = tracker.burstCount;
      this.dailyCount = tracker.dailyCount;
      this.burstLimit = tracker.burstLimit;
    },

    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => { window.setTimeout(resolve, ms); });
    },

    /**
     * Report that the run has ended and will not pick itself back up.
     *
     * Kept as its own event rather than another `scrobble_paused` reason: every
     * terminal case used to share the event name with the transient ones, so
     * answering "how often does a run stop early, and why" meant knowing by
     * heart which of the seven reasons happen to be terminal. `scrobble_paused`
     * now always means "waiting, will resume itself"; this always means "over
     * until the user comes back".
     *
     * `auto_saved` records whether their progress actually survived, which is
     * the difference between an interruption and lost work.
     */
    trackStopped(reason: string, extra: Record<string, unknown> = {}) {
      this.endPacing();
      trackEvent('scrobble_stopped', this.progressProps({
        reason,
        auto_saved: this.autoSaved,
        ...extra,
      }));
    },

    /**
     * Enter the paced state, reporting it once. Repeated calls while already
     * pacing are deliberately no-ops: the burst check runs per track, but a
     * pacing stretch is one event, not one per track.
     */
    beginPacing(tracker: RateLimitTracker, waitMs: number) {
      if (this.pacing) {
        return;
      }
      this.pacing = true;
      this.pacingStartedAtMs = Date.now();
      this.pacedTracks = 0;
      this.pacedWaitMs = 0;
      trackEvent('scrobble_paused', this.progressProps({
        reason: 'burst_limit',
        burst_count: tracker.burstCount,
        burst_limit: tracker.burstLimit,
        wait_ms: waitMs,
      }));
    },

    /**
     * Leave the paced state, reporting how much the pacing actually cost. Safe
     * to call unconditionally — it is a no-op when we were not pacing.
     */
    endPacing() {
      this.unpacedStreak = 0;
      if (!this.pacing) {
        return;
      }
      const { pacedTracks, pacedWaitMs } = this;
      this.pacing = false;
      trackEvent('scrobble_pacing_ended', this.progressProps({
        reason: 'burst_limit',
        paced_tracks: pacedTracks,
        paced_wait_ms: pacedWaitMs,
        pacing_duration_ms: Date.now() - this.pacingStartedAtMs,
      }));
    },

    /**
     * Progress properties attached to every scrobble analytics event.
     *
     * The session-scoped fields (`scrobbled_tracks` / `total_tracks`) only
     * describe the current chunk of work: after a resume the store holds just
     * the remaining tracks, so `total_tracks` shrinks and a percentage built
     * from those two is measured against a moving denominator. The
     * `original_*` / `total_succeeded` fields are stable across resumes and are
     * what completion rate should be computed from.
     */
    progressProps(extra: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        scrobbled_tracks: this.scrobbledTracks,
        total_tracks: this.tracksToScrobble.length,
        succeeded_tracks: this.confirmedTracks,
        failed_tracks: this.failedTracks.length,
        unconfirmed_tracks: this.pending.length,
        library_unreadable: this.libraryUnreadable,
        not_stored_tracks: this.droppedTracks,
        is_resumed: this.isResumed,
        previously_scrobbled: this.previouslyScrobbled,
        original_total_tracks: this.originalTotalTracks,
        total_succeeded: this.totalSucceeded,
        completion_pct: this.originalTotalTracks
          ? Math.round((1000 * this.totalSucceeded) / this.originalTotalTracks) / 10
          : 0,
        ...extra,
      };
    },

    /**
     * Scrobbles Last.fm holds for the UTC day starting at `daySec`, read once per
     * day and then kept current by `recordStored` and checkpoint refreshes.
     */
    async storedOn(api: LastFm, tracker: RateLimitTracker, daySec: number): Promise<number> {
      if (!(daySec in this.dayStored)) {
        await this.refreshStored(api, tracker, daySec);
      }
      return this.dayStored[daySec];
    },

    async refreshStored(api: LastFm, tracker: RateLimitTracker, daySec: number) {
      let stored: number | null = null;
      if (!this.libraryUnreadable) {
        try {
          stored = await api.countStoredScrobbles(daySec, nextUtcDayStartSec(daySec) - 1);
        } catch (e) {
          this.noteReadFailure(e);
        }
      }
      if (stored === null) {
        // The library can't be read (network, private profile). Fall back to
        // what this browser itself sent that day, which misses the user's own
        // listening but is the best floor available.
        stored = Math.max(
          this.dayStored[daySec] || 0,
          tracker.countSince(daySec * MS_PER_SECOND),
        );
      }
      this.dayStored = { ...this.dayStored, [daySec]: stored };
    },

    recordStored(daySec: number) {
      this.dayStored = { ...this.dayStored, [daySec]: (this.dayStored[daySec] || 0) + 1 };
    },

    /*
      Error 17 even though reads are signed with the session key (#137): Last.fm
      will not show this library to us, and asking again won't change that.
    */
    noteReadFailure(e: unknown) {
      if (LastFm.isLoginRequiredError(e)) {
        this.libraryUnreadable = true;
      }
    },

    /**
     * The plays in `items` that are not in the user's library at the timestamp
     * they were sent with.
     *
     * Matched on timestamp alone. Last.fm can rewrite the artist or track name
     * it stores (autocorrection), so a name match would call a stored play lost
     * and re-send it as a duplicate. A re-tagged play owns its second; the only
     * way to be fooled is the user's own play landing on that exact second.
     */
    async unconfirmed(api: LastFm, items: PendingScrobble[]): Promise<PendingScrobble[]> {
      const spans = new Map<number, { from: number; to: number }>();
      for (const { timestampSec } of items) {
        const day = utcDayStartSec(timestampSec);
        const span = spans.get(day);
        if (span) {
          span.from = Math.min(span.from, timestampSec);
          span.to = Math.max(span.to, timestampSec);
        } else {
          spans.set(day, { from: timestampSec, to: timestampSec });
        }
      }
      const stored = new Map<number, number>();
      for (const { from, to } of Array.from(spans.values())) {
        // Widened by a second each side: Last.fm doesn't document whether
        // `from`/`to` are inclusive.
        const plays = await api.getAllScrobblesInRange(
          new Date((from - 1) * MS_PER_SECOND),
          new Date((to + 1) * MS_PER_SECOND),
        );
        for (const play of plays) {
          const sec = Math.floor(play.timestamp.getTime() / MS_PER_SECOND);
          stored.set(sec, (stored.get(sec) || 0) + 1);
        }
      }
      return items.filter((p) => {
        const count = stored.get(p.timestampSec) || 0;
        if (count > 0) {
          stored.set(p.timestampSec, count - 1);
          return false;
        }
        return true;
      });
    },

    /**
     * Read every unconfirmed play back from the user's library. Found ones count
     * as scrobbled. Lost re-tagged ones go back on the end of the queue — they
     * were never stored, so re-sending (with a fresh timestamp) cannot duplicate
     * them. A lost play with its real date can never fit into that day again,
     * so it is recorded as failed.
     *
     * If the library can't be read, everything stays unconfirmed and is checked
     * again at the next opportunity, including after a resume. Unless Last.fm
     * refused outright (`libraryUnreadable`): then not until the next run.
     *
     * Returns true when a lost play was dated today or later: the day's cap is
     * full, and the run must stop rather than keep sending into it.
     */
    async verifyPending(api: LastFm): Promise<boolean> {
      if (this.pending.length === 0 || this.libraryUnreadable) {
        return false;
      }
      const batch = this.pending.slice();
      let missing: PendingScrobble[];
      try {
        missing = await this.unconfirmed(api, batch);
        if (missing.length > 0) {
          await this.sleep(VERIFY_RECHECK_MS);
          missing = await this.unconfirmed(api, missing);
        }
      } catch (e) {
        this.noteReadFailure(e);
        if (!this.verifyErrorReported) {
          this.verifyErrorReported = true;
          const message = (e instanceof Error && e.message) || String(e);
          trackEvent('scrobble_verify_failed', this.progressProps({
            // The request echo carries the username, which split one cause
            // into a group per user.
            message: message.replace(/\. Request: [\s\S]*$/, ''),
          }));
        }
        return false;
      }

      const confirmed = batch.length - missing.length;
      this.confirmedTracks += confirmed;
      this.$store.commit('trackScrobbled', confirmed);

      // Missing from the library is only proof of loss when that day is at
      // Last.fm's cap. Otherwise the listing may simply be lagging, and
      // re-sending a re-tagged play (with a fresh timestamp) that was in fact
      // stored would create a duplicate. Those stay unconfirmed and are read
      // again at the next check.
      const missingDays = Array.from(new Set(missing.map((p) => utcDayStartSec(p.timestampSec))));
      const tracker = this.rateLimitTracker();
      for (const daySec of missingDays) {
        await this.refreshStored(api, tracker, daySec);
      }
      const lost = missing.filter((p) => this.dayStored[utcDayStartSec(p.timestampSec)] >= LASTFM_DAILY_CAP);
      const lagging = missing.filter((p) => !lost.includes(p));
      // The loop is awaiting this, so nothing was added to `pending` meanwhile.
      this.pending.splice(0, batch.length, ...lagging);
      if (lost.length === 0) {
        return false;
      }

      const todaySec = utcDayStartSec(Math.floor(Date.now() / MS_PER_SECOND));
      let todayFull = false;
      let reTagged = 0;
      for (const play of lost) {
        if (utcDayStartSec(play.timestampSec) >= todaySec) {
          todayFull = true;
        }
        if (play.scrobble.reTagged) {
          reTagged += 1;
          this.$store.commit('requeueScrobble', play.scrobble);
        } else {
          this.$store.commit('trackFailed');
          this.failedTracks.push({
            track: play.scrobble,
            error: `Last.fm accepted this play but did not keep it: it already holds its maximum of ${LASTFM_DAILY_CAP} scrobbles for that day.`,
          });
        }
      }
      this.droppedTracks += lost.length;
      trackEvent('scrobble_not_stored', this.progressProps({
        not_stored: lost.length,
        re_tagged_not_stored: reTagged,
        checked: batch.length,
      }));
      return todayFull;
    },

    dailyCapMessage(): string {
      const nowMs = Date.now();
      const resetMs = nextUtcDayStartSec(Math.floor(nowMs / MS_PER_SECOND)) * MS_PER_SECOND;
      const resetAt = new Date(resetMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return `Last.fm keeps at most ${LASTFM_DAILY_CAP} scrobbles a day, your own listening included,`
        + ` and silently throws away the rest. Scrobblify stops ${OWN_LISTENING_HEADROOM} short so your own`
        + ' plays today still count. The day resets at midnight UTC: come back after'
        + ` ${resetAt} (in ${formatDuration(resetMs - nowMs)}) to continue where you left off${this.backgroundHint()}.`;
    },

    /*
      The stop screen shows the background offer right under the reason, so a
      reason that only says "come back" would contradict it.
    */
    backgroundHint(): string {
      return this.canOfferBackground
        ? ', or hand the rest to Scrobblify\'s server below and skip the wait'
        : '';
    },

    /**
     * The import has used up its share of today's cap.
     *
     * What was sent is confirmed *before* the stop is shown, unlike other
     * stops (see `autoSave`): this is where a day's work ends, so the count the
     * user is left looking at should be the confirmed one, and no "Try Again"
     * exists yet to race the read.
     */
    async stopDailyLimit(tracker: RateLimitTracker, todaySec: number) {
      this.endPacing();
      await this.verifyPending(this.$store.state.lfmApi as LastFm);
      this.pauseReason = this.dailyCapMessage();
      this.stopped = true;
      this.paused = true;
      await this.autoSave();
      this.trackStopped('daily_limit', {
        stored_today: this.dayStored[todaySec],
        daily_count: tracker.dailyCount,
        wait_ms: nextUtcDayStartSec(todaySec) * MS_PER_SECOND - Date.now(),
      });
    },

    /** Last.fm stopped keeping today's plays before our budget said it would. */
    async stopNotStored() {
      this.endPacing();
      this.pauseReason = `Last.fm stopped keeping today's scrobbles, so ${this.droppedTracks} it accepted`
        + ' didn\'t make it into your library. They are not counted, and the ones re-dated to today'
        + ` are back in the queue. ${this.dailyCapMessage()}`;
      this.stopped = true;
      this.paused = true;
      await this.autoSave();
      this.trackStopped('not_stored');
    },

    async scrobble() {
      // Re-entry guard. "Resume Now" is a plain button, and a second click —
      // or a click racing a halt that has not finished unwinding — would start
      // a second loop over the same array. Both would send, and both would
      // write conflicting progress indices.
      if (this.loopActive) {
        return;
      }
      // A halt is in force; the handoff owns these tracks until it says
      // otherwise. The button is disabled too, but the guard is what matters.
      if (this.handoffHalted) {
        return;
      }
      /*
        Ownership is not this browser's to assume. Either a worker holds this
        user's queue, or we have not yet established that one does not — and
        sending under an active job produces duplicates Last.fm accepts
        silently, which is the one failure with no recovery.
      */
      if (this.sendingBlocked) {
        this.pauseReason = background.isBetaOptedIn()
          ? 'Checking whether your import is running in the background…'
          : 'Getting ready…';
        this.paused = true;
        this.scrobbling = true;
        // Remembered so the watcher can pick the attempt back up the moment
        // ownership resolves, rather than stranding the user at a panel whose
        // only exit is a reload.
        this.blockedByAuthority = true;
        return;
      }
      this.blockedByAuthority = false;
      const tracker = this.rateLimitTracker();
      // Defensive: a previous run that was torn down mid-stretch would
      // otherwise suppress the next `beginPacing`.
      this.endPacing();
      this.scrobbling = true;
      // Distinct from `scrobbling`, which stays true across a pause so the
      // paused view keeps rendering. This tracks whether the send loop is
      // actually executing, which is what a handoff has to wait for.
      this.loopActive = true;
      // Asked again each run: the user may have changed the setting since.
      this.libraryUnreadable = false;
      /*
        Held for the whole loop, including the gaps between tracks, so that a
        freezing tab's exclusive request cannot be granted while this tab still
        has a queue in hand. Taken here rather than around each send because
        "between tracks" is not safe either: progress lives in memory until a
        halt persists it.
      */
      const releaseSendLock = await background.acquireSendLock();
      if (!releaseSendLock) {
        /*
          Another tab is already sending this queue. Both would allocate
          synthetic seconds independently and collide, and Last.fm discards a
          repeat of (artist, track, timestamp) while reporting it accepted —
          so the plays would vanish with nothing to show for them.
        */
        this.pauseReason = 'Another Scrobblify tab is already scrobbling. Close it, or carry on there — running both would lose plays.';
        this.paused = true;
        this.scrobbling = true;
        this.loopActive = false;
        /*
          Retried rather than left as a dead end. The winning tab may simply be
          closed — the browser releases a Web Lock when its context dies, but
          nothing notifies the tab that was refused, so without this the user
          is left on a panel whose only exit is a reload. `ifAvailable` makes
          each retry free, so polling costs nothing while the winner runs.
        */
        this.scheduleSendLockRetry();
        return;
      }
      try {
        await this.runScrobbleLoop(tracker);
      } finally {
        this.loopActive = false;
        // Every exit path above persists before returning, so releasing here
        // does not expose unsaved progress. Unconditional: a lock this tab
        // never drops would block every future handoff in every tab.
        releaseSendLock();
      }
    },

    /**
     * Re-attempts the send lock after another tab held it.
     *
     * The refusal is not an error state and has no button, because the thing
     * to wait for resolves by itself: the winning tab finishes, or is closed
     * and the browser releases its lock. Cleared in `beforeUnmount` so a
     * navigating tab does not leave a timer re-entering a dead component.
     */
    scheduleSendLockRetry() {
      if (this.sendLockRetryTimer !== null) {
        return;
      }
      this.sendLockRetryTimer = window.setTimeout(() => {
        this.sendLockRetryTimer = null;
        // Anything that has since taken precedence wins: a halt, a queue the
        // server now owns, a user who stopped, or a loop already running.
        if (this.handoffHalted || this.loopActive || this.manuallyPaused
          || this.stopped || this.completed) {
          return;
        }
        this.scrobble();
      }, SEND_LOCK_RETRY_MS);
    },

    /**
     * A stable name for a track, used to bind a journalled second to the play
     * it was chosen for.
     *
     * Queue positions are not stable: they are relative to whatever remainder
     * was last saved, so the same index names a different track after a
     * reload. The parsed listen date is included because a history legitimately
     * contains the same song many times, and only one of those repeats is the
     * one a second was chosen for.
     */
    reTagTrackKey(track: Scrobble): string {
      return background.journalTrackKey(track.artist, track.track, track.timestamp.getTime());
    },

    /**
     * Records the second a send is about to ride on, in all three places that
     * outlive some part of this loop.
     *
     * The journal is written last and synchronously, because it is the only
     * one of the three that is durable at the instant the request leaves.
     * Returns whether that write can be relied on: the caller is about to
     * decide whether it is safe to send at all.
     */
    setPendingSecond(track: Scrobble, sec: number): boolean {
      this.pendingReTagSec = sec;
      this.$store.commit('setPendingReTagSec', sec);
      const write = background.recordInFlightSecond(
        (this.$store.state.importId as string) || '',
        this.reTagTrackKey(track),
        sec,
      );
      this.storageFailure = write.ok ? '' : write.failure;
      return write.ok;
    },

    /**
     * Forgets the pending second everywhere.
     *
     * Every one of these must be cleared together. The component copy is what
     * reaches the saved queue, the store copy is what a resumed loop reads
     * back, and the journal is what survives the tab. Leaving any of them
     * behind hands a used second to whichever track arrives at the head next,
     * and Last.fm answers a repeated (artist, track, timestamp) by discarding
     * it while reporting success.
     *
     * The journal is cleared only when it is this queue's and this track's.
     * It is one origin-global key describing one queue's send, so clearing it
     * blind would let this loop delete a second some other queue is riding on.
     */
    clearPendingSecond(track?: Scrobble) {
      this.pendingReTagSec = 0;
      this.$store.commit('setPendingReTagSec', 0);
      if (track) {
        background.clearInFlightSecond(
          (this.$store.state.importId as string) || '',
          this.reTagTrackKey(track),
        );
      }
    },

    /**
     * Makes sure this queue has a durable identity before anything is
     * journalled against it.
     *
     * Selection mints one, but a progress file written before identities
     * existed comes back without one — and the journal refuses to store an
     * empty id, because two id-less queues would match each other and could
     * trade seconds. Minting here is safe for exactly the reason it is safe in
     * `beginHandoff`: a queue that has no identity cannot have been handed
     * over, so a fresh one takes nothing away.
     *
     * Persisted before it is used. An id that exists only in memory is not an
     * identity a crash can be recovered against.
     */
    async ensureImportIdentity(): Promise<boolean> {
      if ((this.$store.state.importId as string) || '') { return true; }
      const minted = StateManager.newImportId();
      if (!minted) {
        this.storageFailure = 'no_random_source';
        return false;
      }
      this.$store.commit('setImportId', minted);
      /*
        `autoSave` is the wrong door here: it swallows a failed write, because
        nothing is normally waiting on one. Something is waiting on this one —
        an identity that exists only in memory is not an identity a crash can
        be recovered against, and journalling against it would produce records
        the reloaded queue can never claim.

        `persistProgressIfAhead` is also wrong: it can decline a write that is
        merely not ahead, and a decline is not a confirmation.
      */
      const persist = this.persistProgress;
      let written = false;
      if (persist) {
        try {
          await persist(this.progressSnapshot());
          written = true;
          this.autoSaved = true;
          this.saveFailed = false;
        } catch (e) {
          written = false;
          this.autoSaved = false;
          this.saveFailed = true;
          this.storageFailure = background.storageErrorName(e);
        }
      } else {
        this.storageFailure = 'no_persist_channel';
      }
      if (!written) {
        /*
          Rolled back, or the next attempt would find a non-empty id in memory
          and accept it without ever retrying the write — and every second
          journalled under it would name an import the disk has never heard of.
          A name only this tab knows is worse than no name: no name at least
          stops the run.
        */
        this.$store.commit('setImportId', '');
      }
      return written;
    },

    async runScrobbleLoop(tracker: RateLimitTracker) {
      this.completed = false;
      this.paused = false;
      this.stopped = false;
      this.manuallyPaused = false;
      this.leaving = false;
      this.sessionInvalid = false;
      this.autoSaved = false;
      this.saveFailed = false;
      this.checkpointSeq += 1;
      this.storageFailure = '';
      this.tracksSinceCheckpoint = 0;
      this.pauseReason = '';
      // A manual retry after giving up starts a fresh backoff ladder.
      this.rateLimitPauseCount = 0;
      this.firstRateLimitAtMs = null;
      // Re-read from Last.fm on every entry: the user may have listened, or a
      // new UTC day may have started, since the last run.
      this.dayStored = {};
      this.syncRateLimitCounters();

      const api = this.$store.state.lfmApi as LastFm;
      const tracks = this.tracksToScrobble;
      let consecutiveFailures = 0;
      // Re-based on every entry into the loop (including resumes and manual
      // retries), which is what keeps re-tagged plays inside Last.fm's 14-day
      // window however long a user leaves an import sitting.
      //
      // It must never step back onto a second an earlier run already used:
      // Last.fm silently discards a repeat of (artist, track, timestamp) while
      // still reporting it as accepted, so a collision would lose a play with
      // no error to detect. Hence the carried-forward high-water mark.
      let reTagCursorSec = Math.max(
        this.reTagCursorSec,
        (this.$store.state.reTagCursorSec as number) || 0,
        // Survives the import that produced it. Both of the sources above end
        // with the import — a completed run clears the saved state and a
        // reload starts the store at zero — so without this a second import
        // walks back over the seconds the first one used.
        background.persistedReTagCursorSec(),
      );
      /*
        Held across retries of the current track; cleared only once the track
        is finally consumed. Mirrored into `this.pendingReTagSec` so it lands
        in every snapshot — a halt can hand the queue away between a send and
        its outcome, and a retry that picks a *different* second turns a lost
        response into a phantom duplicate play. See the allocation site below.

        Seeded from a previous run only when the track it belongs to is still
        the one at the head of the queue and is still re-tagged. A saved second
        applied to some other track would be a fresh collision rather than the
        deduplication it exists to produce.
      */
      const savedPendingSec = (this.$store.state.pendingReTagSec as number) || 0;
      const headTrack = tracks[this.scrobbledTracks];
      // Plays a resumed session sent but never got to confirm. They sit inside
      // the completed range, so they are checked here rather than re-sent.
      const restored = this.$store.state.pendingVerification as PendingScrobble[];
      if (restored.length > 0) {
        this.pending.push(...restored);
        this.$store.commit('setPendingVerification', []);
      }
      /*
        A queue that will need substitute seconds needs a durable identity
        first, because that is what every journalled second is bound to. Done
        before the journal is even read: an id-less queue cannot match a record
        and cannot write one.

        Only when the remainder actually contains a re-tagged play — an import
        of recent listens never touches any of this, and should not be stopped
        by storage it does not use. A pending play counts: one found lost is
        re-queued.
      */
      const needsReTagSeconds = tracks.slice(this.scrobbledTracks).some((t) => t.reTagged)
        || this.pending.some((p) => p.scrobble.reTagged);
      /*
        Carried into the component field before anything persists, because the
        identity write below snapshots that field and would otherwise write a
        queue with no pending second at all — erasing the durable copy of a
        second a request may already be riding on, purely as a side effect of
        naming the queue. The adoption block just below decides whether the
        second is actually still this track's; that decision is allowed to drop
        it, this write is not.
      */
      this.pendingReTagSec = savedPendingSec;
      if (needsReTagSeconds && !await this.ensureImportIdentity()) {
        this.endPacing();
        this.stopped = true;
        this.paused = true;
        this.pauseReason = STORAGE_STOP_REASON;
        this.trackStopped('retag_identity_unavailable', { storage_failure: this.storageFailure });
        return;
      }
      /*
        The journal is consulted only when the queue has nothing to say.

        It records a second in the gap between choosing one and hearing an
        answer, which is exactly the interval the queue on disk cannot cover.
        A record that names a different import, or a different track, is
        another send's business and is left alone — applying a second to the
        wrong track is a fresh collision rather than the deduplication it
        exists to produce.
      */
      const journalled = background.inFlightSecond((this.$store.state.importId as string) || '');
      const journalledSec = (
        journalled
        && headTrack
        && journalled.trackKey === this.reTagTrackKey(headTrack)
      ) ? journalled.sec : 0;
      const inheritedSec = savedPendingSec || journalledSec;
      let pendingReTagTimestampSec: number | undefined = (
        inheritedSec > 0 && headTrack && headTrack.reTagged
      ) ? inheritedSec : undefined;
      if (pendingReTagTimestampSec) {
        // Re-asserted through the same door the allocator uses, so a second
        // that arrived by only one of the three routes is held by all of them
        // from here on.
        this.setPendingSecond(headTrack, pendingReTagTimestampSec);
      } else {
        this.pendingReTagSec = 0;
      }
      /*
        Whether the second currently pending is known never to have been
        stored by Last.fm.

        Only two things establish that: this loop minted it and has not yet
        heard back about a request carrying it, or Last.fm answered a request
        carrying it with an explicit refusal. Everything else — a second read
        back off the disk, a second that rode a request whose response never
        arrived — leaves a play possibly sitting under it, and replacing such a
        second is how a duplicate gets made.

        Declared outside the loop body because it has to survive a retry: a
        rate limit is a definite rejection from Last.fm, so the second the
        rejected request carried is still known-unspent on the way round.
      */
      let pendingSecondUnspent = false;
      /*
        The one queue position whose second has already been re-allocated once.
        Held outside the loop body because a retry re-enters it, so a flag
        declared per iteration would reset itself and let a track that Last.fm
        keeps refusing spin forever.
      */
      let reTagRetryIndex = -1;
      if (inheritedSec > 0 && !pendingReTagTimestampSec) {
        this.clearPendingSecond(headTrack);
      }

      if (this.scrobbledTracks === 0 && this.previouslyScrobbled === 0) {
        trackEvent('scrobble_started', this.progressProps());
      } else {
        trackEvent('scrobble_resumed', this.progressProps({
          already_scrobbled: this.scrobbledTracks,
        }));
      }

      if (await this.verifyPending(api)) {
        await this.stopNotStored();
        return;
      }

      /*
        `i` is incremented conditionally at the end so a rate-limited track can
        be retried. `tracks` can grow while this runs: plays Last.fm did not
        keep are re-queued at the end.
      */
      for (let i = this.scrobbledTracks; ;) {
        if (i >= tracks.length) {
          // Nothing is finished until it is confirmed, and confirming can
          // re-queue plays.
          if (await this.verifyPending(api)) {
            await this.stopNotStored();
            return;
          }
          if (i >= tracks.length) {
            break;
          }
        }

        // A handoff outranks everything. Checked separately from `paused`
        // because `pauseWithCountdown` clears that flag when its timer expires,
        // so a halt landing during a backoff would otherwise be undone.
        if (this.handoffHalted) {
          this.endPacing();
          // Persisted before returning, not left to the halting side. Only a
          // freeze *responder* saves on this tab's behalf; a halt driven by a
          // remote-ownership event has no responder and no acknowledgement, so
          // without this the tracks sent since the last save exist only in
          // memory and the queue that gets uploaded still contains them.
          await this.persistForHalt();
          return;
        }

        /*
          Another tab may have taken this queue since the last iteration —
          either handing it to the server, or freezing it in preparation. That
          tab clears IndexedDB, but nothing about that reaches the copy already
          loaded here, so without this check a second tab keeps scrobbling
          tracks the worker is also sending — for weeks, unattended. Read every
          iteration rather than cached, because the whole point is that it
          changes underneath us.

          Progress is saved before returning. A freezing tab re-reads the queue
          from disk precisely so that whatever this tab managed to send is
          excluded from its upload; stopping without recording those sends
          would hand them to the worker to send again.
        */
        if (background.serverOwnsQueue()) {
          this.endPacing();
          this.handoffHalted = true;
          this.paused = true;
          this.manuallyPaused = true;
          // eslint-disable-next-line no-await-in-loop
          await this.autoSave();
          this.pauseReason = 'Your import was handed to the background service in another tab, so scrobbling here has stopped.';
          trackEvent('scrobble_stopped_server_owns');
          return;
        }

        if (this.leaving) {
          this.stopForLeave(i);
          return;
        }

        // Check if manually paused. Transient waits clear `paused` before
        // returning, so reaching here with it set means the user asked to stop.
        // The save happens *here* rather than in `manualPause` so the snapshot
        // is taken between tracks: saving mid-send would omit the in-flight
        // track's increment and re-send it on resume, which for a re-tagged
        // play means a brand new timestamp and a phantom duplicate scrobble.
        if (this.paused) {
          this.endPacing();
          if (this.manuallyPaused) {
            // eslint-disable-next-line no-await-in-loop
            await this.autoSave();
            this.trackStopped('manual', { track_index: i });
          }
          return;
        }

        // Preventive pacing: wait until the rolling burst window has room.
        // Unlike the old fixed counter this survives page reloads, so a user
        // who returns after being throttled no longer spends a budget they
        // don't have.
        const burstWaitMs = tracker.msUntilBurstSafe();
        if (burstWaitMs > 0) {
          // Reported once for the whole stretch, not once per track: the window
          // only ever frees one slot at a time, so this branch is taken for
          // every remaining track once the limit is reached.
          this.unpacedStreak = 0;
          this.beginPacing(tracker, burstWaitMs);
          this.pacedTracks += 1;
          this.pacedWaitMs += burstWaitMs;

          if (burstWaitMs >= PACING_COUNTDOWN_THRESHOLD_MS) {
            this.pauseReason = `Pacing to stay under Last.fm's rate limit — ${tracker.burstCount} scrobbles sent in the last 10 minutes. Resuming automatically.`;
            await this.pauseWithCountdown(burstWaitMs);
          } else {
            // Sub-second spacing between sends. Deliberately *not*
            // `pauseWithCountdown`: that shows the paused panel and only
            // resolves on a 1s tick, which would both flicker the UI once per
            // track and round every wait up to a full second.
            await this.sleep(burstWaitMs);
          }
          this.syncRateLimitCounters();
          // The wait is followed by a send in this same iteration, so the
          // top-of-loop check would come one track too late.
          if (this.leaving) {
            this.stopForLeave(i);
            return;
          }
        } else if (this.pacing) {
          // One free slot is not the end of a throttled stretch — it is the one
          // slot this track is about to consume, after which the window is full
          // again. Only a run of genuinely unimpeded tracks means we are clear.
          this.unpacedStreak += 1;
          if (this.unpacedStreak >= PACING_EXIT_CLEAR_TRACKS) {
            this.endPacing();
          }
        }

        // Re-checked after the waits above. A halt that arrived while this
        // track was waiting must not be spent on sending it: that track is
        // already in the list about to be uploaded.
        if (this.handoffHalted) {
          this.endPacing();
          await this.persistForHalt();
          return;
        }

        const track = tracks[i];
        this.currentTrackName = track.toString();

        let retrySameTrack = false;
        let recoveredFromRateLimit = false;
        let elapsedSinceFirstRateLimitMs = 0;
        let recoveredRateLimitPauseCount = 0;

        // Allocated once per track, not once per attempt. A retry must re-send
        // the *identical* (artist, track, timestamp) tuple: if the original
        // request actually reached Last.fm and only the response was lost, an
        // identical resend is silently deduplicated, whereas a fresh second
        // would be stored as a second, phantom play.
        /*
          No interval is known to be safe, and this track needs one.

          Sending it anyway — with its real, long-expired timestamp — would
          get it rejected by Last.fm and then *consumed*: the loop advances
          past permanent rejections, so the track would leave the queue and no
          resume could ever retry it. A play held back is recoverable; a play
          spent on a timestamp that was never going to work is not.

          So the loop stops here instead, leaving this track and everything
          after it in the queue. The block carries a deadline, because the
          seconds it protects are all in the past and slide out of Last.fm's
          window on their own.
        */
        /*
          The block guards *allocation*, not sending.

          A track that already carries a pending second has nothing left to
          allocate, and holding it back is the one thing that can turn a pin
          into a duplicate: the second it is pinned to keeps ageing while it
          waits, and once Last.fm will no longer accept it the play it may
          already represent can only be re-sent under a different time. So a
          pin always goes through, and the block is re-examined for whichever
          track is behind it.
        */
        const blockedUntilSec = (track.reTagged && pendingReTagTimestampSec === undefined)
          ? this.reTagBlockedUntilSec()
          : 0;
        if (blockedUntilSec > 0) {
          this.endPacing();
          this.stopped = true;
          this.paused = true;
          this.pauseReason = `Some of your plays are too old to scrobble with their original times, and Scrobblify can't yet tell which substitute times are safe to use. They're still in the queue. Come back after ${new Date(blockedUntilSec * MS_PER_SECOND).toLocaleDateString()} and they'll go through.`;
          await this.autoSave();
          this.trackStopped('retag_blocked', { track_index: i });
          return;
        }

        if (track.reTagged && pendingReTagTimestampSec === undefined) {
          let nowSec = Math.floor(Date.now() / MS_PER_SECOND);
          const todaySec = utcDayStartSec(nowSec);
          /*
            Normally the walk starts six hours back and climbs towards the
            present. After a background job hands work back it starts in a
            range reserved *below* everything the server used instead, because
            the server allocates downwards from the present and a collision
            between the two would be discarded by Last.fm without an error.

            The reservation is abandoned the moment the cursor would reach the
            server's floor: running out of reserved room is better handled by
            returning to the normal window — where a collision is merely
            possible — than by pinning every remaining track to one second,
            where it is certain.
          */
          const reserved = this.reservedReTagRange();
          let withinReservation = reserved !== null && reTagCursorSec + 1 < reserved.ceilingSec;
          let candidateSec = withinReservation
            ? Math.max(reTagCursorSec + 1, (reserved as { floorSec: number }).floorSec)
            : 0;
          /*
            Last.fm's daily cap is per UTC day of the timestamp, and a reserved
            range can reach back into earlier days. Those never reset, so a full
            one is skipped rather than waited for, and running out of reserved
            days falls back to the normal window like running out of seconds.
          */
          while (withinReservation && utcDayStartSec(candidateSec) < todaySec
            && importBudget(await this.storedOn(api, tracker, utcDayStartSec(candidateSec))) <= 0) {
            candidateSec = nextUtcDayStartSec(candidateSec);
            withinReservation = candidateSec < (reserved as { ceilingSec: number }).ceilingSec;
          }
          if (!withinReservation) {
            candidateSec = Math.max(reTagCursorSec + 1, nowSec - RETAG_BACKFILL_SECONDS, todaySec);
          }
          if (utcDayStartSec(candidateSec) >= todaySec
            && importBudget(await this.storedOn(api, tracker, todaySec)) <= 0) {
            // Nothing useful to wait for in the tab: the day resets at midnight UTC.
            await this.stopDailyLimit(tracker, todaySec);
            return;
          }
          const aheadSec = candidateSec - nowSec;
          if (!withinReservation && aheadSec > 0 && aheadSec <= RETAG_CLOCK_WAIT_MAX_SECONDS) {
            await this.sleep(aheadSec * MS_PER_SECOND);
            if (this.handoffHalted) {
              this.endPacing();
              await this.persistForHalt();
              return;
            }
            if (this.leaving) {
              this.stopForLeave(i);
              return;
            }
            nowSec = Math.floor(Date.now() / MS_PER_SECOND);
          }
          const latestSec = withinReservation
            ? Math.min(nowSec, (reserved as { ceilingSec: number }).ceilingSec)
            : nowSec;
          if (candidateSec > latestSec) {
            /*
              There is no second left above the cursor and below the ceiling.

              The old clamp resolved this with `Math.min(latestSec, …)`, which
              hands back `latestSec` — a second at or below the cursor, and so
              one this browser has already used. Every remaining re-tagged
              track would then be pinned to it, and Last.fm would keep exactly
              one of them.

              It is a real situation now that the cursor outlives its import: a
              new selection started moments after the last one finished has a
              cursor sitting on the present, and so does a browser whose clock
              has moved backwards. Both resolve themselves by waiting, so the
              tracks are held rather than spent — the block carries the exact
              second the wait ends, and lifts itself when the clock reaches it.
            */
            this.$store.commit('setReTagBlocked', candidateSec);
            this.endPacing();
            this.stopped = true;
            this.paused = true;
            this.pauseReason = 'Scrobblify has run out of substitute times for your older plays for the moment. They are still in the queue. Resume in a little while and they will go through.';
            await this.autoSave();
            this.trackStopped('retag_no_second', { track_index: i });
            return;
          }
          reTagCursorSec = candidateSec;
          this.reTagCursorSec = reTagCursorSec;
          // Banked outside the import before it is used, for the same reason
          // the pending second is recorded before the send: a second that
          // might have been spent has to be durable from that moment on.
          background.recordReTagCursor(reTagCursorSec);
          pendingReTagTimestampSec = reTagCursorSec;
          // Recorded *before* the send, not after, and durably. The dangerous
          // case is a request that reaches Last.fm and loses its response, so
          // the second has to outlive this tab from the moment it could have
          // been used — not merely from the next time the queue is saved.
          if (!this.setPendingSecond(track, reTagCursorSec)) {
            /*
              The journal is what makes this send recoverable, so a send it
              could not record is one that must not happen.

              Without it, a tab closed between here and the answer leaves a
              play Last.fm may well have stored and no record of the second it
              was stored under — and the resume, finding none, picks a
              different one and puts a second copy on a public profile. The
              queue is left whole and the run stops instead: a held play is
              recoverable, a duplicated one is not.
            */
            this.endPacing();
            this.stopped = true;
            this.paused = true;
            /*
              Forgotten before the save, because no request ever left carrying
              it. `setPendingSecond` writes the component and store copies
              first, and saving with those still set would put a second on the
              disk that nothing is riding on — where the resume reads it as
              *inherited*, refuses to re-time it, and reports a play as
              permanently failed that was never even attempted.
            */
            pendingReTagTimestampSec = undefined;
            this.clearPendingSecond(track);
            this.pauseReason = STORAGE_STOP_REASON;
            // eslint-disable-next-line no-await-in-loop
            await this.autoSave();
            this.trackStopped('retag_journal_unavailable', {
              track_index: i,
              storage_failure: this.storageFailure,
            });
            return;
          }
          pendingSecondUnspent = true;
        }

        const sendTimestampSec = pendingReTagTimestampSec !== undefined
          ? pendingReTagTimestampSec
          : Math.floor(track.timestamp.getTime() / MS_PER_SECOND);
        if (pendingReTagTimestampSec === undefined) {
          // A play keeping its real date counts against the cap of the day it
          // was heard. Re-tagged ones were checked when their second was
          // chosen, and a pinned second always goes through (see above).
          const daySec = utcDayStartSec(sendTimestampSec);
          if (importBudget(await this.storedOn(api, tracker, daySec)) <= 0) {
            if (daySec >= utcDayStartSec(Math.floor(Date.now() / MS_PER_SECOND))) {
              await this.stopDailyLimit(tracker, daySec);
              return;
            }
            // That day never resets, so sending would only be thrown away.
            this.$store.commit('trackFailed');
            this.failedTracks.push({
              track,
              error: `Not sent: Last.fm already holds its maximum of ${LASTFM_DAILY_CAP} scrobbles for that day.`,
            });
            this.scrobbledTracks += 1;
            i++;
            continue;
          }
        }

        try {
          /*
            Set *before* the send, not after it. The moment a request leaves,
            the queue on disk is potentially behind — a response that never
            arrives still leaves a track that may have been scrobbled, and that
            is precisely the state a freeze must not mistake for captured.
          */
          this.progressDirty = true;
          const result = await api.scrobblePlay(track, pendingReTagTimestampSec);
          // The request succeeded but Last.fm may still have thrown the play
          // away. Counting that as success is what made the completion numbers
          // untrustworthy.
          tracker.recordSend();
          this.syncRateLimitCounters();

          if (result.ignored > 0) {
            trackEvent('scrobble_ignored', this.progressProps({
              track_index: i,
              ignored_code: result.ignoredCode,
              re_tagged: !!track.reTagged,
            }));

            if (result.ignoredCode === IGNORE_CODE_DAILY_LIMIT) {
              // Not this track's fault and not permanent, so it must stay in
              // the queue *unprocessed*. Recording it as failed here would
              // count it once now and again when the resume re-sends it.
              /*
                The second goes back in the pot, but only if this loop chose it
                and Last.fm has now said outright that it stored nothing.

                Carrying it over the pause would be worse than useless: the
                resume can be days later, by which time the second may have
                aged past what Last.fm accepts — and a second read back off the
                disk is indistinguishable from one that may already hold a
                play, so the track would be given up on rather than re-timed.
                A second known to be unspent is simply forgotten; the resume
                picks a fresh one that is certain to be in window.

                Only when it is *known* unspent. An inherited pin refused here
                says nothing about the send it came from, and that send may
                have stored the play.
              */
              if (pendingSecondUnspent) {
                this.clearPendingSecond(track);
              }
              this.pauseReason = `Last.fm says you have hit your daily scrobble limit. Come back tomorrow and resume${this.backgroundHint()}.`;
              this.stopped = true;
              this.paused = true;
              // eslint-disable-next-line no-await-in-loop
              await this.autoSave();
              this.trackStopped('lastfm_daily_limit');
              return;
            }

            const badSecond = result.ignoredCode === IGNORE_CODE_TIMESTAMP_TOO_OLD
              || result.ignoredCode === IGNORE_CODE_TIMESTAMP_TOO_NEW;
            const chosenSecond = pendingReTagTimestampSec !== undefined;
            if (badSecond && chosenSecond && !pendingSecondUnspent) {
              /*
                A second that may already be holding a play, refused.

                This loop did not choose it, or chose it and then lost track of
                what happened to it: it came back in a worker export, or off
                the disk, or rode a request whose response never arrived.
                Either way a play may already be sitting under it — that is the
                entire reason the second is carried around instead of being
                re-picked.

                Last.fm refusing it now says the tuple can no longer be
                *stored*. It does not say it was never stored. Re-sending the
                track under a fresh second would therefore be a coin flip
                between recovering a lost play and adding a second copy of one
                the user heard once, to a public profile, where they will
                neither expect it nor easily find it.

                So it is reported rather than re-timed. One named failure the
                user can act on beats a silent duplicate they cannot.
              */
              this.$store.commit('trackFailed');
              this.failedTracks.push({
                track,
                error: 'This play had already been sent once under a time Last.fm will no longer accept. Scrobblify did not send it again, because re-sending it under a different time could put a duplicate on your profile.',
              });
              consecutiveFailures++;
              trackEvent('scrobble_pin_expired', this.progressProps({
                track_index: i,
                ignored_code: result.ignoredCode,
              }));
            } else if (badSecond && chosenSecond && reTagRetryIndex !== i) {
              /*
                A second known to be unspent was refused — so nothing was
                stored under it and there is nothing left to deduplicate
                against. Dropping it and allocating another is free of the
                usual hazard, and it is what stops a track being consumed for a
                mistake of ours rather than a problem of its own.

                Scoped to a second whose whole history this loop watched. A
                track still carrying its own real listen date that Last.fm
                calls too old is a genuine rejection: re-tagging it here would
                quietly move a play the user chose to keep, and that decision
                is theirs to make on the upload screen.
              */
              reTagRetryIndex = i;
              pendingReTagTimestampSec = undefined;
              pendingSecondUnspent = false;
              this.clearPendingSecond(track);
              retrySameTrack = true;
              trackEvent('scrobble_retag_second_refused', this.progressProps({
                track_index: i,
                ignored_code: result.ignoredCode,
              }));
            } else if (badSecond && chosenSecond) {
              /*
                Twice, on seconds this loop picked itself.

                The allocator only ever offers seconds inside the window
                Last.fm accepts, so a refusal means this machine's clock and
                Last.fm's disagree — a condition every remaining track shares.
                Consuming them one at a time would spend most of the queue
                before the consecutive-failure guard noticed, so the run stops
                with this track still in it and says what to check.

                The pin is cleared because we know it was refused. If the
                compare-and-set on the way out declines that write — it refuses
                a save that drops a pending second when nothing else has moved
                — the resume inherits the old one and spends this single track
                on the branch above. Bounded to one, and never a duplicate.
              */
              pendingReTagTimestampSec = undefined;
              pendingSecondUnspent = false;
              this.clearPendingSecond(track);
              this.endPacing();
              this.stopped = true;
              this.paused = true;
              this.pauseReason = 'Last.fm rejected the substitute times Scrobblify chose for your older plays. That usually means this device\'s clock is wrong. Check the clock and resume.';
              // eslint-disable-next-line no-await-in-loop
              await this.autoSave();
              this.trackStopped('retag_second_refused', { track_index: i });
              return;
            } else {
              const reason = LastFm.describeIgnoreCode(result.ignoredCode, result.ignoredMessage);
              this.$store.commit('trackFailed');
              this.failedTracks.push({ track, error: reason });
              consecutiveFailures++;
            }
          } else {
            // Accepted is not stored: it counts once it is read back.
            this.pending.push({ scrobble: track, timestampSec: sendTimestampSec });
            this.recordStored(utcDayStartSec(sendTimestampSec));
            consecutiveFailures = 0;
          }

          if (this.firstRateLimitAtMs !== null) {
            recoveredFromRateLimit = true;
            elapsedSinceFirstRateLimitMs = Date.now() - this.firstRateLimitAtMs;
            recoveredRateLimitPauseCount = this.rateLimitPauseCount;
            this.firstRateLimitAtMs = null;
            this.rateLimitPauseCount = 0;
          }

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.errorMessage = `${MAX_CONSECUTIVE_FAILURES} scrobbles in a row were rejected by Last.fm.`;
            this.errorDetails = this.failedTracks[this.failedTracks.length - 1].error;
            this.showError = true;
            this.pauseReason = 'Paused because Last.fm rejected several scrobbles in a row.';
            this.stopped = true;
            this.paused = true;
            // These were permanent rejections, so the tracks are genuinely
            // processed — advance past this one before saving so the resume
            // doesn't re-send and re-count it.
            this.scrobbledTracks += 1;
            // And the second it was sent under goes with it. Left behind, it
            // would be saved alongside a queue whose head is now a *different*
            // track, and the resume would hand a spent second to that track.
            pendingReTagTimestampSec = undefined;
            pendingSecondUnspent = false;
            this.clearPendingSecond(track);
            // eslint-disable-next-line no-await-in-loop
            await this.autoSave();
            this.trackStopped('repeated_rejections', {
              consecutive_failures: consecutiveFailures,
            });
            return;
          }
        } catch (e) {
          // Rate limit (Last.fm error 29 / HTTP 429): back off and retry the
          // same track rather than counting it as a failure.
          if (LastFm.isRateLimitError(e)) {
            const rateLimitStartMs = Date.now();
            // Real throttling supersedes preventive pacing: close out the
            // stretch so its cost is reported against the pacing, not the
            // minutes we are about to spend backing off.
            this.endPacing();
            if (this.firstRateLimitAtMs === null) {
              this.firstRateLimitAtMs = rateLimitStartMs;
            }
            this.rateLimitPauseCount++;
            // Teach the tracker where this account's real ceiling is.
            tracker.recordRateLimit();
            this.syncRateLimitCounters();

            trackEvent('scrobble_rate_limited', this.progressProps({
              track_index: i,
              burst_count: tracker.burstCount,
              burst_limit: tracker.burstLimit,
              daily_count: tracker.dailyCount,
              rate_limit_pause_count: this.rateLimitPauseCount,
              elapsed_since_first_rate_limit_ms: rateLimitStartMs - this.firstRateLimitAtMs,
            }));

            if (this.rateLimitPauseCount > MAX_RATE_LIMIT_RETRIES) {
              // Retrying further is not useful: recovery from a sustained rate
              // limit takes hours, not minutes. Save and hand control back.
              this.pauseReason = `Last.fm is still rate limiting your account after ${MAX_RATE_LIMIT_RETRIES} retries over ${formatDuration(Date.now() - this.firstRateLimitAtMs)}. This usually clears after a few hours — come back later and resume.`;
              trackEvent('scrobble_rate_limit_gave_up', this.progressProps({
                track_index: i,
                burst_count: tracker.burstCount,
                burst_limit: tracker.burstLimit,
                daily_count: tracker.dailyCount,
                rate_limit_pause_count: this.rateLimitPauseCount,
                elapsed_since_first_rate_limit_ms: Date.now() - this.firstRateLimitAtMs,
              }));
              this.stopped = true;
              this.paused = true;
              /*
                Same reasoning as the daily limit: error 29 is Last.fm turning
                the request away, so a second this loop chose and has watched
                ever since stored nothing. Carrying it across a pause that can
                last hours only gives it time to age out of the window, after
                which it can no longer be told apart from a second that may
                hold a play, and the track is given up on instead of re-timed.
              */
              if (pendingSecondUnspent) {
                this.clearPendingSecond(track);
              }
              // eslint-disable-next-line no-await-in-loop
              await this.autoSave();
              this.trackStopped('rate_limit_exhausted', {
                rate_limit_pause_count: this.rateLimitPauseCount,
                elapsed_since_first_rate_limit_ms: Date.now() - this.firstRateLimitAtMs,
              });
              return;
            }

            const backoffMs = RATE_LIMIT_BACKOFF_MS[this.rateLimitPauseCount - 1];
            this.pauseReason = `Rate limited by Last.fm. Waiting ${formatDuration(backoffMs)} before retrying (attempt ${this.rateLimitPauseCount} of ${MAX_RATE_LIMIT_RETRIES}).`;
            trackEvent('scrobble_paused', this.progressProps({ reason: 'rate_limit' }));
            await this.pauseWithCountdown(backoffMs);
            if (!this.leaving && !this.manuallyPaused) {
              trackEvent('scrobble_rate_limit_cooldown_complete', this.progressProps({
                track_index: i,
                burst_count: tracker.burstCount,
                burst_limit: tracker.burstLimit,
                daily_count: tracker.dailyCount,
                rate_limit_pause_count: this.rateLimitPauseCount,
                configured_cooldown_ms: backoffMs,
                actual_pause_ms: Date.now() - rateLimitStartMs,
              }));
            }
            retrySameTrack = true;
          } else if (LastFm.isSessionKeyError(e) || LastFm.isNotAuthenticatedError(e)) {
            // The stored session key is dead (or already gone), so every
            // remaining track would fail identically. This used to burn ten
            // tracks as "failed", then offer a retry with the same key — and
            // keep the key, so every later visit failed the same way. The track
            // is not at fault: leave it unconsumed, save, and send the user to
            // sign in again.
            const missing = LastFm.isNotAuthenticatedError(e);
            this.pauseReason = missing
              ? 'You\'re not signed in to Last.fm. Your progress is saved — sign in, then choose'
                + ' "Resume" to carry on where you left off.'
              : 'Last.fm is no longer accepting your sign-in. This can happen after'
                + ' signing in to Scrobblify on another device or browser, changing your Last.fm'
                + ' password, or removing Scrobblify\'s access. Sign in again, then choose'
                + ' "Resume" to carry on where you left off.';
            this.sessionInvalid = true;
            this.stopped = true;
            this.paused = true;
            // Error 9 is a definite refusal, so a second this loop chose stored
            // nothing; carrying it across the sign-in only lets it age out.
            if (pendingSecondUnspent) {
              this.clearPendingSecond(track);
            }
            // eslint-disable-next-line no-await-in-loop
            await this.autoSave();
            // Kept apart from `session_invalid`: that is Last.fm rejecting a
            // key, this is a route into the loop that skipped signing in.
            this.trackStopped(missing ? 'not_authenticated' : 'session_invalid', { track_index: i });
            api.clearSessionKey();
            return;
          } else if (LastFm.isNetworkError(e)) {
            // Transient connectivity problem (offline, DNS, connection reset,
            // etc.). Don't count this against the track: pause briefly and retry
            // the same track once the network hopefully recovers.
            this.pauseReason = `Couldn't reach Last.fm (network error). Retrying in ${NETWORK_ERROR_COOLDOWN_SECONDS} seconds. Check your internet connection.`;
            trackEvent('scrobble_paused', this.progressProps({ reason: 'network_error' }));
            trackEvent('scrobble_network_error', this.progressProps({ track_index: i }));
            await this.pauseWithCountdown(NETWORK_ERROR_COOLDOWN_MS);
            /*
              The outcome of this request is genuinely unknown — it may have
              reached Last.fm and had only its answer lost. So the second it
              carried stops being known-unspent, and from here on it is treated
              as one that may already hold a play: re-sent identically, and
              reported rather than replaced if Last.fm later refuses it.
            */
            pendingSecondUnspent = false;
            retrySameTrack = true;
          } else {
            this.$store.commit('trackFailed');
            this.failedTracks.push({ track, error: (e as Error).message || 'Unknown error' });
            consecutiveFailures++;

            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              trackError('scrobble.repeatedFailures', e, this.progressProps({
                consecutive_failures: consecutiveFailures,
              }));
              this.errorMessage = `${MAX_CONSECUTIVE_FAILURES} tracks failed in a row. There may be a problem with Last.fm or your authentication.`;
              this.errorDetails = (e as Error).message || String(e);
              this.showError = true;
              this.pauseReason = 'Paused due to repeated failures.';
              this.stopped = true;
              this.paused = true;
              // The track is left unconsumed (scrobbledTracks is not advanced):
              // these were exceptions, not rejections, so a resume should retry
              // it rather than skip it.
              // eslint-disable-next-line no-await-in-loop
              await this.autoSave();
              this.trackStopped('repeated_failures', {
                consecutive_failures: consecutiveFailures,
              });
              return;
            }
          }
        }

        if (!retrySameTrack) {
          this.scrobbledTracks += 1;
          /*
            The track is done with, so its second must be forgotten in every
            place that outlives this iteration — including the store, which a
            resumed loop reads back, and the journal, which outlives the tab.

            Clearing only the component copy left the other two holding a
            second that had already been spent. The next entry into the loop
            found it there, saw a re-tagged track at the head, and concluded it
            was that track's pending second. If the two tracks were repeats of
            the same song — which is the ordinary case in the histories this
            feature exists for — Last.fm discarded the second one while
            reporting it accepted, and the play was gone with no error.
          */
          pendingReTagTimestampSec = undefined;
          pendingSecondUnspent = false;
          this.clearPendingSecond(track);
          // Taken here, between tracks, for the same reason the manual pause
          // saves between tracks: the snapshot must not omit an in-flight send.
          // Not on the last track, whose completion clears the save anyway.
          this.tracksSinceCheckpoint += 1;
          if (this.tracksSinceCheckpoint >= CHECKPOINT_EVERY_TRACKS && i + 1 < tracks.length) {
            // Confirm what has been sent so far, then re-read today's total:
            // the user's own listening counts against the same cap.
            if (await this.verifyPending(api)) {
              await this.stopNotStored();
              return;
            }
            await this.refreshStored(api, tracker, utcDayStartSec(Math.floor(Date.now() / MS_PER_SECOND)));
            this.checkpoint();
          }
          if (recoveredFromRateLimit) {
            trackEvent('scrobble_rate_limit_recovered', this.progressProps({
              burst_count: this.burstCount,
              burst_limit: this.burstLimit,
              daily_count: this.dailyCount,
              rate_limit_pause_count: recoveredRateLimitPauseCount,
              elapsed_since_first_rate_limit_ms: elapsedSinceFirstRateLimitMs,
            }));
          }
          i++;
        }
      }

      this.endPacing();
      this.completed = true;
      // Anything still unconfirmed here could not be read back; the complete
      // step says so instead of counting it.
      this.$store.commit('setPendingVerification', this.pending.slice());
      trackEvent('scrobble_completed', this.progressProps());
      this.$emit('complete');
    },

    pauseWithCountdown(durationMs: number): Promise<void> {
      // Every caller waits between tracks (before a send, or after an attempt
      // that did not consume its track), so this is a consistent snapshot —
      // and the paused panel is where users most often close the tab.
      this.checkpoint();
      this.paused = true;
      /*
        Pause was pressed while the send that led here was in flight. Waiting
        out a backoff would hold "Pausing…" for up to 30 minutes and then carry
        on scrobbling, because expiry clears `paused`. Returning now lets the
        loop's pause check stop the run straight away.
      */
      if (this.manuallyPaused) {
        if (!this.handoffHalted) {
          this.pauseReason = MANUAL_PAUSE_REASON;
        }
        return Promise.resolve();
      }
      const deadline = Date.now() + durationMs;
      this.countdown = Math.ceil(durationMs / MS_PER_SECOND);

      return new Promise((resolve) => {
        /*
          Held so that *whoever* stops the countdown also releases the loop.
          The interval used to be the only thing that could resolve this, which
          meant an external `cancelCountdown()` — exactly what a handoff does —
          cleared the timer and left the loop awaiting a promise that nothing
          could ever settle. The loop then never cleared `loopActive`, so the
          handoff timed out and, worse, the orphaned loop made every later
          Resume a no-op.
        */
        this.countdownResolve = resolve;
        // Driven off a wall-clock deadline rather than by decrementing a
        // counter: background tabs throttle setInterval, which would otherwise
        // stretch a 30-minute backoff into something much longer.
        this.countdownTimer = window.setInterval(() => {
          // A handoff must not have to wait out a 30-minute backoff, and its
          // halt must survive one. Resolving without clearing `paused` returns
          // control to the loop, which then sees `handoffHalted` and stops.
          if (this.handoffHalted) {
            this.cancelCountdown();
            return;
          }
          const remainingMs = deadline - Date.now();
          this.countdown = Math.max(0, Math.ceil(remainingMs / MS_PER_SECOND));
          if (remainingMs <= 0) {
            this.paused = false;
            this.pauseReason = '';
            this.cancelCountdown();
          }
        }, 1000);
      });
    },

    /**
     * Stops a countdown and hands control back to whatever is awaiting it.
     *
     * Resolving here rather than in the interval is what makes the countdown
     * safe to cancel from outside. Idempotent: the resolver is dropped once
     * called, so a second cancel does nothing. `paused` is deliberately left
     * set; callers decide whether the run is stopping or resuming.
     */
    cancelCountdown() {
      if (this.countdownTimer) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
      }
      this.countdown = 0;
      const resolve = this.countdownResolve;
      this.countdownResolve = null;
      if (resolve) {
        resolve();
      }
    },

    manualPause() {
      this.pauseReason = MANUAL_PAUSE_REASON;
      this.paused = true;
      // Tracked separately from `stopped`, which drives the red error styling.
      // A deliberate pause is not a failure, but it is just as terminal: the
      // loop returns, so the user needs a way back in. The scrobble loop picks
      // this up and does the saving and reporting.
      this.manuallyPaused = true;
    },

    /**
     * Stops the loop before a background handoff is negotiated.
     *
     * This is the single most important line in the client half of the
     * feature. The handoff uploads the tracks that are *currently* remaining;
     * if the loop keeps running while the user is being redirected through
     * Last.fm, every track it sends in the meantime is also in the uploaded
     * list, and the server will scrobble it a second time.
     *
     * `handoffHalted` is the stop signal rather than `paused`, because
     * `pauseWithCountdown` clears `paused` unconditionally when its timer
     * expires. Halting a loop that was sitting in a 30-minute rate-limit
     * backoff would otherwise last only until that backoff ended, and the loop
     * would resume mid-redirect — the exact duplicate this exists to prevent.
     *
     * Returns whether the loop actually stopped. A false return must abort the
     * handoff: proceeding while the loop is still sending is worse than not
     * offering the feature at all.
     */
    /**
     * Second after which re-tagging becomes safe again, or 0 if it is safe now.
     *
     * Evaluated against the clock rather than stored as a boolean, so a block
     * left over from an unreadable take-back lifts by itself once the seconds
     * it protects have slid out of Last.fm's window.
     *
     * A method, not a computed, and that is load-bearing. `Date.now()` is not
     * a reactive dependency, so Vue would cache the first answer and never
     * recompute it — in a tab left open across the deadline the block would
     * never lift, which is the one thing the deadline exists to guarantee.
     */
    reTagBlockedUntilSec(): number {
      const until = (this.$store.state.reTagBlockedUntilSec as number) || 0;
      return until > Math.floor(Date.now() / MS_PER_SECOND) ? until : 0;
    },

    async haltForHandoff(): Promise<boolean> {
      if (!this.scrobbling || !this.loopActive) {
        // Nothing is sending, so there is nothing to stop. Still flagged, so
        // the paused view explains itself and "Resume Now" stays disabled.
        this.handoffHalted = true;
        /*
          An idle loop is not the same as a captured one. If an earlier halt
          stopped the loop but could not write, the sends it made are still
          only in memory — and answering "safe" here is what lets the caller
          upload the older queue sitting on disk. So the write is retried, and
          its result *is* the answer.
        */
        if (this.progressDirty) {
          return this.persistForHalt();
        }
        this.persistFailed = false;
        return true;
      }
      this.persistFailed = false;
      this.handoffHalted = true;
      this.paused = true;
      this.manuallyPaused = true;
      this.pauseReason = 'Handing this over to the background service…';
      // Any countdown in progress is abandoned outright. Waiting out a
      // 30-minute backoff before handing over would be absurd, and its timer
      // would clear `paused` on the way through.
      this.cancelCountdown();
      // One tick of the loop is at most one track plus its retry budget.
      // Polling rather than awaiting a promise keeps this independent of where
      // in the loop the halt landed.
      for (let i = 0; i < 300 && this.loopActive; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await this.sleep(100);
      }
      /*
        Stopping is necessary but not sufficient. The caller's next act is to
        read this queue back off disk and upload it, so a loop that exited
        without landing its final save has left the tracks it just sent inside
        that upload. Reporting them as stopped would hand those plays to the
        worker to send a second time — so an unconfirmed save is answered the
        same way an unstopped loop is.
      */
      return !this.loopActive && !this.persistFailed && !this.progressDirty;
    },

    /**
     * Undoes `haltForHandoff` when the handoff did not happen.
     */
    releaseHandoffHalt() {
      this.handoffHalted = false;
      this.pauseReason = MANUAL_PAUSE_REASON;
    },

    requestBackground() {
      this.$emit('background', this.progressSnapshot());
    },

    /**
     * Persist progress without downloading a file or navigating away, so the
     * user can close the tab and resume later. Used when we stop retrying.
     *
     * Deliberately does not read unconfirmed plays back first. The stop is
     * already on screen, and the user may press "Try Again" — which the
     * re-entry guard ignores while this loop is still running — or close the
     * tab before a slower save lands. They are saved as `pendingVerification`
     * and checked when the run is next entered.
     */
    async autoSave() {
      const snapshot = this.progressSnapshot();
      if (this.persistProgress) {
        try {
          await this.persistProgress(snapshot);
          // A confirmed write is the only thing that clears this. The emit
          // path below cannot confirm anything, so it does not.
          this.progressDirty = false;
          this.autoSaved = true;
          this.saveFailed = false;
          this.checkpointSeq += 1;
        } catch {
          // The parent reports it. Swallowed here so a failed save cannot
          // leave the loop holding its lock — but not hidden: an earlier save
          // no longer covers this progress, so the panel must stop saying so.
          this.autoSaved = false;
          this.saveFailed = true;
        }
        return;
      }
      this.autoSaved = true;
      this.$emit('auto-save', snapshot);
    },

    /**
     * Persists before the loop returns because a handoff is taking the queue.
     *
     * Separate from `autoSave` in both directions.
     *
     * It writes with `saveStateIfAhead`, because a halt is the one moment
     * several tabs persist at once and a plain `put` is last-writer-wins: the
     * slowest tab's snapshot lands last and erases the furthest progress,
     * which the freezing tab then uploads and the worker scrobbles again.
     *
     * And it **records failure** rather than swallowing it. `autoSave` can
     * afford to swallow — nothing is waiting on it and the user still has the
     * tab. Here the freezing tab is about to re-read IndexedDB and treat what
     * it finds as this tab's final word, so a write that did not land must not
     * be reported as one that did. `haltForHandoff` consults `persistFailed`
     * and answers "not stopped", which makes the freeze refuse rather than
     * upload a stale queue.
     */
    async persistForHalt(): Promise<boolean> {
      const snapshot = this.progressSnapshot();
      const persist = this.persistProgressIfAhead || this.persistProgress;
      if (!persist) {
        // No awaitable channel at all: an emit cannot be confirmed, so this
        // has to count as unconfirmed rather than quietly as success.
        this.autoSaved = true;
        this.$emit('auto-save', snapshot);
        this.persistFailed = true;
        return false;
      }
      // One retry. IndexedDB failures here are usually a transient blocked
      // transaction from a sibling persisting at the same moment, which is
      // exactly the situation a halt creates.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await persist(snapshot);
          this.persistFailed = false;
          this.progressDirty = false;
          this.autoSaved = true;
          this.saveFailed = false;
          return true;
        } catch {
          // eslint-disable-next-line no-await-in-loop
          await this.sleep(150);
        }
      }
      this.persistFailed = true;
      this.autoSaved = false;
      this.saveFailed = true;
      trackEvent('scrobble_halt_persist_failed', this.progressProps());
      return false;
    },

    saveAndExit() {
      this.$emit('save-and-exit', this.progressSnapshot());
      // Reachable during a transient countdown, whose loop used to simply carry
      // on once the timer ran out — scrobbling unseen behind the Complete step
      // with nothing saving it, so the next resume re-sent all of it.
      this.leaving = true;
      this.cancelCountdown();
    },

    /**
     * Downloads the progress as it stands, without leaving. Only offered once
     * the loop has stopped, so the snapshot cannot miss an in-flight send.
     */
    downloadProgress() {
      this.$emit('download-progress', this.progressSnapshot());
    },

    /**
     * The loop's exit once "Save Progress & Leave" has been taken. The parent
     * already saved, so this only reports the stop.
     */
    stopForLeave(trackIndex: number) {
      this.endPacing();
      this.trackStopped('save_and_exit', { track_index: trackIndex, auto_saved: true });
    },

    /**
     * Silent, periodic save. Unlike autoSave() this is not a stop: nothing is
     * shown, no `session_saved` is reported, and `autoSaved` is left alone.
     */
    checkpoint() {
      this.tracksSinceCheckpoint = 0;
      const snapshot = this.progressSnapshot();
      if (!this.persistCheckpoint) {
        this.$emit('checkpoint', snapshot);
        return;
      }
      // Not awaited: a slow save must not hold up the sends. Only the latest
      // checkpoint's outcome counts, so a late failure of an older one can't
      // override a newer save that landed.
      this.checkpointSeq += 1;
      const seq = this.checkpointSeq;
      this.persistCheckpoint(snapshot).then(() => {
        if (seq === this.checkpointSeq) { this.saveFailed = false; }
      }, () => {
        // The parent reports it.
        if (seq === this.checkpointSeq) { this.saveFailed = true; }
      });
    },

    /**
     * The re-tag range reserved below a background job's own allocations.
     *
     * Returns null in the ordinary case, where this browser has the window to
     * itself and allocates in `(now - 6h, now]`. Non-null only after a job has
     * handed work back, and only while the reservation is still inside
     * Last.fm's 13-day limit — a stale one would produce timestamps too old to
     * be accepted, which is a worse failure than a possible collision.
     */
    reservedReTagRange(): { floorSec: number; ceilingSec: number } | null {
      /*
        No interval is known to be safe, so there is no reservation to report
        and — crucially — no fallback to the ordinary window either. The loop
        refuses to send re-tagged tracks at all while this holds; this keeps
        any other reader from describing a reservation that does not exist.
      */
      if (this.reTagBlockedUntilSec() > 0) {
        return null;
      }
      const floorSec = (this.$store.state.reTagFloorSec as number) || 0;
      const ceilingSec = (this.$store.state.reTagCeilingSec as number) || 0;
      if (!floorSec || !ceilingSec || ceilingSec <= floorSec) {
        return null;
      }
      const nowSec = Math.floor(Date.now() / MS_PER_SECOND);
      if (floorSec <= nowSec - RETAG_WINDOW_LIMIT_SECONDS) {
        return null;
      }
      return { floorSec, ceilingSec };
    },

    progressSnapshot() {
      const tracker = this.rateLimitTracker();
      return {
        scrobbledTracks: this.scrobbledTracks,
        originalTotalTracks: this.originalTotalTracks,
        originalSucceededCount: this.totalSucceeded,
        pendingVerification: this.pending.slice(),
        sendTimestamps: tracker.getSendTimestamps(),
        lastReTagTimestampSec: this.reTagCursorSec,
        pendingReTagTimestampSec: this.pendingReTagSec || undefined,
        burstCount: tracker.burstCount,
        dailyCount: tracker.dailyCount,
      };
    },
  },
});
</script>
