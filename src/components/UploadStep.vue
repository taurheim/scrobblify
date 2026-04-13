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
      <v-checkbox color="primary" v-model="followLfmRules" :label="`Validate track lengths (filters out tracks shorter than 30s, or played for less than half their duration / 4 minutes)`"></v-checkbox>
      <v-checkbox color="primary" v-model="checkDuplicates" :label="`Check for duplicates (fetches your last.fm history and skips tracks already scrobbled)`"></v-checkbox>
      <br>
      <v-btn color="primary" @click="parseSpotifyData" :disabled="!selectedFile">
        Find tracks
      </v-btn>
    </div>
    <error-dialog v-model="showError" :message="errorMessage" :details="errorDetails"></error-dialog>
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
import ErrorDialog from '@/components/ErrorDialog.vue';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default Vue.extend({
  components: { 'error-dialog': ErrorDialog },
  data() {
    return {
      selectedFile: null as File | null,
      selectedFileName: '',
      isDragging: false,
      scrobbleOldPlays: false,
      followLfmRules: false,
      checkDuplicates: false,
      scrobblify: new Scrobblify(this.$store.state.lfmApi),
      logs: [] as string[],
      stepProgress: 0,
      stepTotal: 1,
      readyToScrobble: false,
      showError: false,
      errorMessage: '',
      errorDetails: '',
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

      let zip: JSZip;
      try {
        zip = await JSZip.loadAsync(this.selectedFile);
      } catch (e) {
        this.errorMessage = 'Failed to read the ZIP file. It may be corrupted or not a valid ZIP archive.';
        this.errorDetails = (e as Error).message || String(e);
        this.showError = true;
        return;
      }
      const audioFilePattern = /Streaming_History_Audio_.*\.json$/;
      const matchingFiles = Object.keys(zip.files).filter(
        (name) => audioFilePattern.test(name) && !zip.files[name].dir,
      );

      if (matchingFiles.length === 0) {
        this.errorMessage = 'No Streaming_History_Audio_*.json files found in the ZIP. Make sure you uploaded the correct Spotify Extended Streaming History export.';
        this.showError = true;
        return;
      }

      this.logs.push(`Found ${matchingFiles.length} audio history file(s) in ZIP.`);

      let jsonStrings: string[];
      try {
        jsonStrings = await Promise.all(
          matchingFiles.map((name) => zip.files[name].async('string')),
        );
      } catch (e) {
        this.errorMessage = 'Failed to extract files from the ZIP archive.';
        this.errorDetails = (e as Error).message || String(e);
        this.showError = true;
        return;
      }

      let parsedData: SpotifyListen[];
      try {
        parsedData = this.scrobblify.parseMultipleJsonFiles(jsonStrings);
      } catch (e) {
        this.errorMessage = 'Failed to parse the Spotify listening history. The JSON data in the ZIP may be malformed.';
        this.errorDetails = (e as Error).message || String(e);
        this.showError = true;
        return;
      }
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
      if (this.followLfmRules) {
        this.logs.push(`Validating listens against last.fm scrobble rules...`);
        const EXPECTED_MS_PER_REQUEST = 500;
        const expectedTime = newData.length * EXPECTED_MS_PER_REQUEST / 60000;
        this.logs.push(`This requires looking up each track's duration. Estimated time: ~${Math.ceil(expectedTime)} minutes.`);
      } else {
        this.logs.push(`Filtering listens by play time (using estimated track lengths)...`);
      }

      await delay(500);

      let validData: SpotifyListen[] = [];
      try {
        validData = await this.scrobblify.removeInvalidListens(newData, this.smartMoveProgress, !this.followLfmRules);
      } catch (e) {
        this.errorMessage = 'An error occurred while validating your listening history.';
        this.errorDetails = (e as Error).message || String(e);
        this.showError = true;
        return;
      }
      this.logs.push(`Found ${validData.length} valid scrobbles`);

      let toBeScrobbled: SpotifyListen[] = [];

      if (!this.checkDuplicates) {
        toBeScrobbled = validData;
        this.logs.push(`Skipping duplicate check — ${validData.length} tracks ready.`);
      } else {
        // Bulk-fetch Last.fm history and filter duplicates locally
        this.stepProgress = 0;
        this.stepTotal = 1;
        this.logs.push(`Fetching your Last.fm history to check for duplicates...`);
        try {
          const result = await this.scrobblify.filterDuplicates(
            validData,
            (message: string, pagesLoaded: number, totalPages: number) => {
              this.stepProgress = pagesLoaded;
              this.stepTotal = Math.max(totalPages, 1);
              this.logs.splice(this.logs.length - 1, 1, message);
            },
          );
          toBeScrobbled = result.unique;
          this.logs.push(`Found ${result.duplicateCount} duplicates — ${toBeScrobbled.length} new tracks to scrobble.`);
        } catch (e) {
          this.errorMessage = 'An error occurred while checking for duplicates. Proceeding with all tracks.';
          this.errorDetails = (e as Error).message || String(e);
          this.showError = true;
          toBeScrobbled = validData;
        }
      }

      this.logs.push(`Ready to scrobble ${toBeScrobbled.length} tracks.`);
      this.readyToScrobble = true;
      this.$store.commit('setValidScrobbles', toBeScrobbled);
    },
  },
});
</script>
