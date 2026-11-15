module.exports = {
  root: true,
  env: {
    node: true,
    browser: true,
  },
  extends: [
    'plugin:vue/vue3-essential',
    '@vue/airbnb',
    '@vue/typescript/recommended',
  ],
  parserOptions: {
    ecmaVersion: 2020,
  },
  rules: {
    'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
    'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',

    // Git normalizes EOLs on checkout, so working copies are CRLF on Windows
    // and LF elsewhere. Enforcing either one breaks lint on half the machines.
    'linebreak-style': 'off',

    'max-len': ['error', {
      code: 120,
      ignoreUrls: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true,
      ignoreRegExpLiterals: true,
    }],

    // SelectStep, ScrobbleStep and Scrobblify keep large or deliberately
    // non-reactive state (track arrays, the rate-limit tracker, the save queue)
    // as `_`-prefixed properties assigned straight onto the instance, outside
    // data(). Vue never makes those reactive, and Vue 3 refuses to proxy
    // `_`-prefixed data() keys at all, so the prefix marks that state as
    // intentionally off-reactivity. Moving it into data() would make every
    // element reactive and tank performance on big histories.
    'no-underscore-dangle': 'off',

    // Scrobbling is intentionally sequential: Last.fm rate-limits aggressively
    // and each request must settle (and its backoff elapse) before the next.
    'no-await-in-loop': 'off',

    // `new Promise((r) => setTimeout(r, ms))` is the sleep idiom used for
    // rate-limit backoff throughout the Last.fm client.
    'no-promise-executor-return': 'off',

    'no-plusplus': 'off',
    'no-continue': 'off',
    'class-methods-use-this': 'off',

    // airbnb bans for..of wholesale; it is used throughout for readable
    // iteration. The genuinely hazardous constructs stay banned.
    'no-restricted-syntax': ['error', 'ForInStatement', 'LabeledStatement', 'WithStatement'],

    // The base rule flags TypeScript parameter properties as useless
    // constructors; the TS-aware version understands they declare fields.
    'no-useless-constructor': 'off',
    '@typescript-eslint/no-useless-constructor': 'error',

    // Views are legitimately single-word (Home, About, Scrobble, Scrobblify).
    'vue/multi-word-component-names': 'off',

    // Vuetify data tables address slots with dotted names (`item.artist`),
    // which the rule reads as modifiers.
    'vue/valid-v-slot': ['error', { allowModifiers: true }],
  },
  overrides: [
    {
      // Playwright specs and the dev-mock harness run in Node, not the browser,
      // and legitimately import from devDependencies.
      files: ['tests/**/*.{js,ts}', '*.config.{js,ts}', '.eslintrc.js'],
      rules: {
        'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      },
    },
  ],
};
