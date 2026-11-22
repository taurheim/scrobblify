<template>
  <v-dialog v-model="visible" max-width="520" scrollable>
    <v-card class="background-offer">
      <v-card-title>{{ remaining.toLocaleString() }} plays</v-card-title>
      <v-card-text class="pt-2">
        <server-choice
          :count="remaining"
          :show-date-note="anyReTagged"
          :busy="busy"
          @server="$emit('accept')"
          @local="decline"
        />
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import ServerChoice from './ServerChoice.vue';

export default defineComponent({
  name: 'BackgroundOffer',
  components: { ServerChoice },
  props: {
    modelValue: { type: Boolean, default: false },
    remaining: { type: Number, required: true },
    /** True when some remaining tracks had their date rewritten. */
    anyReTagged: { type: Boolean, default: false },
    busy: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'accept', 'decline'],
  computed: {
    visible: {
      get(): boolean { return this.modelValue; },
      set(val: boolean) { this.$emit('update:modelValue', val); },
    },
  },
  methods: {
    /*
      Distinguished from dismissing the dialog by clicking outside it: only a
      deliberate "scrobble locally" is evidence the user read the offer.
    */
    decline() {
      this.visible = false;
      this.$emit('decline');
    },
  },
});
</script>
