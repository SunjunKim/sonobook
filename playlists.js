'use strict';

// ---------------------------------------------------------------------------
// Session playlist persistence.
//
// The current working playlist is auto-saved (paths + selected index) so it
// survives a quit/relaunch. Named libraries are NOT stored here — saving and
// loading named playlists is done as real files the user manages (m3u export /
// import, handled in main.js via the OS file dialogs).
//
// Stored as plain file-path arrays; name/kind/artwork are derived at runtime.
// One JSON file in the user-data dir, written debounced + atomically.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const WRITE_DEBOUNCE_MS = 1000;

let filePath = null;
let tmpPath = null;
let data = { v: 1, session: { paths: [], currentIndex: -1 } };
let writeTimer = null;
let dirty = false;

function sanitizePaths(paths) {
  return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : [];
}

function load(userDataDir) {
  filePath = path.join(userDataDir, 'playlists.json');
  tmpPath = filePath + '.tmp';
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const s = parsed && parsed.session;
    data = {
      v: 1,
      session: {
        paths: sanitizePaths(s && s.paths),
        currentIndex: Number.isInteger(s && s.currentIndex) ? s.currentIndex : -1
      }
    };
  } catch (_) {
    data = { v: 1, session: { paths: [], currentIndex: -1 } };
  }
  return data;
}

function getSession() {
  return data.session;
}

function setSession(paths, currentIndex) {
  data.session = {
    paths: sanitizePaths(paths),
    currentIndex: Number.isInteger(currentIndex) ? currentIndex : -1
  };
  markDirty();
}

// --- atomic, debounced writes ---
function markDirty() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; writeNow(); }, WRITE_DEBOUNCE_MS);
  if (writeTimer.unref) writeTimer.unref();
}

function writeNow() {
  if (!dirty || !filePath) return;
  dirty = false;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, filePath);
  } catch (_) {
    dirty = true;
  }
}

function flush() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  writeNow();
}

module.exports = { load, flush, getSession, setSession };
