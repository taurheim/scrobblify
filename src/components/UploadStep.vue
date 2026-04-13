<template>
  <div class="upload-step">
    <div v-if="logs.length > 0" class="logs">
      <pre>
        <template v-for="log in logs">
          {{ log }}</template>
      </pre>
      <v-progress-linear v-if="!readyToScrobble" v-model="progress">
      </v-progress-linear>
      <v-btn class="primary" @click="finishStep" v-if="readyToScrobble">Choose which tracks to scrobble</v-btn>
    </div>
    <div v-else>
      <h2>Upload your Spotify Extended Streaming History ZIP file:</h2>
      <div
        class="drop-zone"
        :class="{ 'drop-zone--active': isDragging }"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="onDrop"
        @click="openFilePicker"
      >
        <input
          ref="fileInput"
          type="file"
          accept=".zip"
          style="display: none"
          @change="onFileSelected"
        >
        <v-icon large class="mb-2">mdi-cloud-upload</v-icon>
        <div v-if="selectedFileName">
          <strong>{{ selectedFileName }}</strong>
        </div>
        <div v-else>
          Drag &amp; drop your .zip file here, or click to browse
        </div>
      </div>
      <br>
      <v-checkbox color="primary" v-model="scrobbleOldPlays" :label="`Scrobble tracks older than 2 weeks (they will show as listened to today)`"></v-checkbox>
      <v-checkbox color="primary" v-model="followLfmRules" :label="`Follow last.fm scrobble rules (This will take longer but be more accurate about which tracks you actually listened to)`"></v-checkbox>
      <br>
      <v-btn color="primary" @click="parseSpotifyData" :disabled="!selectedFile">
        Find tracks
      </v-btn>
    </div>
  </div>
</template>
<style>
.drop-zone {
  border: 2px dashed #ed1c24;
  border-radius: 8px;
  padding: 48px 24px;
  text-align: center;
  cursor: pointer;
  transition: background-color 0.2s, border-color 0.2s;
}

.drop-zone:hover {
  background-color: rgba(237, 28, 36, 0.05);
}

.drop-zone--active {
  background-color: rgba(237, 28, 36, 0.1);
  border-color: #b71c1c;
}

.logs {
  text-align: left;
  flex-wrap: wrap;
}
</style>
<script lang="ts">
import Vue from 'vue';
import JSZip from 'jszip';
import Scrobblify from '@/scrobblify';
import SpotifyListen from '@/models/SpotifyListen';
import Scrobble from '@/models/Scrobble';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default Vue.extend({
  data() {
    return {
      selectedFile: null as File | null,
      selectedFileName: '',
      isDragging: false,
      scrobbleOldPlays: false,
      followLfmRules: false,
      scrobblify: new Scrobblify(this.$store.state.lfmApi),
      logs: [] as string[],
      stepProgress: 0,
      stepTotal: 1,
      readyToScrobble: false,
    };
  },
  computed: {
    progress(): number {
      return 100 * this.stepProgress / this.stepTotal;
    },
  },
  methods: {
    finishStep() {
      this.$emit('complete');
    },
    async smartMoveProgress() {
      // Without adding a delay every so often the page never renders and hangs
      this.stepProgress += 1;
      if (this.stepProgress % 100 === 0) {
        await delay(100);
      }
    },
    openFilePicker() {
      (this.$refs.fileInput as HTMLInputElement).click();
    },
    onFileSelected(event: Event) {
      const input = event.target as HTMLInputElement;
      if (input.files && input.files.length > 0) {
        this.setFile(input.files[0]);
      }
    },
    onDrop(event: DragEvent) {
      this.isDragging = false;
      if (event.dataTransfer && event.dataTransfer.files.length > 0) {
        this.setFile(event.dataTransfer.files[0]);
      }
    },
    setFile(file: File) {
      if (!file.name.endsWith('.zip')) {
        alert('Please upload a .zip file');
        return;
      }
      this.selectedFile = file;
      this.selectedFileName = file.name;
    },
    async parseSpotifyData() {
      if (!this.selectedFile) { return; }

      const reTagDate = new Date();
      this.logs.push('Reading ZIP file...');
      await delay(100);

      const zip = await JSZip.loadAsync(this.selectedFile);
      const audioFilePattern = /Streaming_History_Audio_.*\.json$/;
      const matchingFiles = Object.keys(zip.files).filter(
        (name) => audioFilePattern.test(name) && !zip.files[name].dir,
      );

      if (matchingFiles.length === 0) {
        this.logs.push('No Streaming_History_Audio_*.json files found in the ZIP.');
        return;
      }

      this.logs.push(`Found ${matchingFiles.length} audio history file(s) in ZIP.`);

      const jsonStrings: string[] = await Promise.all(
        matchingFiles.map((name) => zip.files[name].async('string')),
      );

      const parsedData: SpotifyListen[] = this.scrobblify.parseMultipleJsonFiles(jsonStrings);
      this.logs.push(`Found ${parsedData.length} plays in your spotify listening history.`);

      let newData: SpotifyListen[] = [];
      if (this.scrobbleOldPlays) {
        newData = this.scrobblify.reTagOldListens(parsedData, reTagDate);
        this.logs.push(`No tracks removed - old listens have been moved to today (${reTagDate.toDateString()})`);
      } else {
        newData = this.scrobblify.removeOldListens(parsedData, this.scrobbleOldPlays);
        this.logs.push(`Found ${newData.length} tracks that were listened to in the last two weeks`);
      }

      this.stepProgress = 0;
      this.stepTotal = newData.length;
      this.logs.push(`Replaying the listens to find plays that are valid scrobbles...`);
      if (this.followLfmRules) {
        this.logs.push(`(Not Recommended) If you're impatient, this can be sped up by unchecking the "Follow last.fm rules" box.`);

        if (this.scrobbleOldPlays) {
          const EXPECTED_MS_PER_REQUEST = 500;
          const expectedTime = newData.length * EXPECTED_MS_PER_REQUEST / 60000;
          this.logs.push(`While we don't recommend this, it could save you approx. ${expectedTime} minutes`);
        }
      }

      await delay(500);

      let validData: SpotifyListen[] = [];
      try {
        validData = await this.scrobblify.removeInvalidListens(newData, this.smartMoveProgress, !this.followLfmRules);
      } catch (e) {
        this.logs.push(`Looks like we encountered an error. Please send an email to niko@savas.ca with your`);
        this.logs.push(`last.fm username and StreamingHistory.json and I'll take care of it as soon as possibele!`);
        return;
      }
      this.logs.push(`Found ${validData.length} valid scrobbles`);

      // Scrobble each of the songs
      this.stepProgress = 0;
      this.stepTotal = validData.length;
      this.logs.push(`Checking for songs that have already been scrobbled.`);
      let skippedFromError = 0;
      const toBeScrobbled: SpotifyListen[] = [];
      for (const listen of validData) {
        const scrobble = new Scrobble(listen.trackName, listen.artistName, listen.listenDate, listen.albumName);
        try {
          let isAlreadyScrobbled: boolean = false;
          if (scrobble.timestamp.getTime() !== reTagDate.getTime()) {
            isAlreadyScrobbled = await this.scrobblify.isAlreadyScrobbled(scrobble);
          }
          await this.smartMoveProgress();
          if (!isAlreadyScrobbled) {
            toBeScrobbled.push(listen);
          }
        } catch (e) {
          skippedFromError += 1;
        }
      }
      this.logs.push(`Found ${toBeScrobbled.length} songs that haven't been scrobbled yet`);
      if (skippedFromError > 0) {
        this.logs.push(`${skippedFromError} tracks skipped due to errors.
        If this number is really high, let me know at niko@savas.ca`);
      }
      this.logs.push(`Ready to scrobble ${toBeScrobbled.length} tracks.`);
      this.readyToScrobble = true;
      this.$store.commit('setValidScrobbles', toBeScrobbled);
    },
  },
});
</script>
