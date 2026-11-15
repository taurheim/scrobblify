const { execSync } = require('child_process');

// Baked into the bundle (Vue CLI inlines any VUE_APP_* var set at config load)
// so the deployed site can say which commit/CI run it came from. See
// src/buildInfo.ts.
function resolveGitSha() {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) {
    return 'dev';
  }
}

process.env.VUE_APP_GIT_SHA = resolveGitSha().slice(0, 7);
process.env.VUE_APP_BUILD_NUMBER = process.env.GITHUB_RUN_NUMBER || 'local';

module.exports = {
  publicPath: '/scrobblify/',
  outputDir: 'dist',
  transpileDependencies: [
    'vuetify',
  ],
};
