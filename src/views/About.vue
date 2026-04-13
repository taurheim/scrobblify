<template>
  <div class="about">
    <h1>About Scrobblify</h1>
    Scrobblify was built by <a href="https://savas.ca/">Niko Savas</a> primarily as a way for new
    users to last.fm to scrobble their past two weeks of listening, so they can start playing around
    with fun data visualizations!
    <br><br>
    I built this in a weekend so it likely has tons of bugs. If you want to help out and make it
    better, I'd appreciate help over at <a href="https://github.com/taurheim/scrobblify">GitHub</a>.
    <h1>FAQ</h1>
    <h2>Why can't I scrobble more than 2 weeks?</h2>
    Last.fm only allows scrobbling of the past two weeks by default. See <a href="https://getsatisfaction.com/lastfm/topics/can-i-scrobble-music-older-than-2-weeks">this forum post</a>.
    However, Scrobblify gives you the option to <strong>re-tag older listens to today's date</strong>, so you can still import your full listening history if you'd like.

    <h2>What about rate limits?</h2>
    Last.fm has undocumented rate limits — roughly ~2,800 scrobbles per day and ~1,000 per burst.
    If you have a large listening history, you might hit these limits. Don't worry — Scrobblify detects when
    you've been rate-limited and will automatically pause and resume, so you don't have to babysit the process.

    <h2>What if I have a huge listening history?</h2>
    If you have years of Spotify data, importing everything can take a while due to rate limits.
    Scrobblify includes a <strong>save and resume</strong> feature — you can save your progress at any time,
    close the page, and pick up right where you left off when you come back. No lost progress!
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
import Vue from 'vue';
export default Vue.extend({
});
</script>

