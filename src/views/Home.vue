<template>
  <div class="home">
    <h1>Want to scrobble your last 2 weeks of spotify listens to last.fm?</h1>
    Well you've come to the right place! Just follow these simples steps to get up and running with last.fm
    <br>
    <h2>1. Request to download your Spotify listening history</h2>
    Go to <a href="https://www.spotify.com/ca-en/account/privacy/">https://www.spotify.com/ca-en/account/privacy/</a>,
    at the bottom click "Request" to request your personal data file. They say it can take up to 30 days but I've found
    it usually only takes a couple days.
    <h2>2. Receive email from Spotify that your data is ready</h2>
    Go back to <a href="https://www.spotify.com/ca-en/account/privacy/">https://www.spotify.com/ca-en/account/privacy/</a>
    and download your zip file.
    <h2>3. Create a last.fm account</h2>
    Create a new account <a href="https://www.last.fm/join">here</a> (an existing account will also work - scrobblify
    will check to make sure it doesn't add any duplicate scrobbles).
    <h2>4. Get your data ready</h2>
    Unzip <b>my_spotify_data.zip</b> and open <b>StreamingHistory.json</b> in a text editor (notepad will work fine).
    <h2>5. Use scrobblify!</h2>
    Go to <router-link to="/scrobble">Scrobble</router-link> and follow the steps there.
  </div>
</template>
<style>
.home {
  text-align: left;
  max-width: 1000px;
  margin: 0 auto;
  padding: 0 5%;
}

.home h2 {
  margin-top: 20px;
}
</style>
<script lang="ts">
import Vue from 'vue';
import ScrobblifyVue from '@/components/Scrobblify.vue';
export default Vue.extend({
  components: {
    scrobblify: ScrobblifyVue,
  },
});
</script>
