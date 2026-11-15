<template>
  <v-dialog v-model="visible" max-width="620" scrollable>
    <v-card class="scrobble-confirm text-left">
      <v-card-title>Scrobble {{ trackCount.toLocaleString() }} tracks?</v-card-title>

      <v-card-text class="pt-2">
        <p v-if="estimate.todayCount === 0" class="scrobble-estimate">
          This import has already used today's share of Last.fm's daily cap, so scrobbling can
          start after midnight UTC ({{ resetAt }} your time, in {{ startsIn }}). At up to
          {{ dailyBudget.toLocaleString() }} a day, these will take
          <strong>{{ days(estimate.laterDays) }}</strong>.
        </p>
        <p v-else-if="estimate.laterDays > 0" class="scrobble-estimate">
          Last.fm keeps at most {{ dailyCap.toLocaleString() }} scrobbles a day, your own listening
          included, so Scrobblify sends up to {{ dailyBudget.toLocaleString() }} a day and this will
          take <strong>{{ days(estimate.laterDays + 1) }}</strong>. About
          {{ estimate.todayCount.toLocaleString() }} go today, which takes roughly {{ todayDuration }}.
          Scrobblify then saves your progress and stops. The day resets at midnight UTC
          ({{ resetAt }} your time), so you'll need to come back after that each day to send the
          next {{ dailyBudget.toLocaleString() }}.
        </p>
        <p v-else class="scrobble-estimate">
          This should take about {{ todayDuration }}. Keep this tab open while it runs. If you close
          it, your progress is saved and you can pick up where you left off.
        </p>
      </v-card-text>

      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn text @click="visible = false">Cancel</v-btn>
        <v-btn color="primary" @click="confirm">Start scrobbling</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import Vue, { PropType } from 'vue';
import { LASTFM_DAILY_CAP } from '@/services/DailyCap';
import { IMPORT_DAILY_BUDGET, ScrobbleEstimate, formatDuration } from '@/services/ScrobbleEstimate';

export default Vue.extend({
  name: 'ScrobbleConfirmDialog',
  props: {
    value: { type: Boolean, default: false },
    trackCount: { type: Number, required: true },
    estimate: { type: Object as PropType<ScrobbleEstimate>, required: true },
  },
  data() {
    return { dailyCap: LASTFM_DAILY_CAP, dailyBudget: IMPORT_DAILY_BUDGET };
  },
  computed: {
    visible: {
      get(): boolean { return this.value; },
      set(val: boolean) { this.$emit('input', val); },
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
  },
});
</script>
