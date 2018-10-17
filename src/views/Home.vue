<template>
  <div class="home">
    <h1>So you want to start tracking your spotify plays...</h1>
    You've come to the right place!
    <br>
    <h2>How to connect your last.fm and spotify accounts</h2>
    <ol>
      <li>Go to <a href="https://www.last.fm/join">https://www.last.fm/join</a> and create a last.fm account.</li>
      <li>Go to <a href="https://www.last.fm/settings/applications">https://www.last.fm/settings/applications</a> and connect your accounts.</li>
    </ol>
    <br>
    Now all your plays will be automatically scrobbled (saved) to last.fm! You can use last.fm to track your listening history and use cool tools like <a href="https://savas.ca/lastwave">LastWave</a>.

    <h2>But I want to see cool graphs right now!</h2>
    Well you're in luck - Scrobblify to the rescue! Scrobblify lets you retroactively scrobble your past 2 weeks of plays from spotify straight to last.fm.
    <br><br>
    <b>1. Request to download your Spotify listening history</b><br>
    Go to <a href="https://www.spotify.com/ca-en/account/privacy/">https://www.spotify.com/ca-en/account/privacy/</a>,
    at the bottom click "Request" to request your personal data file. They say it can take up to 30 days but I've found
    it usually only takes a couple days.<br>
    <b>2. Receive email from Spotify that your data is ready</b><br>
    Go back to <a href="https://www.spotify.com/ca-en/account/privacy/">https://www.spotify.com/ca-en/account/privacy/</a>
    and download your zip file.<br>
    <b>3. Create a last.fm account</b><br>
    Create a new account <a href="https://www.last.fm/join">here</a> (an existing account will also work - scrobblify
    will check to make sure it doesn't add any duplicate scrobbles).<br>
    <b>4. Get your data ready</b><br>
    Unzip <code>my_spotify_data.zip</code> and open <code>StreamingHistory.json</code> in a text editor (notepad will work fine).<br>
    <b>5. Use scrobblify!</b><br>
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
