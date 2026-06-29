// electron-builder config. In a .cjs file (not package.json "build") so the
// extraResources paths can point at the OUT-OF-REPO staging dir — see
// staging-path.cjs for why staging must live outside the workspace.
const { STAGED_BACKEND, STAGED_FRONTEND } = require('./staging-path.cjs');

module.exports = {
  appId: 'io.pinloom.desktop',
  productName: 'pinloom',
  // Native modules are pre-rebuilt for Electron's ABI in the staged copy
  // (stage.mjs); builder must NOT rebuild anything itself.
  npmRebuild: false,
  directories: {
    output: 'dist-app',
    buildResources: 'build',
  },
  files: ['main.cjs', 'preload.cjs', 'loading.html', 'package.json', 'tray-icon.png', 'tray-icon@2x.png'],
  extraResources: [
    { from: STAGED_BACKEND, to: 'app-backend' },
    { from: STAGED_FRONTEND, to: 'app-frontend' },
  ],
  mac: {
    target: 'dmg',
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
  },
  dmg: { title: 'pinloom' },
};
