<template>
  <div class="get-export">
    <button type="button" class="link-button get-export-back" @click="$emit('back')">
      <span aria-hidden="true">←</span> Back
    </button>
    <h2>Get your history from Spotify</h2>
    <ol>
      <li>
        Go to
        <a
          href="https://www.spotify.com/account/privacy/"
          target="_blank"
          rel="noopener noreferrer"
        >your Spotify privacy settings</a>
        and request <strong>Extended streaming history</strong> (not "Account data").
      </li>
      <li>Wait for Spotify's email. Usually a few days.</li>
      <li>Download the ZIP and upload it in <router-link to="/scrobble">scrobble</router-link></li>
    </ol>

    <section class="get-export-setup">
      <h2>While you wait, create your accounts</h2>
      <ol>
        <li>
          <a
            href="https://www.last.fm/join"
            target="_blank"
            rel="noopener noreferrer"
          >Create a last.fm account</a>
          if you don't already have one.
        </li>
        <li>
          <a
            href="https://www.last.fm/settings/applications"
            target="_blank"
            rel="noopener noreferrer"
          >Connect Spotify in your last.fm settings</a>
          so new Spotify listens get automatically scrobbled.
        </li>
      </ol>
      <p>
        <strong>Note:</strong> Last.fm has a two week limit on scrobbling old tracks. Scrobblify
        gets around this by scrobbling them as if they were listened to today, but it means your
        timeline history will be incorrect for any plays coming from Spotify
      </p>
      <p>
        I'd recommend checking out
        <a
          href="https://listenbrainz.org/"
          target="_blank"
          rel="noopener noreferrer"
        >ListenBrainz</a>
        which does not have this limitation and lets you keep all your original listening dates:
      </p>
      <ol>
        <li>
          <a
            href="https://listenbrainz.org/login/"
            target="_blank"
            rel="noopener noreferrer"
          >Sign in to ListenBrainz</a>
          with your MusicBrainz account.
        </li>
        <li>
          Connect Spotify and enable
          <a
            href="https://listenbrainz.org/settings/music-services/details/"
            target="_blank"
            rel="noopener noreferrer"
          >"Record Spotify Listening History" in ListenBrainz</a>
          to track new listens there too.
        </li>
        <li>
          Once you have your ZIP file from Spotify, you can upload it
          <a
            href="https://listenbrainz.org/settings/import/"
            target="_blank"
            rel="noopener noreferrer"
          >here</a>.
        </li>
      </ol>
    </section>
  </div>
</template>

<style>
.get-export {
  text-align: left;
  max-width: 520px;
  margin: 0 auto;
}

.get-export h2 {
  margin: 12px 0;
}

.get-export li {
  margin-bottom: 10px;
}

.get-export-setup {
  margin-top: 32px;
}

.get-export-setup p {
  margin-bottom: 12px;
}
</style>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'HomeGetExport',
  emits: ['back'],
});
</script>
