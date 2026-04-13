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

const BURST_LIMIT = 950;
const DAILY_LIMIT = 2700;
const BURST_COOLDOWN_MS = 10 * 60 * 1000;

export default Vue.extend({
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
      failedTracks: [] as Array<{ track: Scrobble; error: string }>,
      completed: false,
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

      for (let i = this.scrobbledTracks; i < tracks.length; i++) {
        // Check if manually paused
        if (this.paused) {
          return;
        }

        // Check burst limit
        if (this.burstCount >= BURST_LIMIT) {
          this.pauseReason = `Approaching Last.fm's burst limit (~1,000 scrobbles). Pausing for 10 minutes to avoid being rate-limited.`;
          await this.pauseWithCountdown(BURST_COOLDOWN_MS);
          this.burstCount = 0;
        }

        // Check daily limit
        if (this.dailyCount >= DAILY_LIMIT) {
          this.pauseReason = `Approaching Last.fm's daily limit (~2,800 scrobbles). You'll need to come back tomorrow to continue.`;
          this.paused = true;
          return;
        }

        const track = tracks[i];
        this.currentTrackName = track.toString();

        try {
          await api.scrobblePlay(track);
          this.$store.commit('trackScrobbled');
          this.burstCount++;
          this.dailyCount++;
        } catch (e) {
          this.$store.commit('trackFailed');
          this.failedTracks.push({ track, error: (e as Error).message || 'Unknown error' });
        }

        this.scrobbledTracks += 1;
      }

      this.completed = true;
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

