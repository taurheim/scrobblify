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
          Last.fm only accepts about 2,700 scrobbles a day from one account, so
          finishing here means coming back over the next
          <strong>{{ daysRemaining }}</strong>.
        </p>
        <p>
          Scrobblify's server can do the rest instead. It carries on after you
          close the tab.
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
              Last.fm rejects scrobbles older than 14 days, and this import
              takes longer than that. Tracks played before the cutoff get the
              date they were sent instead of the date you played them. A play
              keeps its real date only if the server sends it within 13 days of
              when you played it.
              <span v-if="allReTagged">
                You already chose to move your old plays to today, so this
                changes nothing you hadn't already accepted.
              </span>
            </li>
            <li class="mb-2">
              <strong>The server keeps a key that can scrobble as you.</strong>
              Last.fm asks you to approve it on the next screen. It is stored
              encrypted and used only for this import. It gets deleted when the
              import ends, when you cancel, or 60 days after you hand the import
              over, whichever comes first. You can
              also revoke it yourself in
              <a href="https://www.last.fm/settings/applications" target="_blank" rel="noopener">
                your Last.fm settings</a>.
            </li>
            <li>
              <strong>Your remaining tracks are uploaded.</strong>
              Artist, track, album and listen time: the same data you were
              about to send anyway. Deleted when the import ends.
            </li>
          </ul>
        </v-alert>

        <v-alert type="warning" text dense class="mt-3">
          This feature is new and not well tested yet. If something looks wrong
          (duplicates, missing tracks, odd dates), email
          <a :href="mailtoLink">niko@savas.ca</a> and I'll look into it. You can
          stop the import and take your progress back at any point.
        </v-alert>

        <p class="mt-3 mb-0 text-body-2 grey--text text--darken-1">
          &ldquo;Not now&rdquo; leaves this tab scrobbling as before.
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

/*
  The rate the worker actually paces at, and the same constant `describeJob`
  in worker/src/api.ts divides by. Last.fm's own ceiling is nearer 2,800, but
  quoting that here made this dialog promise a date one day earlier than the
  status card the user lands on immediately afterwards.
*/
const DAILY_LIMIT = 2700;

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
