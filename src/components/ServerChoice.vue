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
      Let Scrobblify scrobble for me (beta)
    </v-btn>
    <div class="choice-fine text-body-medium mt-2">
      You'll need to sign in
      <a
        role="button"
        tabindex="0"
        :aria-expanded="details"
        @click="details = !details"
        @keydown.enter="details = !details"
        @keydown.space.prevent="details = !details"
      >Details</a>
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
      or <a role="button" tabindex="0" :aria-disabled="busy" @click="local" @keydown.enter="local"
        @keydown.space.prevent="local">scrobble locally</a>
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
