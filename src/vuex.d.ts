import { Store } from 'vuex';
import type { RootState } from './store';

// Vuex 4 no longer types `this.$store` on its own.
declare module 'vue' {
  interface ComponentCustomProperties {
    $store: Store<RootState>;
  }
}
