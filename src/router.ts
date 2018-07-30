import Vue from 'vue';
import Router from 'vue-router';
import Home from './views/Home.vue';
import ScrobbleVue from './views/Scrobble.vue';

Vue.use(Router);
export default new Router({
  // For some reason, recursive sock.js issues if I don't do this
  mode: (process.env.NODE_ENV === 'production') ? 'history' : 'hash',
  base: (process.env.NODE_ENV === 'production') ? '/scrobblify/' : '/',
  routes: [
    {
      path: '/',
      name: 'home',
      component: Home,
    },
    {
      path: '/scrobble',
      name: 'scrobble',
      component: ScrobbleVue,
    },
    {
      path: '/about',
      name: 'about',
      // route level code-splitting
      // this generates a separate chunk (about.[hash].js) for this route
      // which is lazy-loaded when the route is visited.
      component: () => import(/* webpackChunkName: "about" */ './views/About.vue'),
    },
  ],
});
