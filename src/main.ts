import Vue from 'vue';
import './plugins/vuetify.ts';
import App from './App.vue';
import router from './router';
import store from './store';
import vuetify from './plugins/vuetify';
import { initAnalytics, registerGlobalErrorHandlers, trackError, trackPageView } from '@/services/Analytics';

Vue.config.productionTip = false;

initAnalytics();
registerGlobalErrorHandlers();

// Capture uncaught errors thrown inside Vue components/lifecycle hooks.
Vue.config.errorHandler = (err, vm, info) => {
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

new Vue({
  router,
  store,
  vuetify,
  render: (h) => h(App),
}).$mount('#app');
