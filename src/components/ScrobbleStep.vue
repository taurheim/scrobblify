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
      <v-btn class="primary" @click="scrobble">Scrobble</v-btn>
    </div>

    <!-- Scrobbling view (active, not paused) -->
    <div v-else-if="!paused && !completed">
      <p>Scrobbling... <b>{{ currentTrackName }}</b></p>
      <v-progress-linear v-model="progress" class="mb-4"></v-progress-linear>

      <!--
        Preventive pacing is normal operation, not an interruption: it stays put
        for the whole throttled stretch rather than flipping the view into the
        paused panel once per track.
      -->
      <v-alert v-if="pacing" type="info" dense text class="mb-4">
        {{ pacingNotice }}
      </v-alert>

      <v-card class="pa-3 mb-4" outlined>
        <div class="overall-progress">
          Overall: {{ totalSucceeded }} of {{ originalTotalTracks }} scrobbled
        </div>
        <div>
          This session: {{ scrobbledTracks }} of {{ tracksToScrobble.length }}
          ({{ failedTracks.length }} failed)
        </div>
        <div>Recent: {{ burstCount }} / {{ burstLimit }} in the last 10 minutes</div>
        <div>Last 24h: {{ dailyCount }} / {{ dailyLimit }}</div>
      </v-card>

      <v-btn outlined @click="manualPause">Pause &amp; Save</v-btn>
    </div>

    <!-- Paused view -->
    <div v-else-if="paused">
      <v-alert :type="pauseAlertType" prominent>
        {{ pauseReason }}
      </v-alert>

      <v-card class="pa-4 mb-4 text-center" outlined>
        <div v-if="countdown > 0" class="text-h5 mb-2">
          Auto-resuming in {{ formattedCountdown }}
        </div>
        <div v-if="countdown > 0" class="mb-2 text-body-2">
          You can save progress and leave now, then resume later at any time.
        </div>
        <div v-if="canResume && autoSaved" class="mb-2 text-body-2">
          Your progress has been saved automatically — just come back to this page later
          and choose "Resume".
        </div>
        <div class="mb-3 overall-progress">
          {{ totalSucceeded }} of {{ originalTotalTracks }} completed so far
        </div>

        <v-btn class="primary mr-2" @click="saveAndExit">Save Progress &amp; Leave</v-btn>
        <!--
          Anything terminal needs a way back in. Without this a manual pause was
          a dead end: a disabled button waiting on an auto-resume that the loop
          had already returned from.
        -->
        <v-btn v-if="canResume" outlined @click="scrobble">
          {{ manuallyPaused ? 'Resume Now' : 'Try Again Now' }}
        </v-btn>
        <v-btn v-else outlined disabled>Wait Here</v-btn>
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
    </div>

    <!-- Failed tracks section -->
    <v-expansion-panels v-if="failedTracks.length > 0" class="mt-4">
      <v-expansion-panel>
        <v-expansion-panel-header>
          {{ failedTracks.length }} failed track(s)
        </v-expansion-panel-header>
        <v-expansion-panel-content>
          <div v-for="(item, i) in failedTracks" :key="i" class="mb-1">
            <strong>{{ item.track.toString() }}</strong> — {{ item.error }}
          </div>
        </v-expansion-panel-content>
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
import Vue from 'vue';
import Scrobble from '@/models/Scrobble';
import LastFm from '@/api/LastFm';
import ErrorDialog from '@/components/ErrorDialog.vue';
import { trackEvent, trackError } from '@/services/Analytics';
import RateLimitTracker, { DAILY_LIMIT } from '@/services/RateLimitTracker';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

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

const MAX_CONSECUTIVE_FAILURES = 10;

// Re-tagged plays (see Scrobble.reTagged) are stamped at send time, starting
// this far back and stepping forward one second per scrobble. Last.fm rejects
// timestamps in the future and anything older than 14 days, so the cursor is
// always clamped into (now - 6h, now].
//
// Six hours of runway is far more than the pacing needs — the burst limit keeps
// sustained throughput below one scrobble per second — but it keeps every
// scrobble comfortably inside the window no matter how long the import runs or
// how many times it is resumed.
const RETAG_BACKFILL_SECONDS = 6 * 60 * 60;

// Last.fm ignoredMessage code 5: the account is out of scrobbles for the day.
// Retrying is pointless until tomorrow.
const IGNORE_CODE_DAILY_LIMIT = 5;

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / MS_PER_MINUTE);
  if (totalMinutes < 1) {
    const seconds = Math.max(1, Math.ceil(ms / MS_PER_SECOND));
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  }
  const hours = Math.round(totalMinutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export default Vue.extend({
  components: { 'error-dialog': ErrorDialog },
  data() {
    return {
      scrobbling: false,
      currentTrackName: '',
      // Tracks *processed* this session (successes + permanent failures). Also
      // the loop index / resume point, so it must count both.
      scrobbledTracks: 0,
      // Tracks Last.fm actually accepted this session.
      succeededTracks: 0,
      // High-water mark of the send-time timestamp allocator for re-tagged
      // plays. Persisted so a resume cannot reuse an earlier run's seconds.
      reTagCursorSec: 0,
      paused: false,
      // A pause the loop will not resume from on its own. Distinguishes "wait a
      // moment" from "we've given up for now, come back later".
      stopped: false,
      // A terminal pause the *user* asked for. Terminal like `stopped`, but not
      // an error, so it gets its own flag rather than colouring a deliberate
      // action as a failure.
      manuallyPaused: false,
      autoSaved: false,
      pauseReason: '',
      countdown: 0,
      countdownTimer: null as number | null,
      // Preventive pacing is a *stretch* of throttled sends, not a single
      // pause: it is entered once when the rolling window fills and left once
      // the window has room again. Telemetry and UI both describe the stretch,
      // so neither fires per track.
      pacing: false,
      pacingStartedAtMs: 0,
      pacedTracks: 0,
      pacedWaitMs: 0,
      // Mirrors of RateLimitTracker state. The tracker itself is deliberately
      // non-reactive (see created()), so these are refreshed explicitly.
      burstCount: 0,
      dailyCount: 0,
      burstLimit: 0,
      dailyLimit: DAILY_LIMIT,
      rateLimitPauseCount: 0,
      firstRateLimitAtMs: null as number | null,
      failedTracks: [] as Array<{ track: Scrobble; error: string }>,
      completed: false,
      showError: false,
      errorMessage: '',
      errorDetails: '',
    };
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
     * Size of the whole import. `tracksToScrobble.length` shrinks every time a
     * session is saved and resumed, so it is useless as a completion
     * denominator — this does not shrink.
     */
    originalTotalTracks(): number {
      return this.$store.state.originalTotalTracks || this.tracksToScrobble.length;
    },
    /** Successful scrobbles across every session of this import. */
    totalSucceeded(): number {
      return this.previouslyScrobbled + this.succeededTracks;
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

    /*
      Whether the loop has returned for good and the user must restart it. Both
      giving up on an error and pausing on purpose qualify; only the transient
      waits (which clear `paused` themselves) do not.
    */
    canResume(): boolean {
      return this.stopped || this.manuallyPaused;
    },

    // A deliberate pause is not a failure, so it must not be styled as one.
    pauseAlertType(): string {
      if (this.manuallyPaused) {
        return 'info';
      }
      return this.stopped ? 'error' : 'warning';
    },
  },
  created() {
    this.syncRateLimitCounters();
  },
  beforeDestroy() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  },
  methods: {
    /**
     * The rolling-window rate-limit tracker, created lazily and cached
     * off-reactivity (`_`-prefixed keys are skipped by Vue 2's observer). It is
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
        succeeded_tracks: this.succeededTracks,
        failed_tracks: this.failedTracks.length,
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

    async scrobble() {
      const tracker = this.rateLimitTracker();
      // Defensive: a previous run that was torn down mid-stretch would
      // otherwise suppress the next `beginPacing`.
      this.endPacing();
      this.scrobbling = true;
      this.completed = false;
      this.paused = false;
      this.stopped = false;
      this.manuallyPaused = false;
      this.autoSaved = false;
      this.pauseReason = '';
      // A manual retry after giving up starts a fresh backoff ladder.
      this.rateLimitPauseCount = 0;
      this.firstRateLimitAtMs = null;
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
      );
      // Held across retries of the current track; cleared only once the track
      // is finally consumed. See the allocation site below.
      let pendingReTagTimestampSec: number | undefined;

      if (this.scrobbledTracks === 0 && this.previouslyScrobbled === 0) {
        trackEvent('scrobble_started', this.progressProps());
      } else {
        trackEvent('scrobble_resumed', this.progressProps({
          already_scrobbled: this.scrobbledTracks,
        }));
      }

      // `i` is incremented conditionally at the end so a rate-limited track can be retried.
      for (let i = this.scrobbledTracks; i < tracks.length;) {
        // Check if manually paused. Transient waits clear `paused` before
        // returning, so reaching here with it set means the user asked to stop.
        // The save happens *here* rather than in `manualPause` so the snapshot
        // is taken between tracks: saving mid-send would omit the in-flight
        // track's increment and re-send it on resume, which for a re-tagged
        // play means a brand new timestamp and a phantom duplicate scrobble.
        if (this.paused) {
          this.endPacing();
          if (this.manuallyPaused) {
            this.autoSave();
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
        } else {
          this.endPacing();
        }

        // Daily ceiling: a rolling 24h window, so it frees up gradually rather
        // than all at once at midnight. There is nothing useful to wait for in
        // the tab, so save and stop.
        const dailyWaitMs = tracker.msUntilDailySafe();
        if (dailyWaitMs > 0) {
          this.pauseReason = `You've reached Last.fm's daily limit of about ${DAILY_LIMIT} scrobbles. Come back in ${formatDuration(dailyWaitMs)} to continue where you left off.`;
          this.stopped = true;
          this.paused = true;
          this.autoSave();
          this.trackStopped('daily_limit', {
            daily_count: tracker.dailyCount,
            wait_ms: dailyWaitMs,
          });
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
        if (track.reTagged && pendingReTagTimestampSec === undefined) {
          const nowSec = Math.floor(Date.now() / MS_PER_SECOND);
          const earliestSec = nowSec - RETAG_BACKFILL_SECONDS;
          reTagCursorSec = Math.min(nowSec, Math.max(reTagCursorSec + 1, earliestSec));
          this.reTagCursorSec = reTagCursorSec;
          pendingReTagTimestampSec = reTagCursorSec;
        }

        try {
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
              this.pauseReason = 'Last.fm says you have hit your daily scrobble limit. Your progress is saved — come back tomorrow and resume.';
              this.stopped = true;
              this.paused = true;
              this.autoSave();
              this.trackStopped('lastfm_daily_limit');
              return;
            }

            const reason = LastFm.describeIgnoreCode(result.ignoredCode, result.ignoredMessage);
            this.$store.commit('trackFailed');
            this.failedTracks.push({ track, error: reason });
            consecutiveFailures++;
          } else {
            this.$store.commit('trackScrobbled');
            this.succeededTracks += 1;
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
            this.errorMessage = `${MAX_CONSECUTIVE_FAILURES} scrobbles in a row were rejected by Last.fm. Your progress is saved.`;
            this.errorDetails = this.failedTracks[this.failedTracks.length - 1].error;
            this.showError = true;
            this.pauseReason = 'Paused because Last.fm rejected several scrobbles in a row.';
            this.stopped = true;
            this.paused = true;
            // These were permanent rejections, so the tracks are genuinely
            // processed — advance past this one before saving so the resume
            // doesn't re-send and re-count it.
            this.scrobbledTracks += 1;
            this.autoSave();
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
              this.autoSave();
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
            trackEvent('scrobble_rate_limit_cooldown_complete', this.progressProps({
              track_index: i,
              burst_count: tracker.burstCount,
              burst_limit: tracker.burstLimit,
              daily_count: tracker.dailyCount,
              rate_limit_pause_count: this.rateLimitPauseCount,
              configured_cooldown_ms: backoffMs,
              actual_pause_ms: Date.now() - rateLimitStartMs,
            }));
            retrySameTrack = true;
          } else if (LastFm.isNetworkError(e)) {
            // Transient connectivity problem (offline, DNS, connection reset,
            // etc.). Don't count this against the track: pause briefly and retry
            // the same track once the network hopefully recovers.
            this.pauseReason = `Couldn't reach Last.fm (network error). Retrying in ${NETWORK_ERROR_COOLDOWN_SECONDS} seconds. Check your internet connection.`;
            trackEvent('scrobble_paused', this.progressProps({ reason: 'network_error' }));
            trackEvent('scrobble_network_error', this.progressProps({ track_index: i }));
            await this.pauseWithCountdown(NETWORK_ERROR_COOLDOWN_MS);
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
              this.pauseReason = 'Paused due to repeated failures. Your progress is saved.';
              this.stopped = true;
              this.paused = true;
              // The track is left unconsumed (scrobbledTracks is not advanced):
              // these were exceptions, not rejections, so a resume should retry
              // it rather than skip it.
              this.autoSave();
              this.trackStopped('repeated_failures', {
                consecutive_failures: consecutiveFailures,
              });
              return;
            }
          }
        }

        if (!retrySameTrack) {
          this.scrobbledTracks += 1;
          pendingReTagTimestampSec = undefined;
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
      trackEvent('scrobble_completed', this.progressProps());
      this.$emit('complete');
    },

    pauseWithCountdown(durationMs: number): Promise<void> {
      this.paused = true;
      const deadline = Date.now() + durationMs;
      this.countdown = Math.ceil(durationMs / MS_PER_SECOND);

      return new Promise((resolve) => {
        // Driven off a wall-clock deadline rather than by decrementing a
        // counter: background tabs throttle setInterval, which would otherwise
        // stretch a 30-minute backoff into something much longer.
        this.countdownTimer = window.setInterval(() => {
          const remainingMs = deadline - Date.now();
          this.countdown = Math.max(0, Math.ceil(remainingMs / MS_PER_SECOND));
          if (remainingMs <= 0) {
            if (this.countdownTimer) {
              clearInterval(this.countdownTimer);
              this.countdownTimer = null;
            }
            this.paused = false;
            this.pauseReason = '';
            resolve();
          }
        }, 1000);
      });
    },

    manualPause() {
      this.pauseReason = 'Paused. Your progress is saved — resume whenever you like.';
      this.paused = true;
      // Tracked separately from `stopped`, which drives the red error styling.
      // A deliberate pause is not a failure, but it is just as terminal: the
      // loop returns, so the user needs a way back in. The scrobble loop picks
      // this up and does the saving and reporting.
      this.manuallyPaused = true;
    },

    /**
     * Persist progress without downloading a file or navigating away, so the
     * user can close the tab and resume later. Used when we stop retrying.
     */
    autoSave() {
      this.$emit('auto-save', this.progressSnapshot());
      this.autoSaved = true;
    },

    saveAndExit() {
      this.$emit('save-and-exit', this.progressSnapshot());
    },

    progressSnapshot() {
      const tracker = this.rateLimitTracker();
      return {
        scrobbledTracks: this.scrobbledTracks,
        originalTotalTracks: this.originalTotalTracks,
        originalSucceededCount: this.totalSucceeded,
        sendTimestamps: tracker.getSendTimestamps(),
        lastReTagTimestampSec: this.reTagCursorSec,
        burstCount: tracker.burstCount,
        dailyCount: tracker.dailyCount,
      };
    },
  },
});
</script>
