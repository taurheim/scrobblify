<template>
  <div class="select-step">
    <h3>Choose which tracks to scrobble</h3>
    <p v-if="dataMinDate && dataMaxDate" class="caption grey--text mb-4">
      Your data spans {{ dataMinDate }} to {{ dataMaxDate }}
    </p>

    <!-- Filter panel -->
    <v-card outlined class="mb-4 filter-panel">
      <v-card-text class="pb-2 pt-3">
        <div class="overline grey--text text--darken-1 mb-2">
          <v-icon small class="mr-1">mdi-filter-outline</v-icon>Filter tracks
        </div>
        <v-row align="center" dense>
          <v-col cols="12" sm="4">
            <v-text-field
              :value="search"
              @input="onSearchInput"
              append-icon="mdi-magnify"
              label="Search by track, artist, or album"
              single-line
              hide-details
              clearable
              outlined
              dense
            ></v-text-field>
          </v-col>
          <v-col cols="6" sm="3">
            <v-text-field
              v-model="fromDate"
              label="From date"
              type="date"
              :min="dataMinDate"
              :max="dataMaxDate"
              hide-details
              outlined
              dense
            ></v-text-field>
          </v-col>
          <v-col cols="6" sm="3">
            <v-text-field
              v-model="toDate"
              label="To date"
              type="date"
              :min="dataMinDate"
              :max="dataMaxDate"
              hide-details
              outlined
              dense
            ></v-text-field>
          </v-col>
          <v-col cols="12" sm="2" class="d-flex align-center justify-center">
            <v-checkbox
              v-model="showSelectedOnly"
              label="Selected only"
              hide-details
              dense
              class="mt-0 pt-0"
            ></v-checkbox>
          </v-col>
        </v-row>

        <!-- Matching info + bulk-add action -->
        <v-divider class="mt-3 mb-2"></v-divider>
        <div class="d-flex align-center justify-space-between flex-wrap">
          <span class="body-2 grey--text text--darken-2">
            Showing <strong>{{ filteredCount }}</strong> matching tracks
          </span>
          <v-btn
            small
            color="primary"
            outlined
            @click="addMatchingTracks"
            :disabled="filteredCount === 0"
          >
            <v-icon small left>mdi-plus</v-icon>
            Add {{ filteredCount }} matching to selection
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- Data table (server-side pagination for performance) -->
    <v-data-table
      :headers="headers"
      :items="pageItems"
      :server-items-length="filteredCount"
      show-select
      class="elevation-1"
      item-key="id"
      :value="pageSelectedItems"
      @input="onTableSelectionChange"
      :options.sync="tableOptions"
      :footer-props="{ 'items-per-page-options': [10, 25, 50, 100] }"
    >
      <template v-slot:header.data-table-select>
        <v-simple-checkbox
          :value="isPageAllSelected"
          :indeterminate="isPageSomeSelected && !isPageAllSelected"
          @input="togglePageSelectAll"
        ></v-simple-checkbox>
      </template>
      <template v-slot:item.data-table-select="{ item }">
        <v-simple-checkbox
          :value="selectedIds.has(item.id)"
          @input="toggleTrackSelection(item)"
        ></v-simple-checkbox>
      </template>
      <template v-slot:item.originalTime="{ item }">
        {{ formatDate(item.originalTime) }}
      </template>
      <template v-slot:item.time="{ item }">
        {{ formatDate(item.time) }}
      </template>
    </v-data-table>

    <!-- Bottom action bar -->
    <v-card outlined class="mt-4 scrobble-action-bar">
      <v-card-text class="d-flex align-center justify-space-between py-3">
        <span class="body-1">
          <v-icon small class="mr-1" :color="selectedCount > 0 ? 'success' : 'grey'">
            {{ selectedCount > 0 ? 'mdi-check-circle' : 'mdi-circle-outline' }}
          </v-icon>
          <strong>{{ selectedCount }}</strong> of {{ totalTrackCount }} tracks selected
        </span>
        <v-btn
          color="primary"
          @click="scrobbleSelectedTracks"
          :disabled="selectedCount === 0"
        >
          <v-icon left>mdi-music-note</v-icon>
          Scrobble {{ selectedCount }} selected tracks
        </v-btn>
      </v-card-text>
    </v-card>
  </div>
</template>
<style scoped>
.select-step {
  text-align: left;
}
.filter-panel {
  border-color: #e0e0e0 !important;
  background-color: #fafafa !important;
}
.scrobble-action-bar {
  border-color: #e0e0e0 !important;
  position: sticky;
  bottom: 0;
  background: white !important;
  z-index: 2;
}
</style>
<script lang="ts">
import Vue from 'vue';
import Scrobble from '@/models/Scrobble';
import SpotifyListen from '@/models/SpotifyListen';

const workerCode = `
  let count = 0;
  let ids = null;
  let trackStr = '';
  let artistStr = '';
  let albumStr = '';
  let offsets = null;

  self.onmessage = function(e) {
    const msg = e.data;
    if (msg.type === 'setData') {
      count = msg.count;
      ids = new Int32Array(msg.ids);
      trackStr = msg.trackStr;
      artistStr = msg.artistStr;
      albumStr = msg.albumStr;
      offsets = new Int32Array(msg.offsets);
    } else if (msg.type === 'search') {
      const q = msg.query.toLowerCase();
      const result = new Int32Array(count);
      let len = 0;
      for (let i = 0; i < count; i++) {
        const o = i * 2;
        const s = offsets[o], e = offsets[o + 1];
        if (trackStr.substring(s, e).includes(q) ||
            artistStr.substring(s, e).includes(q) ||
            albumStr.substring(s, e).includes(q)) {
          result[len++] = ids[i];
        }
      }
      const trimmed = result.slice(0, len);
      self.postMessage({ type: 'searchResult', ids: trimmed.buffer, query: msg.query }, [trimmed.buffer]);
    }
  };
`;

function createSearchWorker(): Worker | null {
  try {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    return worker;
  } catch {
    return null;
  }
}

export default Vue.extend({
  data() {
    return {
      search: '',
      fromDate: '',
      toDate: '',
      showSelectedOnly: false,
      searchWorker: null as Worker | null,
      debounceTimer: 0,
      // Reactive counters — cheap to update, trigger template re-render
      selectedCount: 0,
      totalTrackCount: 0,
      filteredCount: 0,
      // Version counter to trigger computed re-evaluation
      trackVersion: 0,
      filterVersion: 0,
      // Search version bumped when search results arrive
      searchVersion: 0,
      tableOptions: { page: 1, itemsPerPage: 25 } as any,
      headers: [
        { text: 'Track', value: 'track', sortable: false },
        { text: 'Artist', value: 'artist', sortable: false },
        { text: 'Album', value: 'album', sortable: false },
        { text: 'Date Listened', value: 'originalTime', sortable: false },
        { text: 'Date to scrobble', value: 'time', sortable: false },
      ],
    };
  },
  created() {
    // Non-reactive storage for large arrays
    (this as any)._tracks = [] as any[];
    (this as any)._filteredIndices = [] as number[];
    (this as any)._selectedIds = new Set<number>();
    (this as any)._searchMatchIds = null as Set<number> | null;

    this.searchWorker = createSearchWorker();
    if (this.searchWorker) {
      this.searchWorker.onmessage = (e: MessageEvent) => {
        const msg = e.data;
        if (msg.type === 'searchResult') {
          if (msg.query === this.search) {
            (this as any)._searchMatchIds = new Set(new Int32Array(msg.ids));
            this.rebuildFilteredIndices();
          }
        }
      };
    }
  },
  beforeDestroy() {
    if (this.searchWorker) {
      this.searchWorker.terminate();
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  },
  watch: {
    '$store.state.validScrobbles': {
      immediate: true,
      handler(scrobbles: SpotifyListen[]) {
        if (!scrobbles || scrobbles.length === 0) { return; }
        const tracks: any[] = scrobbles.map((scrob: SpotifyListen, i: number) => ({
          value: false,
          id: i,
          track: scrob.trackName,
          artist: scrob.artistName,
          album: scrob.albumName,
          time: scrob.listenDate.getTime(),
          originalTime: scrob.originalListenDate.getTime(),
          trackLower: scrob.trackName.toLowerCase(),
          artistLower: scrob.artistName.toLowerCase(),
          albumLower: scrob.albumName.toLowerCase(),
        }));
        (this as any)._tracks = tracks;
        this.totalTrackCount = tracks.length;
        this.trackVersion++;
        this.rebuildFilteredIndices();
        this.initWorkerData(tracks);
      },
    },
    fromDate() {
      this.rebuildFilteredIndices();
    },
    toDate() {
      this.rebuildFilteredIndices();
    },
    showSelectedOnly() {
      this.rebuildFilteredIndices();
    },
  },
  computed: {
    selectedIds(): Set<number> {
      // Access filterVersion just to create a reactive dependency for template
      // eslint-disable-next-line no-unused-expressions
      this.filterVersion;
      return (this as any)._selectedIds;
    },
    dataMinDate(): string {
      // eslint-disable-next-line no-unused-expressions
      this.trackVersion;
      const tracks = (this as any)._tracks;
      if (!tracks || tracks.length === 0) { return ''; }
      let min = tracks[0].originalTime;
      for (let i = 1; i < tracks.length; i++) {
        if (tracks[i].originalTime < min) { min = tracks[i].originalTime; }
      }
      return new Date(min).toISOString().slice(0, 10);
    },
    dataMaxDate(): string {
      // eslint-disable-next-line no-unused-expressions
      this.trackVersion;
      const tracks = (this as any)._tracks;
      if (!tracks || tracks.length === 0) { return ''; }
      let max = tracks[0].originalTime;
      for (let i = 1; i < tracks.length; i++) {
        if (tracks[i].originalTime > max) { max = tracks[i].originalTime; }
      }
      return new Date(max).toISOString().slice(0, 10);
    },
    pageItems(): any[] {
      // eslint-disable-next-line no-unused-expressions
      this.filterVersion;
      const indices = (this as any)._filteredIndices as number[];
      const tracks = (this as any)._tracks as any[];
      const { page, itemsPerPage } = this.tableOptions;
      const start = (page - 1) * itemsPerPage;
      const end = start + itemsPerPage;
      return indices.slice(start, end).map((idx: number) => tracks[idx]);
    },
    pageSelectedItems(): any[] {
      // eslint-disable-next-line no-unused-expressions
      this.filterVersion;
      const selIds = (this as any)._selectedIds as Set<number>;
      return this.pageItems.filter((item: any) => selIds.has(item.id));
    },
    isPageAllSelected(): boolean {
      const items = this.pageItems;
      if (items.length === 0) { return false; }
      const selIds = (this as any)._selectedIds as Set<number>;
      return items.every((item: any) => selIds.has(item.id));
    },
    isPageSomeSelected(): boolean {
      const selIds = (this as any)._selectedIds as Set<number>;
      return this.pageItems.some((item: any) => selIds.has(item.id));
    },
  },
  methods: {
    rebuildFilteredIndices() {
      const tracks = (this as any)._tracks as any[];
      if (!tracks || tracks.length === 0) {
        (this as any)._filteredIndices = [];
        this.filteredCount = 0;
        this.filterVersion++;
        return;
      }

      const hasFrom = !!this.fromDate;
      const hasTo = !!this.toDate;
      const fromTs = hasFrom ? new Date(this.fromDate).getTime() : 0;
      const toTs = hasTo ? new Date(this.toDate).getTime() + 86400000 : 0;
      const searchIds = (this as any)._searchMatchIds as Set<number> | null;
      const showSelected = this.showSelectedOnly;
      const selIds = (this as any)._selectedIds as Set<number>;

      const result: number[] = [];
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (hasFrom && t.originalTime < fromTs) { continue; }
        if (hasTo && t.originalTime >= toTs) { continue; }
        if (searchIds !== null && !searchIds.has(t.id)) { continue; }
        if (showSelected && !selIds.has(t.id)) { continue; }
        result.push(i);
      }

      (this as any)._filteredIndices = result;
      this.filteredCount = result.length;
      // Reset to page 1 when filters change
      if (this.tableOptions.page !== 1) {
        this.tableOptions.page = 1;
      }
      this.filterVersion++;
    },
    initWorkerData(tracks: any[]) {
      if (!this.searchWorker) { return; }
      const n = tracks.length;
      const ids = new Int32Array(n);
      const offsets = new Int32Array(n * 2);
      const trackParts: string[] = [];
      const artistParts: string[] = [];
      const albumParts: string[] = [];
      let pos = 0;
      for (let i = 0; i < n; i++) {
        const t = tracks[i];
        ids[i] = t.id;
        const len = Math.max(t.trackLower.length, t.artistLower.length, t.albumLower.length);
        offsets[i * 2] = pos;
        offsets[i * 2 + 1] = pos + len;
        trackParts.push(t.trackLower.padEnd(len, '\0'));
        artistParts.push(t.artistLower.padEnd(len, '\0'));
        albumParts.push(t.albumLower.padEnd(len, '\0'));
        pos += len;
      }
      this.searchWorker.postMessage({
        type: 'setData',
        count: n,
        ids: ids.buffer,
        trackStr: trackParts.join(''),
        artistStr: artistParts.join(''),
        albumStr: albumParts.join(''),
        offsets: offsets.buffer,
      }, [ids.buffer, offsets.buffer]);
    },
    onSearchInput(val: string | null) {
      const query = val || '';
      if (!query) {
        this.search = '';
        (this as any)._searchMatchIds = null;
        this.rebuildFilteredIndices();
        return;
      }
      this.search = query;
      if (this.searchWorker) {
        this.searchWorker.postMessage({ type: 'search', query });
      } else {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = window.setTimeout(() => {
          const q = query.toLowerCase();
          const ids = new Set<number>();
          const tracks = (this as any)._tracks as any[];
          for (const t of tracks) {
            if (t.trackLower.includes(q) || t.artistLower.includes(q) || t.albumLower.includes(q)) {
              ids.add(t.id);
            }
          }
          (this as any)._searchMatchIds = ids;
          this.rebuildFilteredIndices();
        }, 100);
      }
    },
    formatDate(timestamp: number): string {
      return new Date(timestamp).toLocaleString();
    },
    toggleTrackSelection(item: any) {
      const selIds = (this as any)._selectedIds as Set<number>;
      if (selIds.has(item.id)) {
        selIds.delete(item.id);
      } else {
        selIds.add(item.id);
      }
      this.selectedCount = selIds.size;
      this.filterVersion++;
    },
    togglePageSelectAll(checked: boolean) {
      const selIds = (this as any)._selectedIds as Set<number>;
      for (const item of this.pageItems) {
        if (checked) {
          selIds.add(item.id);
        } else {
          selIds.delete(item.id);
        }
      }
      this.selectedCount = selIds.size;
      this.filterVersion++;
    },
    onTableSelectionChange(selected: any[]) {
      // Handle Vuetify's built-in selection events
      const selIds = (this as any)._selectedIds as Set<number>;
      const pageIds = new Set(this.pageItems.map((item: any) => item.id));
      // Remove all page items from selection, then add back the ones selected
      for (const id of pageIds) {
        selIds.delete(id);
      }
      for (const item of selected) {
        selIds.add(item.id);
      }
      this.selectedCount = selIds.size;
      this.filterVersion++;
    },
    addMatchingTracks() {
      const selIds = (this as any)._selectedIds as Set<number>;
      const tracks = (this as any)._tracks as any[];
      const indices = (this as any)._filteredIndices as number[];
      for (const idx of indices) {
        selIds.add(tracks[idx].id);
      }
      this.selectedCount = selIds.size;
      this.filterVersion++;
    },
    scrobbleSelectedTracks() {
      const selIds = (this as any)._selectedIds as Set<number>;
      const tracks = (this as any)._tracks as any[];
      const selected = tracks.filter((t: any) => selIds.has(t.id));
      this.$store.commit('setSelectedScrobbles', selected.map((track: any) => {
        return new Scrobble(track.track, track.artist, new Date(track.time), track.album);
      }));
      this.$emit('complete');
    },
  },
});
</script>
