'use strict';

// ---------------------------------------------------------------------------
// Content-addressed "last played position" store.
//
// One small JSON file in the user-data directory. The whole map is loaded once
// into memory; the renderer keeps an authoritative copy, so reads never touch
// disk. Writes are debounced and atomic (tmp + rename) so a crash mid-write
// can't corrupt the file.
//
// Record schema (size-optimized — see the plan):
//   audio:  items["a1:<hash>"] = { p:<sec int>, d:<sec int|null>, u:<epoch sec> }
//   zip:    items["z1:<hash>"] = { i:<entryIndex>, u:<epoch sec>,
//                                  e:{ "<idx>":[<pos sec>,<dur sec|null>], ... } }
// `e` is sparse (only chapters that were actually played) and keyed by the
// chapter's index in the natural-sorted audio-entry list.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const WRITE_DEBOUNCE_MS = 1500;
const MAX_AGE_DAYS = 365;
const MAX_RECORDS = 5000;
const MIN_SAVE_SEC = 5; // don't persist barely-touched files

let dbPath = null;
let tmpPath = null;
let data = { v: 1, items: {} };
let writeTimer = null;
let dirty = false;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// Drop stale records and cap the total count to the most-recently-updated.
function prune() {
  const items = data.items;
  const cutoff = nowSec() - MAX_AGE_DAYS * 86400;
  for (const fp of Object.keys(items)) {
    const u = items[fp] && items[fp].u;
    if (!u || u < cutoff) delete items[fp];
  }
  const keys = Object.keys(items);
  if (keys.length > MAX_RECORDS) {
    keys.sort((a, b) => (items[b].u || 0) - (items[a].u || 0));
    for (const fp of keys.slice(MAX_RECORDS)) delete items[fp];
  }
}

// Read + parse once. Never throws — a missing or corrupt file starts fresh.
function load(userDataDir) {
  dbPath = path.join(userDataDir, 'progress.json');
  tmpPath = dbPath + '.tmp';
  try {
    const raw = fs.readFileSync(dbPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.items) {
      data = { v: 1, items: parsed.items };
    }
  } catch (_) {
    data = { v: 1, items: {} };
  }
  prune();
  return data;
}

function getAll() {
  return data;
}

// Merge a partial record into items[fp]. Skips trivially-touched files so they
// don't accumulate as records (unless the record marks completion).
function put(fp, rec) {
  if (!fp || !rec || typeof rec !== 'object') return;

  const isComplete = rec._complete === true;
  delete rec._complete;

  // Determine the furthest position + whether the record carries a duration
  // (probed/measured), to gate trivial saves. Duration-bearing records are kept
  // even at position 0 so cached running times survive a relaunch.
  let maxPos = typeof rec.p === 'number' ? rec.p : 0;
  let hasDuration = typeof rec.d === 'number' && rec.d > 0;
  if (rec.e) {
    for (const k of Object.keys(rec.e)) {
      const t = rec.e[k];
      if (Array.isArray(t)) {
        if (t[0] > maxPos) maxPos = t[0];
        if (t[1] > 0) hasDuration = true;
      }
    }
  }
  const existed = !!data.items[fp];
  if (!existed && !isComplete && !hasDuration && maxPos < MIN_SAVE_SEC) return;

  const cur = data.items[fp] || {};
  const next = Object.assign({}, cur, rec);
  // Deep-merge the sparse per-chapter map so old chapters survive.
  if (rec.e) next.e = Object.assign({}, cur.e, rec.e);
  next.u = nowSec();
  data.items[fp] = next;

  dirty = true;
  schedule();
}

function schedule() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeNow();
  }, WRITE_DEBOUNCE_MS);
  if (writeTimer.unref) writeTimer.unref();
}

// Atomic write: serialize to a tmp file, then rename over the real one.
function writeNow() {
  if (!dirty || !dbPath) return;
  dirty = false;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, dbPath);
  } catch (_) {
    dirty = true; // try again on the next flush/schedule
  }
}

// Force a synchronous write (called on quit).
function flush() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  writeNow();
}

// Zero the listened position of every record, keeping cached durations.
function resetAllPositions() {
  for (const fp of Object.keys(data.items)) {
    const it = data.items[fp];
    if (typeof it.p === 'number') it.p = 0;
    if (typeof it.i === 'number') it.i = 0;
    if (it.e) {
      for (const k of Object.keys(it.e)) {
        if (Array.isArray(it.e[k])) it.e[k][0] = 0;
      }
    }
    it.u = nowSec();
  }
  dirty = true;
  schedule();
}

module.exports = { load, getAll, put, flush, resetAllPositions };
