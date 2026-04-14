<template>
  <div>
    <h3>Choose which tracks to scrobble</h3>
    <p v-if="dataMinDate && dataMaxDate" class="caption grey--text">
      Your data spans {{ dataMinDate }} to {{ dataMaxDate }}
    </p>

    <v-row align="center" class="mb-2">
      <v-col cols="12" sm="4">
        <v-text-field
          v-model="search"
          append-icon="mdi-magnify"
          label="Search by track, artist, or album"
          single-line
          hide-details
          clearable
        ></v-text-field>
      </v-col>
      <v-col cols="6" sm="3">
        <label class="caption grey--text">From date</label>
        <input
          type="date"
          v-model="fromDate"
          :min="dataMinDate"
          :max="dataMaxDate"
          class="date-input"
        />
      </v-col>
      <v-col cols="6" sm="3">
        <label class="caption grey--text">To date</label>
        <input
          type="date"
          v-model="toDate"
          :min="dataMinDate"
          :max="dataMaxDate"
          class="date-input"
        />
      </v-col>
    </v-row>

    <v-row align="center" class="mb-2">
      <v-col>
        <strong>{{ selectedTracks.length }}</strong> of {{ allScrobbleableTracks.length }} tracks selected to scrobble
      </v-col>
      <v-col cols="auto" class="text-center">
        <v-btn color="primary" @click="addMatchingTracks" :disabled="filteredTracks.length === 0">
          Add {{ filteredTracks.length }} matching
        </v-btn>
      </v-col>
      <v-col>
      </v-col>
    </v-row>

    <v-data-table
      :headers="headers"
      :items="filteredTracks"
      show-select
      class="elevation-1"
      item-key="id"
      v-model="selectedTracks"
      :items-per-page="25"
      :footer-props="{ 'items-per-page-options': [10, 25, 50, 100, -1] }"
    >
      <template v-slot:item.time="{ item }">
        {{ formatDate(item.time) }}
      </template>
    </v-data-table>

    <div class="mt-3">
      <v-btn color="primary" @click="scrobbleSelectedTracks" :disabled="selectedTracks.length === 0">
        Scrobble {{ selectedTracks.length }} selected tracks
      </v-btn>
    </div>
  </div>
</template>
<style scoped>
.date-input {
  width: 100%;
  padding: 8px 4px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.42);
  background: transparent;
  font-size: 14px;
  outline: none;
}
.date-input:focus {
  border-bottom: 2px solid #1976d2;
}
</style>
<script lang="ts">
import Vue from 'vue';
import Scrobble from '@/models/Scrobble';
import SpotifyListen from '@/models/SpotifyListen';

export default Vue.extend({
  data() {
    return {
      search: '',
      selectedTracks: [] as any[],
      fromDate: '',
      toDate: '',
      headers: [
        { text: 'Track', value: 'track' },
        { text: 'Artist', value: 'artist' },
        { text: 'Album', value: 'album' },
        { text: 'Date', value: 'time' },
      ],
    };
  },
  computed: {
    allScrobbleableTracks(): any[] {
      return this.$store.state.validScrobbles.map((scrob: SpotifyListen, i: number) => {
        return {
          value: false,
          id: i,
          track: scrob.trackName,
          artist: scrob.artistName,
          album: scrob.albumName,
          time: scrob.listenDate.getTime(),
        };
      });
    },
    dataMinDate(): string {
      const tracks = this.allScrobbleableTracks;
      if (tracks.length === 0) { return ''; }
      const min = Math.min(...tracks.map((t: any) => t.time));
      return new Date(min).toISOString().slice(0, 10);
    },
    dataMaxDate(): string {
      const tracks = this.allScrobbleableTracks;
      if (tracks.length === 0) { return ''; }
      const max = Math.max(...tracks.map((t: any) => t.time));
      return new Date(max).toISOString().slice(0, 10);
    },
    filteredTracks(): any[] {
      let tracks = this.allScrobbleableTracks;

      if (this.fromDate) {
        const from = new Date(this.fromDate).getTime();
        tracks = tracks.filter((t: any) => t.time >= from);
      }
      if (this.toDate) {
        // Include the entire "to" day
        const to = new Date(this.toDate).getTime() + 86400000;
        tracks = tracks.filter((t: any) => t.time < to);
      }
      if (this.search) {
        const q = this.search.toLowerCase();
        tracks = tracks.filter((t: any) =>
          t.track.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q),
        );
      }

      return tracks;
    },
  },
  methods: {
    formatDate(timestamp: number): string {
      return new Date(timestamp).toLocaleString();
    },
    addMatchingTracks() {
      const existingIds = new Set(this.selectedTracks.map((t: any) => t.id));
      const toAdd = this.filteredTracks.filter((t: any) => !existingIds.has(t.id));
      this.selectedTracks = [...this.selectedTracks, ...toAdd];
    },
    scrobbleSelectedTracks() {
      this.$store.commit('setSelectedScrobbles', this.selectedTracks.map((track: any) => {
        return new Scrobble(track.track, track.artist, new Date(track.time), track.album);
      }));
      this.$emit('complete');
    },
  },
});
</script>
