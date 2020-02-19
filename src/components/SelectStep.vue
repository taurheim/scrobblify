<template>
  <div>
    Choose which tracks you would like to scrobble: <br/>
    <v-btn class="primary" @click="scrobbleAllTracks">Just scrobble everything!</v-btn>
    <v-card>
      <v-card-title>
        <v-text-field
          v-model="search"
          append-icon="search"
          label="Search"
          single-line
          hide-details
        ></v-text-field>
      </v-card-title>
    </v-card>
    <v-data-table
      :headers="headers"
      :items="allScrobbleableTracks"
      :search="search"
      show-select
      class="elevation-1"
      item-key="id"
      v-model="selectedTracks"
    >
      <template v-slot:items="props">
        <td>
          <v-checkbox
            v-model="props.selected"
            primary
            hide-details
          ></v-checkbox>
        </td>
        <td>{{ props.item.track }}</td>
        <td>{{ props.item.artist }}</td>
        <td>{{ prettyDate(new Date(props.item.time)).toLocaleString() }}</td>
      </template>
    </v-data-table>
    <v-btn class="primary" @click="scrobbleSelectedTracks">Scrobble selected tracks</v-btn>
  </div>
</template>
<style>

</style>
<script lang="ts">
import Vue from 'vue';
import Scrobble from '@/models/Scrobble';
import SpotifyListen from '@/models/SpotifyListen';

export default Vue.extend({
  data() {
    return {
      search: '',
      selectedTracks: [],
      headers: [
        {
          text: 'Track title',
          value: 'track',
        },
        {
          text: 'Artist',
          value: 'artist',
        },
        {
          text: 'Date',
          value: 'time',
        },
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
          time: scrob.listenDate.getTime(),
        };
      });
    },
  },
  methods: {
    prettyDate(date: Date) {
      return date.toString();
    },
    scrobbleSelectedTracks() {
      this.commitTracksToStore(this.selectedTracks);
      this.$emit('complete');
    },
    scrobbleAllTracks() {
      this.commitTracksToStore(this.allScrobbleableTracks);
      this.$emit('complete');
    },
    commitTracksToStore(tracks: any[]) {
      this.$store.commit('setSelectedScrobbles', tracks.map((track: any) => {
        return new Scrobble(track.track, track.artist, new Date(track.time));
      }));
    },
  },
});
</script>
