<template>
  <div class="about">
    <h1>About</h1>
    <p>
      Scrobblify is a free tool that scrobbles your Spotify listening history to last.fm.
      I built it to help out fellow music data nerds! If you want to say thank you, you can
      <a href="https://buymeacoffee.com/nikosavas" target="_blank" rel="noopener noreferrer">buy me a coffee</a> :)
    </p>

    <v-expansion-panels class="about-faq my-6" variant="accordion">
      <v-expansion-panel title="Why do old plays get today's date?">
        <v-expansion-panel-text>
          Last.fm only accepts plays from the last two weeks with their real date (probably to avoid
          overloading their servers/gaming the system). If you have thoughts about this, please let
          them know! You won't run into this issue on
          <a
            href="https://listenbrainz.org/settings/import/"
            target="_blank"
            rel="noopener noreferrer"
            @click="listenBrainzClicked"
          >ListenBrainz</a>
          so I recommend checking that out if you want fully accurate data.
        </v-expansion-panel-text>
      </v-expansion-panel>
      <v-expansion-panel title="Why does it take so long?">
        <v-expansion-panel-text>
          Last.fm has a maximum 750 scrobbles per day per user, so scrobblify has to go that slowly.
        </v-expansion-panel-text>
      </v-expansion-panel>
      <v-expansion-panel title="Will it add duplicates?">
        <v-expansion-panel-text>
          Yes, the idea of scrobblify is that you get the correct <strong>counts</strong> of each track
          listen, so it'll scrobble one time for every time you listened to a song on spotify. Plays
          already on Last.fm are skipped if you tick "Check for duplicates" (last two weeks only).
        </v-expansion-panel-text>
      </v-expansion-panel>
      <v-expansion-panel title="Where does my data go?">
        <v-expansion-panel-text>
          Your zip file is never uploaded and stays on your browser. If you scrobble using the
          background service, the plays get uploaded there associated with your username. There is an
          option to do all the scrobbling locally in which case nothing is stored on Scrobblify's
          server. Scrobblify does log usage and errors so I can fix bugs.
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <h2>Who built Scrobblify?</h2>
    <p>
      Scrobblify is written and maintained by <a href="https://savas.ca/">Niko Savas</a>.
      Swing by my <a href="https://www.last.fm/user/nikos_">Last.fm profile</a> and say hi!
    </p>

    <h2>Contribute</h2>
    <p>
      If you're a developer who wants a feature or wants to help improve this tool, please swing by
      the <a href="https://github.com/taurheim/scrobblify">GitHub repository</a> and submit a pull request!
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

.about h2 {
  margin-top: 16px;
}
</style>

<script lang="ts">
import { defineComponent } from 'vue';
import { trackEvent } from '@/services/Analytics';

export default defineComponent({
  methods: {
    listenBrainzClicked() {
      trackEvent('listenbrainz_clicked', { source: 'about' });
    },
  },
});
</script>
