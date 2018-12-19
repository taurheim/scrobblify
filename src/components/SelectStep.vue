<template>
  <div>
    Choose which tracks you would like to scrobble:
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
      item-key="time"
      select-all
      hide-actions
      class="elevation-1"
      v-model="selectedTracks"
    >
      <template slot="headerCell" slot-scope="props">
        <v-tooltip bottom>
          <span slot="activator">
            {{ props.header.text }}
          </span>
          <span>
            {{ props.header.text }}
          </span>
        </v-tooltip>
      </template>
      <template slot="items" slot-scope="props">
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
    <v-btn class="primary" @click="scrobbleTracks">Next</v-btn>
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
      return this.$store.state.validScrobbles.map((scrob: SpotifyListen) => {
        return {
          value: false,
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
    scrobbleTracks() {
      this.$store.commit('setSelectedScrobbles', this.selectedTracks.map((track: any) => {
        return new Scrobble(track.track, track.artist, new Date(track.time));
      }));
      this.$emit('complete');
    },
  },
});
</script>
