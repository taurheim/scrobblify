import { createApp } from 'vue';
import {
  initAnalytics, registerGlobalErrorHandlers, trackError, trackPageView,
} from '@/services/Analytics';
import { installChunkReload } from '@/services/ChunkReload';
import vuetify from './plugins/vuetify';
import App from './App.vue';
import router from './router';
import store from './store';

initAnalytics();
registerGlobalErrorHandlers();

const app = createApp(App);

// Capture uncaught errors thrown inside Vue components/lifecycle hooks.
app.config.errorHandler = (err, vm, info) => {
  trackError('vue.errorHandler', err, { info });
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.error(err);
  }
};

// SPA page-view tracking (autocapture is disabled).
router.afterEach((to) => {
  trackPageView(to.fullPath);
});

installChunkReload(router);

app.use(router);
app.use(store);
app.use(vuetify);
app.mount('#app');
