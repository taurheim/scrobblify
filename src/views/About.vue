<template>
  <div class="about">
    <h1>About Scrobblify</h1>
    Scrobblify was built by <a href="https://savas.ca/">Niko Savas</a> primarily as a way for new
    users to last.fm to scrobble their past two weeks of listening, so they can start playing around
    with fun data visualizations!
    <h1>FAQ</h1>
    <h2>Why can't I scrobble more than 2 weeks?</h2>
    Last.fm only allows for scrobbling of the past two weeks. See <a href="https://getsatisfaction.com/lastfm/topics/can-i-scrobble-music-older-than-2-weeks">this forum post</a>
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

