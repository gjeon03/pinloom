// Single source of truth for the build staging location, shared by stage.mjs
// and electron-builder.config.cjs.
//
// CRITICAL: stage OUTSIDE the repo tree. electron-rebuild walks UP from the
// module dir to find the "project root" and rebuilds EVERY native module it
// discovers along the way. If staging lived under the repo, that walk-up reaches
// the workspace's shared node_modules and rebuilds the developer's better-sqlite3
// for Electron's ABI — which crashes the running Node backend on its next
// restart (NODE_MODULE_VERSION mismatch). An out-of-repo path has no workspace
// above it, so the rebuild can only ever touch the staged copies.
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const STAGING = join(tmpdir(), 'pinloom-desktop-stage');
const STAGED_BACKEND = join(STAGING, 'app-backend');
const STAGED_FRONTEND = join(STAGING, 'app-frontend');

module.exports = { STAGING, STAGED_BACKEND, STAGED_FRONTEND };
