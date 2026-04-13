<template>
  <div class="home">
    <h1>So you want to start tracking your spotify plays...</h1>
    You've come to the right place! Last.fm is a free service that lets you track the music you listen to.
    <br>
    <h2>How to connect your last.fm and spotify accounts</h2>
    <ol>
      <li>Go to <a href="https://www.last.fm/join">https://www.last.fm/join</a> and create a last.fm account.</li>
      <li>Go to <a href="https://www.last.fm/settings/applications">https://www.last.fm/settings/applications</a> and connect your accounts.</li>
    </ol>
    <br>
    Now all your plays will be automatically scrobbled (saved) to last.fm! You can use last.fm to track your listening history and use cool tools like <a href="https://savas.ca/lastwave">LastWave</a>.

    <h2>But I want to see cool graphs right now!</h2>
    Well you're in luck - Scrobblify to the rescue! Scrobblify lets you retroactively scrobble your Spotify listening history straight to last.fm.
    <br><br>
    <b>1. Request your Extended Streaming History from Spotify</b><br>
    Go to <a href="https://www.spotify.com/account/privacy/">your Spotify account</a> (Account &gt; Privacy &gt; Download your data).
    Make sure you request the <strong>"Extended streaming history"</strong> specifically — this is different from the basic "Account data" download.
    The extended history includes your full listening history with timestamps, which is what Scrobblify needs.
    Spotify says it can take up to 30 days, but it usually only takes a few days.<br>
    <b>2. Download your data when it's ready</b><br>
    You'll get an email from Spotify when your data is ready. Go back to your
    <a href="https://www.spotify.com/account/privacy/">privacy settings</a> and download the ZIP file.<br>
    <b>3. Create a last.fm account</b><br>
    Create a new account <a href="https://www.last.fm/join">here</a> (an existing account will also work — Scrobblify
    will check to make sure it doesn't add any duplicate scrobbles).<br>
    <b>4. Drag and drop your ZIP file into Scrobblify</b><br>
    No need to unzip or open any files! Just drag and drop the ZIP file directly into the
    <router-link to="/scrobble">Scrobble</router-link> page and Scrobblify will handle the rest.<br>
    <b>5. Sit back and let it run!</b><br>
    Scrobblify will start submitting your listening history to last.fm. Note that last.fm has undocumented rate limits
    (~2,800 scrobbles per day, ~1,000 per burst), so if you have a large history it may take a while.
    Don't worry — Scrobblify handles this automatically by pausing and resuming when rate limits are hit.
    You can also <strong>save your progress</strong> and come back later if you need to close the page. Your progress will be
    waiting for you when you return!

    <h2>Why does scrobblify only backfill the last two weeks?</h2>
    This is a limitation enforced by last.fm — scrobbles are supposed to be for the past two weeks only.
    See the community topic <a href="https://getsatisfaction.com/lastfm/topics/scrobbles-more-than-14-days">here</a>.
    However, Scrobblify gives you the option to <strong>re-tag older listens to today's date</strong>, so you can still
    import your full history if you'd like. Don't worry, once you've connected your accounts all future plays will be
    kept forever!
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
