<template>
  <v-dialog v-model="visible" max-width="620" scrollable>
    <v-card class="scrobble-confirm text-left">
      <v-card-title>Scrobble {{ trackCount.toLocaleString() }} tracks?</v-card-title>

      <v-card-text class="pt-2">
        <!--
          There is one saved-progress slot, and the new run's first save
          replaces it. The next resume would then start from this run's count
          and re-send what the saved one already had.
        -->
        <v-alert v-if="savedProgress" type="warning" variant="tonal" class="saved-progress-warning mb-4">
          <strong>You have saved progress<template v-if="savedProgress.total > 0">
            ({{ savedProgress.succeeded.toLocaleString() }} of
            {{ savedProgress.total.toLocaleString() }} tracks scrobbled)</template>.</strong>
          Starting over replaces it, and tracks it already sent may be scrobbled
          again. Resume it instead to carry on where you left off.
        </v-alert>
        <p v-if="estimate.todayCount === 0" class="scrobble-estimate">
          This import has already used today's share of Last.fm's daily cap, so scrobbling can
          start after midnight UTC ({{ resetAt }} your time, in {{ startsIn }}). At up to
          {{ dailyBudget.toLocaleString() }} a day, these will take
          <strong>{{ days(estimate.laterDays) }}</strong>.
          <template v-if="canFinishInBackground">
            You don't have to wait for it: choose "Scrobble the rest for me" when it stops,
            and Scrobblify's server will send them for you, even with this tab closed.
          </template>
        </p>
        <p v-else-if="estimate.laterDays > 0" class="scrobble-estimate">
          Last.fm keeps at most {{ dailyCap.toLocaleString() }} scrobbles a day, your own listening
          included, so Scrobblify sends up to {{ dailyBudget.toLocaleString() }} a day and this will
          take <strong>{{ days(estimate.laterDays + 1) }}</strong>. About
          {{ estimate.todayCount.toLocaleString() }} go today, which takes roughly {{ todayDuration }}.
          Scrobblify then saves your progress and stops.
          <template v-if="canFinishInBackground">
            You can then choose "Scrobble the rest for me" and Scrobblify's server will send
            the rest for you, even with this tab closed.
          </template>
          <template v-else>
            The day resets at midnight UTC ({{ resetAt }} your time), so you'll need to come back
            after that each day to send the next {{ dailyBudget.toLocaleString() }}.
          </template>
        </p>
        <p v-else class="scrobble-estimate">
          This should take about {{ todayDuration }}. Keep this tab open while it runs. If you close
          it, your progress is saved and you can pick up where you left off.
        </p>
      </v-card-text>

      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn variant="text" @click="visible = false">Cancel</v-btn>
        <template v-if="savedProgress">
          <v-btn variant="text" color="error" @click="confirm">Start over</v-btn>
          <v-btn color="primary" variant="flat" @click="resumeSaved">Resume saved progress</v-btn>
        </template>
        <v-btn v-else color="primary" @click="confirm">Start scrobbling</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { defineComponent, PropType } from 'vue';
import { LASTFM_DAILY_CAP } from '@/shared/lastfm/dailyCap';
import {
  IMPORT_DAILY_BUDGET, ScrobbleEstimate, backgroundCanFinish, formatDuration,
} from '@/services/ScrobbleEstimate';

export interface SavedProgressSummary {
  succeeded: number;
  total: number;
}

export default defineComponent({
  name: 'ScrobbleConfirmDialog',
  props: {
    modelValue: { type: Boolean, default: false },
    trackCount: { type: Number, required: true },
    estimate: { type: Object as PropType<ScrobbleEstimate>, required: true },
    /** Largest queue the background offer would take, or 0 when it is off. */
    backgroundTrackLimit: { type: Number, default: 0 },
    /** Saved progress the new run would replace; `total` is 0 when it couldn't be read. */
    savedProgress: { type: Object as PropType<SavedProgressSummary | null>, default: null },
  },
  emits: ['update:modelValue', 'confirm', 'resume-saved'],
  data() {
    return { dailyCap: LASTFM_DAILY_CAP, dailyBudget: IMPORT_DAILY_BUDGET };
  },
  computed: {
    visible: {
      get(): boolean { return this.modelValue; },
      set(val: boolean) { this.$emit('update:modelValue', val); },
    },
    // The offer appears on the stop screen, for whatever is left after today.
    canFinishInBackground(): boolean {
      return backgroundCanFinish(this.trackCount - this.estimate.todayCount, this.backgroundTrackLimit);
    },
    todayDuration(): string {
      return formatDuration(this.estimate.todayMs);
    },
    startsIn(): string {
      return formatDuration(Math.max(0, this.estimate.nextDayStartsMs - Date.now()));
    },
    resetAt(): string {
      return new Date(this.estimate.nextDayStartsMs)
        .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },
  },
  methods: {
    days(n: number): string {
      return n === 1 ? '1 day' : `${n} days`;
    },
    confirm() {
      this.visible = false;
      this.$emit('confirm');
    },
    resumeSaved() {
      this.visible = false;
      this.$emit('resume-saved');
    },
  },
});
</script>
