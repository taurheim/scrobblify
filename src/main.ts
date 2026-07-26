import Vue from 'vue';
import {
  initAnalytics, registerGlobalErrorHandlers, trackError, trackPageView,
} from '@/services/Analytics';
import vuetify from './plugins/vuetify';
import App from './App.vue';
import router from './router';
import store from './store';

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
