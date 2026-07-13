<template>
  <div>
    <!-- Pre-scrobble view -->
    <div v-if="!scrobbling">
      <p>{{ tracksToScrobble.length }} tracks ready to scrobble. Please review them and then click Scrobble to begin.</p>
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

      <v-card class="pa-3 mb-4" outlined>
        <div>Scrobbled {{ scrobbledTracks }} of {{ tracksToScrobble.length }} ({{ failedTracks.length }} failed)</div>
        <div>Burst: {{ burstCount }} / 950</div>
        <div>Today: {{ dailyCount }} / ~2,700</div>
      </v-card>

      <v-btn outlined @click="manualPause">Pause &amp; Save</v-btn>
    </div>

    <!-- Paused view -->
    <div v-else-if="paused">
      <v-alert type="warning" prominent>
        {{ pauseReason }}
      </v-alert>

      <v-card class="pa-4 mb-4 text-center" outlined>
        <div v-if="countdown > 0" class="text-h5 mb-2">
          Auto-resuming in {{ formattedCountdown }}
        </div>
        <div v-if="countdown > 0" class="mb-2 text-body-2">
          You can save progress and leave now, then resume later at any time.
        </div>
        <div class="mb-3">{{ scrobbledTracks }} of {{ tracksToScrobble.length }} completed so far</div>

        <v-btn class="primary mr-2" @click="saveAndExit">Save Progress &amp; Leave</v-btn>
        <v-btn outlined disabled>Wait Here</v-btn>
      </v-card>
    </div>

    <!-- Completed view -->
    <div v-else-if="completed">
      <v-alert type="success">
        Scrobbling complete! {{ scrobbledTracks }} of {{ tracksToScrobble.length }} tracks scrobbled.
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
</style>
<script lang="ts">
import Vue from 'vue';
import Scrobble from '@/models/Scrobble';
import LastFm from '@/api/LastFm';
import ErrorDialog from '@/components/ErrorDialog.vue';
import { trackEvent, trackError } from '@/services/Analytics';

const BURST_LIMIT = 950;
const DAILY_LIMIT = 2700;
const MS_PER_MINUTE = 60 * 1000;
const BURST_COOLDOWN_MS = 10 * MS_PER_MINUTE;
const RATE_LIMIT_COOLDOWN_MS = 1 * MS_PER_MINUTE;
const RATE_LIMIT_COOLDOWN_MINUTES = RATE_LIMIT_COOLDOWN_MS / MS_PER_MINUTE;
const RATE_LIMIT_COOLDOWN_SECONDS = Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000);
const NETWORK_ERROR_COOLDOWN_MS = 30 * 1000;
const NETWORK_ERROR_COOLDOWN_SECONDS = Math.ceil(NETWORK_ERROR_COOLDOWN_MS / 1000);

export default Vue.extend({
  components: { 'error-dialog': ErrorDialog },
  data() {
    return {
      scrobbling: false,
      currentTrackName: '',
      scrobbledTracks: 0,
      paused: false,
      pauseReason: '',
      countdown: 0,
      countdownTimer: null as number | null,
      burstCount: 0,
      dailyCount: 0,
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
    progress(): number {
      return 100 * this.scrobbledTracks / this.tracksToScrobble.length;
    },
    formattedCountdown(): string {
      const minutes = Math.floor(this.countdown / 60);
      const seconds = this.countdown % 60;
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    },
  },
  beforeDestroy() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  },
  methods: {
    async scrobble() {
      this.scrobbling = true;
      this.completed = false;
      const api = this.$store.state.lfmApi as LastFm;
      const tracks = this.tracksToScrobble;
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 10;

      if (this.scrobbledTracks === 0) {
        trackEvent('scrobble_started', { total_tracks: tracks.length });
      } else {
        trackEvent('scrobble_resumed', {
          total_tracks: tracks.length,
          already_scrobbled: this.scrobbledTracks,
        });
      }

      // `i` is incremented conditionally at the end so a rate-limited track can be retried.
      for (let i = this.scrobbledTracks; i < tracks.length; ) {
        // Check if manually paused
        if (this.paused) {
          return;
        }

        // Check burst limit
        if (this.burstCount >= BURST_LIMIT) {
          this.pauseReason = `Approaching Last.fm's burst limit (~1,000 scrobbles). Pausing for 10 minutes to avoid being rate-limited.`;
          trackEvent('scrobble_paused', { reason: 'burst_limit', scrobbled_tracks: this.scrobbledTracks });
          await this.pauseWithCountdown(BURST_COOLDOWN_MS);
          this.burstCount = 0;
        }

        // Check daily limit
        if (this.dailyCount >= DAILY_LIMIT) {
          this.pauseReason = `Approaching Last.fm's daily limit (~2,800 scrobbles). You'll need to come back tomorrow to continue.`;
          trackEvent('scrobble_paused', { reason: 'daily_limit', scrobbled_tracks: this.scrobbledTracks });
          this.paused = true;
          return;
        }

        const track = tracks[i];
        this.currentTrackName = track.toString();

        let retrySameTrack = false;
        let recoveredFromRateLimit = false;
        let elapsedSinceFirstRateLimitMs = 0;
        let recoveredRateLimitPauseCount = 0;
        try {
          await api.scrobblePlay(track);
          this.$store.commit('trackScrobbled');
          this.burstCount++;
          this.dailyCount++;
          if (this.firstRateLimitAtMs !== null) {
            recoveredFromRateLimit = true;
            elapsedSinceFirstRateLimitMs = Date.now() - this.firstRateLimitAtMs;
            recoveredRateLimitPauseCount = this.rateLimitPauseCount;
            this.firstRateLimitAtMs = null;
            this.rateLimitPauseCount = 0;
          }
          consecutiveFailures = 0;
        } catch (e) {
          // Rate limit (Last.fm error 29 / HTTP 429): pause and retry the same track
          // rather than counting it as a failure.
          if (LastFm.isRateLimitError(e)) {
            const rateLimitStartMs = Date.now();
            if (this.firstRateLimitAtMs === null) {
              this.firstRateLimitAtMs = rateLimitStartMs;
            }
            this.rateLimitPauseCount++;
            const pauseDurationLabel = RATE_LIMIT_COOLDOWN_MS % MS_PER_MINUTE === 0
              ? `${RATE_LIMIT_COOLDOWN_MINUTES} ${RATE_LIMIT_COOLDOWN_MINUTES === 1 ? 'minute' : 'minutes'}`
              : `${RATE_LIMIT_COOLDOWN_SECONDS} ${RATE_LIMIT_COOLDOWN_SECONDS === 1 ? 'second' : 'seconds'}`;
            this.pauseReason = `Rate limited by Last.fm. Pausing for ${pauseDurationLabel} before retrying.`;
            trackEvent('scrobble_paused', { reason: 'rate_limit', scrobbled_tracks: this.scrobbledTracks });
            trackEvent('scrobble_rate_limited', {
              scrobbled_tracks: this.scrobbledTracks,
              total_tracks: tracks.length,
              track_index: i,
              burst_count: this.burstCount,
              daily_count: this.dailyCount,
              rate_limit_pause_count: this.rateLimitPauseCount,
              elapsed_since_first_rate_limit_ms: rateLimitStartMs - this.firstRateLimitAtMs,
            });
            await this.pauseWithCountdown(RATE_LIMIT_COOLDOWN_MS);
            trackEvent('scrobble_rate_limit_cooldown_complete', {
              scrobbled_tracks: this.scrobbledTracks,
              total_tracks: tracks.length,
              track_index: i,
              burst_count: this.burstCount,
              daily_count: this.dailyCount,
              rate_limit_pause_count: this.rateLimitPauseCount,
              configured_cooldown_ms: RATE_LIMIT_COOLDOWN_MS,
              actual_pause_ms: Date.now() - rateLimitStartMs,
            });
            retrySameTrack = true;
          } else if (LastFm.isNetworkError(e)) {
            // Transient connectivity problem (offline, DNS, connection reset,
            // etc.). Don't count this against the track: pause briefly and retry
            // the same track once the network hopefully recovers.
            this.pauseReason = `Couldn't reach Last.fm (network error). Retrying in ${NETWORK_ERROR_COOLDOWN_SECONDS} seconds. Check your internet connection.`;
            trackEvent('scrobble_paused', { reason: 'network_error', scrobbled_tracks: this.scrobbledTracks });
            trackEvent('scrobble_network_error', {
              scrobbled_tracks: this.scrobbledTracks,
              total_tracks: tracks.length,
              track_index: i,
            });
            await this.pauseWithCountdown(NETWORK_ERROR_COOLDOWN_MS);
            retrySameTrack = true;
          } else {
            this.$store.commit('trackFailed');
            this.failedTracks.push({ track, error: (e as Error).message || 'Unknown error' });
            consecutiveFailures++;

            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              trackError('scrobble.repeatedFailures', e, {
                consecutive_failures: consecutiveFailures,
                scrobbled_tracks: this.scrobbledTracks,
                failed_tracks: this.failedTracks.length,
              });
              this.errorMessage = `${MAX_CONSECUTIVE_FAILURES} tracks failed in a row. There may be a problem with Last.fm or your authentication.`;
              this.errorDetails = (e as Error).message || String(e);
              this.showError = true;
              this.pauseReason = 'Paused due to repeated failures.';
              this.paused = true;
              return;
            }
          }
        }

        if (!retrySameTrack) {
          this.scrobbledTracks += 1;
          if (recoveredFromRateLimit) {
            trackEvent('scrobble_rate_limit_recovered', {
              scrobbled_tracks: this.scrobbledTracks,
              total_tracks: tracks.length,
              burst_count: this.burstCount,
              daily_count: this.dailyCount,
              rate_limit_pause_count: recoveredRateLimitPauseCount,
              elapsed_since_first_rate_limit_ms: elapsedSinceFirstRateLimitMs,
            });
          }
          i++;
        }
      }

      this.completed = true;
      trackEvent('scrobble_completed', {
        total_tracks: tracks.length,
        scrobbled_tracks: this.scrobbledTracks,
        failed_tracks: this.failedTracks.length,
      });
      this.$emit('complete');
    },

    pauseWithCountdown(durationMs: number): Promise<void> {
      this.paused = true;
      this.countdown = Math.ceil(durationMs / 1000);

      return new Promise((resolve) => {
        this.countdownTimer = window.setInterval(() => {
          this.countdown--;
          if (this.countdown <= 0) {
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
      this.pauseReason = 'Manually paused.';
      trackEvent('scrobble_paused', { reason: 'manual', scrobbled_tracks: this.scrobbledTracks });
      this.paused = true;
    },

    saveAndExit() {
      this.$emit('save-and-exit', {
        scrobbledTracks: this.scrobbledTracks,
        burstCount: this.burstCount,
        dailyCount: this.dailyCount,
      });
    },
  },
});
</script>
