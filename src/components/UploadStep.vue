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
        role="button"
        tabindex="0"
        :class="{ 'drop-zone--active': isDragging }"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="onDrop"
        @click="openFilePicker"
        @keydown.enter="openFilePicker"
        @keydown.space.prevent="openFilePicker"
      >
        <input
          ref="fileInput"
          type="file"
          accept=".zip,.json"
          aria-label="Spotify export ZIP or Scrobblify progress file"
          style="display: none"
          @change="onFileSelected"
        >
        <v-icon large class="mb-2">mdi-cloud-upload</v-icon>
        <div v-if="selectedFileName">
          <strong>{{ selectedFileName }}</strong>
          <div v-if="detecting" class="zip-summary">Checking what's inside…</div>
          <div v-else-if="zipSummary" class="zip-summary">{{ zipSummary }}</div>
        </div>
        <div v-else>
          Drag &amp; drop your Spotify .zip here, or click to browse
          <div class="zip-summary">
            Continuing on another device? Drop your Scrobblify progress file here instead.
          </div>
        </div>
      </div>
      <v-alert v-if="embeddedProgress" type="info" text dense class="mt-2">
        This ZIP also contains a Scrobblify progress file.
        <a role="button" tabindex="0" @click="resumeEmbeddedProgress" @keydown.enter="resumeEmbeddedProgress">
          Resume from it instead
        </a>
      </v-alert>
      <br>
      <v-checkbox
        color="primary"
        v-model="scrobbleOldPlays"
        :label="`Scrobble tracks older than 2 weeks (they will show as listened to today)`"
      ></v-checkbox>
      <v-checkbox
        color="primary"
        v-model="followLfmRules"
        :label="followLfmRulesLabel"
      ></v-checkbox>
      <v-checkbox
        color="primary"
        v-model="checkDuplicates"
        :label="`Check for duplicates (fetches your last.fm history and skips tracks already scrobbled)`"
      ></v-checkbox>
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

.zip-summary {
  font-size: 0.875rem;
  opacity: 0.7;
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
import { trackEvent, trackError } from '@/services/Analytics';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ZipContents {
  historyFiles: string[];
  progressFile: { name: string; baseName: string } | null;
  isAccountData: boolean;
  fileCount: number;
}

/**
 * Works out what a user actually dropped, from file names alone (so it's
 * cheap: JSZip only reads the central directory until an entry is extracted).
 *
 * Patterns are anchored to the *basename*, not the full path. macOS writes an
 * AppleDouble sidecar (`__MACOSX/._<name>`) for every entry when a ZIP is
 * created or re-zipped on a Mac, so an unanchored test matched one extra
 * "history file" per real one — doubling the count, failing every sidecar in
 * JSON.parse, and telling the user half their history was missing when none
 * of it was.
 */
function classifyZip(zip: JSZip): ZipContents {
  const entries = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir)
    .map((name) => ({ name, baseName: name.split('/').pop() || name }));

  return {
    historyFiles: entries
      .filter(({ baseName }) => /^Streaming_History_Audio_.*\.json$/.test(baseName))
      .map(({ name }) => name),
    progressFile: entries.find(({ baseName }) => /^scrobblify-progress.*\.json$/i.test(baseName)) || null,
    // Spotify's default "Account data" export — requested separately from, and
    // delivered before, the extended one, so it's easy to upload by mistake.
    isAccountData: entries.some(({ baseName }) => /^StreamingHistory_?(music|podcast)?_?\d*\.json$/i.test(baseName)),
    fileCount: entries.filter(({ baseName }) => !baseName.startsWith('._')).length,
  };
}

export default Vue.extend({
  components: { 'error-dialog': ErrorDialog },
  data() {
    return {
      followLfmRulesLabel: 'Validate track lengths (filters out tracks shorter than 30s, '
        + 'or played for less than half their duration / 4 minutes)',
      selectedFile: null as File | null,
      selectedFileName: '',
      detecting: false,
      zipSummary: '',
      embeddedProgress: null as File | null,
      selectionId: 0,
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
      return (100 * this.stepProgress) / this.stepTotal;
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
      // Allow picking the same file again after it was rejected.
      input.value = '';
    },
    onDrop(event: DragEvent) {
      this.isDragging = false;
      if (event.dataTransfer && event.dataTransfer.files.length > 0) {
        this.setFile(event.dataTransfer.files[0]);
      }
    },
    resumeEmbeddedProgress() {
      if (this.embeddedProgress) {
        this.$emit('import-progress', this.embeddedProgress, 'zip');
      }
    },
    showUploadError(message: string, details = '') {
      this.errorMessage = message;
      this.errorDetails = details;
      this.showError = true;
    },
    /**
     * Inspects the file the moment it's chosen rather than on "Find tracks", so
     * the wrong kind of file is caught (or routed) before any options are set.
     */
    async setFile(file: File) {
      const name = file.name.toLowerCase();
      // The only .json this site ever hands a user is a progress file, and on
      // a new device (no saved state, so no resume banner) the upload zone is
      // the only place they'll think to put it.
      if (name.endsWith('.json')) {
        this.$emit('import-progress', file, 'file');
        return;
      }
      if (!name.endsWith('.zip')) {
        alert('Please upload your Spotify .zip export, or a Scrobblify progress .json file');
        return;
      }

      this.selectionId += 1;
      const { selectionId } = this;
      this.selectedFile = null;
      this.selectedFileName = file.name;
      this.zipSummary = '';
      this.embeddedProgress = null;
      this.detecting = true;

      let contents: ZipContents;
      let progress: File | null = null;
      let progressError: unknown = null;
      try {
        const zip = await JSZip.loadAsync(file);
        contents = classifyZip(zip);
        if (contents.progressFile) {
          try {
            const blob = await zip.files[contents.progressFile.name].async('blob');
            progress = new File([blob], contents.progressFile.baseName, { type: 'application/json' });
          } catch (e) {
            progressError = e;
            trackError('upload.extractFile', e, { file: contents.progressFile.baseName });
          }
        }
      } catch (e) {
        if (selectionId !== this.selectionId) { return; }
        trackError('upload.loadZip', e);
        this.detecting = false;
        this.selectedFileName = '';
        this.showUploadError(
          'Failed to read the ZIP file. It may be corrupted or not a valid ZIP archive.',
          (e as Error).message || String(e),
        );
        return;
      }
      // A newer selection superseded this one while it was being read.
      if (selectionId !== this.selectionId) { return; }
      this.detecting = false;

      if (contents.historyFiles.length > 0) {
        this.selectedFile = file;
        this.zipSummary = `Spotify Extended Streaming History — ${contents.historyFiles.length} audio history file(s)`;
        this.embeddedProgress = progress;
        return;
      }

      let detected = 'unknown';
      if (contents.progressFile) {
        detected = 'progress_file';
      } else if (contents.isAccountData) {
        detected = 'account_data';
      }
      trackEvent('upload_no_matching_files', { detected, file_count: contents.fileCount });
      this.selectedFileName = '';

      if (progress) {
        this.$emit('import-progress', progress, 'zip');
      } else if (contents.progressFile) {
        this.showUploadError(
          `Found "${contents.progressFile.baseName}" in the ZIP but couldn't read it. Try uploading the .json file directly.`,
          (progressError as Error)?.message || String(progressError),
        );
      } else if (contents.isAccountData) {
        this.showUploadError('This ZIP is Spotify\'s "Account data" export, which doesn\'t contain the detailed history Scrobblify needs. '
          + 'On Spotify\'s privacy page, request "Extended streaming history" instead — it arrives as a separate download '
          + 'containing Streaming_History_Audio_*.json files.');
      } else {
        this.showUploadError('No Streaming_History_Audio_*.json files found in the ZIP. Make sure you uploaded the correct Spotify Extended Streaming History export.');
      }
    },
    async parseSpotifyData() {
      if (!this.selectedFile) { return; }

      trackEvent('upload_parse_started', {
        file_size_bytes: this.selectedFile.size,
        scrobble_old_plays: this.scrobbleOldPlays,
        follow_lfm_rules: this.followLfmRules,
        check_duplicates: this.checkDuplicates,
      });

      const reTagDate = new Date();
      this.logs.push('Reading ZIP file...');
      await delay(100);

      let zip: JSZip;
      try {
        zip = await JSZip.loadAsync(this.selectedFile);
      } catch (e) {
        trackError('upload.loadZip', e);
        this.errorMessage = 'Failed to read the ZIP file. It may be corrupted or not a valid ZIP archive.';
        this.errorDetails = (e as Error).message || String(e);
        this.showError = true;
        return;
      }
      // Already classified on selection; re-reading here only costs the
      // central directory, and keeps a JSZip instance out of reactive data.
      const matchingFiles = classifyZip(zip).historyFiles;

      if (matchingFiles.length === 0) {
        this.logs = [];
        this.showUploadError('No Streaming_History_Audio_*.json files found in the ZIP. Make sure you uploaded the correct Spotify Extended Streaming History export.');
        return;
      }

      this.logs.push(`Found ${matchingFiles.length} audio history file(s) in ZIP.`);

      // Read and parse one file at a time. Large exports can total well over
      // 150MB of decompressed JSON; loading every file into memory at once
      // (Promise.all) can exceed mobile Safari's memory limit and produce a
      // corrupted/zeroed buffer, which then fails JSON.parse with an
      // "Unrecognized token ''" error. Parsing incrementally keeps peak memory
      // low because we only ever hold one raw file string at a time.
      let parsedData: SpotifyListen[] = [];
      const failedFiles: string[] = [];
      for (const name of matchingFiles) {
        const shortName = name.split('/').pop() || name;

        let jsonString: string;
        try {
          jsonString = await zip.files[name].async('string');
        } catch (e) {
          trackError('upload.extractFile', e, { file: shortName });
          failedFiles.push(shortName);
          this.logs.push(`Skipped "${shortName}" — it couldn't be read from the ZIP.`);
          continue;
        }

        try {
          parsedData = parsedData.concat(this.scrobblify.spotifyJsonToListens(jsonString));
        } catch (e) {
          trackError('upload.parseJson', e, { file: shortName });
          failedFiles.push(shortName);
          this.logs.push(`Skipped "${shortName}" — its JSON is malformed or was read incompletely.`);
        }
      }

      // A Spotify export is split across many files, and one of them being
      // unreadable used to abandon the entire import. Salvaging the rest turns
      // a total loss into a partial one; only a complete failure is fatal.
      if (failedFiles.length > 0) {
        trackEvent('upload_files_skipped', {
          skipped_count: failedFiles.length,
          total_files: matchingFiles.length,
        });
      }
      if (failedFiles.length === matchingFiles.length) {
        this.errorMessage = `None of the ${matchingFiles.length} history file(s) in this ZIP could be read. The download may be incomplete — try exporting from Spotify again.`;
        this.errorDetails = `Failed files: ${failedFiles.join(', ')}`;
        this.showError = true;
        return;
      }
      if (failedFiles.length > 0) {
        this.logs.push(`Warning: skipped ${failedFiles.length} of ${matchingFiles.length} file(s) — some of your history is missing from this import.`);
      }
      parsedData.sort((a, b) => a.listenDate.getTime() - b.listenDate.getTime());
      this.logs.push(`Found ${parsedData.length} plays in your spotify listening history.`);

      let newData: SpotifyListen[] = [];
      if (this.scrobbleOldPlays) {
        newData = this.scrobblify.reTagOldListens(parsedData, reTagDate);
        this.logs.push(`No tracks removed - old listens have been moved to today (${reTagDate.toDateString()})`);
      } else {
        newData = this.scrobblify.removeOldListens(parsedData);
        this.logs.push(`Found ${newData.length} tracks that were listened to in the last two weeks`);
      }

      this.stepProgress = 0;
      this.stepTotal = newData.length;
      if (this.followLfmRules) {
        this.logs.push('Validating listens against last.fm scrobble rules...');
        const EXPECTED_MS_PER_REQUEST = 500;
        const expectedTime = (newData.length * EXPECTED_MS_PER_REQUEST) / 60000;
        this.logs.push(`This requires looking up each track's duration. Estimated time: ~${Math.ceil(expectedTime)} minutes.`);
      } else {
        this.logs.push('Filtering listens by play time (using estimated track lengths)...');
      }

      await delay(500);

      let validData: SpotifyListen[] = [];
      try {
        validData = await this.scrobblify.removeInvalidListens(newData, this.smartMoveProgress, !this.followLfmRules);
      } catch (e) {
        trackError('upload.removeInvalidListens', e);
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
        this.logs.push('Fetching your Last.fm history to check for duplicates...');
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
          trackError('upload.filterDuplicates', e);
          this.errorMessage = 'An error occurred while checking for duplicates. Proceeding with all tracks.';
          this.errorDetails = (e as Error).message || String(e);
          this.showError = true;
          toBeScrobbled = validData;
        }
      }

      this.logs.push(`Ready to scrobble ${toBeScrobbled.length} tracks.`);
      this.readyToScrobble = true;
      this.$store.commit('setValidScrobbles', toBeScrobbled);
      trackEvent('upload_parse_completed', {
        total_plays: parsedData.length,
        valid_count: validData.length,
        to_scrobble_count: toBeScrobbled.length,
        checked_duplicates: this.checkDuplicates,
      });
    },
  },
});
</script>
