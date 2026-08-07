<template>
  <v-dialog v-model="visible" max-width="620" scrollable>
    <v-card>
      <v-card-title>
        Finish this in the background
        <v-chip x-small color="deep-purple" text-color="white" class="ml-2">Beta</v-chip>
      </v-card-title>

      <v-card-text class="pt-4">
        <p>
          You have <strong>{{ remaining.toLocaleString() }}</strong> tracks left.
          Last.fm limits everyone to about 2,800 scrobbles a day, so finishing
          this in your browser means coming back roughly
          <strong>{{ daysRemaining }}</strong> more times.
        </p>
        <p>
          Instead, Scrobblify's server can finish it for you. Close the tab
          whenever you like — it keeps going without you.
        </p>

        <!--
          The three things below are the ones a user would be upset to discover
          afterwards, so they are the body of the dialog rather than a footnote.
          Timestamp reassignment in particular changes data on their profile
          that they cannot easily put back.
        -->
        <v-alert type="info" text dense class="mt-4">
          <div class="font-weight-medium mb-2">What you're agreeing to</div>
          <ul class="pl-4 mb-0">
            <li class="mb-2">
              <strong>Listen dates will change.</strong>
              Last.fm only accepts scrobbles from the past 14 days. This import
              will take longer than that, so tracks played outside that window
              are stamped with the time they're actually sent, not the time you
              really played them. Tracks still inside the window keep their
              real dates.
              <span v-if="allReTagged">
                You already chose to move your old plays to today, so this
                changes nothing you hadn't already accepted.
              </span>
            </li>
            <li class="mb-2">
              <strong>The server stores a Last.fm key that can scrobble as you.</strong>
              You'll be sent to Last.fm to approve it. It is encrypted, used
              only for this import, and deleted the moment the import finishes,
              is cancelled, or goes 60 days without being used. You can revoke
              it yourself at any time from
              <a href="https://www.last.fm/settings/applications" target="_blank" rel="noopener">
                your Last.fm settings</a>.
            </li>
            <li>
              <strong>Your remaining track list is uploaded.</strong>
              Artist, track, album and listen time — the same data you're about
              to scrobble anyway. It's deleted when the import ends.
            </li>
          </ul>
        </v-alert>

        <v-alert type="warning" text dense class="mt-3">
          This is brand new and you'd be one of the first people using it. If
          anything looks wrong — duplicates, missing tracks, dates that make no
          sense — please email
          <a :href="mailtoLink">niko@savas.ca</a> and I'll fix it. You can stop
          the import and take your progress back at any time.
        </v-alert>

        <p class="mt-3 mb-0 text-body-2 grey--text text--darken-1">
          Prefer not to? Nothing changes — keep scrobbling in this tab exactly
          as you were.
        </p>
      </v-card-text>

      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn text :disabled="busy" @click="decline">Not now</v-btn>
        <v-btn color="primary" :loading="busy" @click="accept">
          Continue to Last.fm
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import Vue from 'vue';

/** Roughly Last.fm's per-user daily allowance, used only for the estimate. */
const DAILY_LIMIT = 2800;

export default Vue.extend({
  name: 'BackgroundOffer',
  props: {
    value: { type: Boolean, default: false },
    remaining: { type: Number, required: true },
    /** True when every remaining track already had its date rewritten. */
    allReTagged: { type: Boolean, default: false },
    busy: { type: Boolean, default: false },
  },
  computed: {
    visible: {
      get(): boolean { return this.value; },
      set(val: boolean) { this.$emit('input', val); },
    },
    daysRemaining(): string {
      const days = Math.ceil(this.remaining / DAILY_LIMIT);
      return days === 1 ? '1 day' : `${days} days`;
    },
    mailtoLink(): string {
      const subject = encodeURIComponent('Scrobblify background scrobbling');
      return `mailto:niko@savas.ca?subject=${subject}`;
    },
  },
  methods: {
    accept() {
      this.$emit('accept');
    },
    /*
      Distinguished from dismissing the dialog by clicking outside it. If the
      feature is declined the interesting question is whether the concept or
      the consent copy is the problem, and only a deliberate "Not now" is
      evidence the user read it.
    */
    decline() {
      this.visible = false;
      this.$emit('decline');
    },
  },
});
</script>
