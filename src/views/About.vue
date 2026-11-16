<template>
  <div class="about">
    <h1>What is Scrobblify?</h1>
    <p>
      Scrobblify is a free tool that imports your Spotify listening history into
      <a href="https://www.last.fm/">Last.fm</a>. Just drag and drop your
      Spotify Extended Streaming History ZIP file, and Scrobblify takes care of the rest —
      parsing your data, checking for duplicates, and scrobbling everything to your Last.fm profile.
    </p>
    <p>
      New to Last.fm? It's a music tracking service that builds a profile of your listening habits.
      Once your history is imported, you can explore stats, charts, and tools like
      <a href="https://savas.ca/lastwave">LastWave</a> to visualize your music taste over time.
    </p>

    <h1>Who built Scrobblify?</h1>
    <p>
      Scrobblify is written and maintained by <a href="https://savas.ca/">Niko Savas</a>.
      Swing by my <a href="https://www.last.fm/user/nikos_">Last.fm profile</a> and say hi!
    </p>

    <h1>Support Scrobblify</h1>
    <p>
      Scrobblify is completely free and always will be. If you'd like to support development and
      hosting costs, you can
      <a href="https://buymeacoffee.com/nikosavas">buy me a coffee</a> ☕
    </p>

    <h1>Contribute</h1>
    <p>
      If you're a developer who wants a feature or wants to help improve this tool, please swing by
      the <a href="https://github.com/taurheim/scrobblify">GitHub repository</a> and submit a pull request!
    </p>

    <h1>FAQ</h1>
    <h2>Why can't I scrobble more than 2 weeks?</h2>
    <p>
      Last.fm only allows scrobbling of the past two weeks by default. See
      <a href="https://getsatisfaction.com/lastfm/topics/can-i-scrobble-music-older-than-2-weeks">this forum post</a>.
      However, Scrobblify gives you the option to <strong>re-tag older listens to today's date</strong>,
      so you can still import your full listening history.
    </p>

    <h2>What about rate limits?</h2>
    <p>
      Last.fm keeps at most 750 scrobbles per day (midnight to midnight UTC), your own listening
      included, and quietly throws away anything over that. Scrobblify stops a little short of it
      each day and only counts scrobbles it can see in your Last.fm library, so a large history
      takes a while.
      <template v-if="backgroundEnabled">
        Since you've switched on the background scrobbling beta, you don't have to come back each
        day: once a day's share is sent, choose "Finish this in the background" and Scrobblify's
        server finishes the rest.
      </template>
      <template v-else>Save your progress and come back the next day to continue.</template>
    </p>

    <h2>What if I have a huge listening history?</h2>
    <p>
      If you have years of Spotify data, importing everything can take a while due to rate limits.
      <template v-if="backgroundEnabled">
        With the background scrobbling beta, Scrobblify's server can do that waiting for you and keep
        going after you close the page.
      </template>
      <template v-else>
        Scrobblify includes a <strong>save and resume</strong> feature — you can save your progress
        at any time, close the page, and pick up right where you left off when you come back.
        No lost progress!
      </template>
    </p>
  </div>
</template>
<style>
.about {
  max-width: 800px;
  margin: 0 auto;
  text-align: left;
  padding: 0 5%;
}
</style>
<script lang="ts">
import { defineComponent } from 'vue';
import { isBackgroundEnabled } from '@/services/BackgroundScrobbling';

export default defineComponent({
  data() {
    // The beta opt-in, not live worker capacity: this page only describes what's possible.
    return { backgroundEnabled: isBackgroundEnabled() };
  },
});
</script>
