// Vuetify's documented stylesheet entry; its package `exports` map it to CSS.
// eslint-disable-next-line import/extensions
import 'vuetify/styles';
import { createVuetify } from 'vuetify';

export default createVuetify({
  // Vuetify 4 buttons are sentence case; keep the uppercase labels of 2 and 3.
  defaults: {
    VBtn: { class: 'text-uppercase' },
  },
  theme: {
    // Vuetify 4 follows the OS by default, and only the light theme is styled.
    defaultTheme: 'light',
    themes: {
      light: {
        colors: {
          primary: '#ED1C24',
          secondary: '#424242',
          accent: '#82B1FF',
          error: '#FF5252',
          info: '#2196F3',
          success: '#4CAF50',
          warning: '#FFC107',
        },
      },
    },
  },
});
