<template>
  <v-dialog :value="value" max-width="640" persistent scrollable>
    <v-card class="large-history-gate text-left">
      <v-card-title>Before you start scrobbling</v-card-title>

      <v-card-text class="pt-2">
        <p>
          <strong>{{ reTaggedCount.toLocaleString() }}</strong> of your plays are more than 2 weeks
          old. Due to Last.fm's rules:
        </p>
        <ul class="mb-4">
          <li class="mb-2">
            <strong>Your history will end up on the wrong days.</strong> Plays from months or years ago
            will show on your profile as if you listened to them over the coming days, mixed in
            with what you're listening to now.
          </li>
          <li class="mb-2">
            <strong>Scrobbling will take about {{ days }}.</strong> Last.fm keeps at most
            {{ dailyCap.toLocaleString() }} scrobbles a day, your own listening included, so
            Scrobblify sends up to {{ dailyBudget.toLocaleString() }} a day. You'll need to come
            back each day to continue; your progress is saved in between.
          </li>
          <li>
            <strong>It's hard to undo.</strong> Last.fm has no way to delete scrobbles in bulk.
          </li>
        </ul>

        <p class="mb-0">
          If any of these are deal breakers for you, there is good news!
          <a href="https://listenbrainz.org/settings/import/" target="_blank" rel="noopener noreferrer">ListenBrainz</a>
          is an alternative service that will let you transfer your full Spotify history with all
          the correct days and playcounts.
        </p>
      </v-card-text>

      <v-card-actions class="flex-wrap">
        <v-btn
          text
          color="primary"
          href="https://listenbrainz.org/settings/import/"
          target="_blank"
          rel="noopener noreferrer"
          @click="$emit('decline')"
        >
          Use ListenBrainz instead
          <v-icon right small>mdi-open-in-new</v-icon>
        </v-btn>
        <v-spacer></v-spacer>
        <v-btn color="primary" @click="$emit('accept')">I understand, continue</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import Vue from 'vue';
import { LASTFM_DAILY_CAP } from '@/services/DailyCap';
import { IMPORT_DAILY_BUDGET } from '@/services/ScrobbleEstimate';

/*
  Blocking on purpose. A large backdated import is the case where users find
  out too late what they agreed to: days of returning to the tab, and a profile
  whose history is restacked onto the days it was sent, with no bulk undo.
  Shown once the ZIP is parsed, because that is the first point the size is
  known, and before any track is picked or sent.
*/
export default Vue.extend({
  name: 'LargeHistoryGate',
  props: {
    value: { type: Boolean, default: false },
    /** Plays whose date will be rewritten to when they are sent. */
    reTaggedCount: { type: Number, required: true },
  },
  data() {
    return { dailyCap: LASTFM_DAILY_CAP, dailyBudget: IMPORT_DAILY_BUDGET };
  },
  computed: {
    days(): string {
      const n = Math.ceil(this.reTaggedCount / IMPORT_DAILY_BUDGET);
      return n === 1 ? '1 day' : `${n} days`;
    },
  },
});
</script>
