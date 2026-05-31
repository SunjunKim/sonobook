'use strict';

/* global naturalCompare */

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------
const AUDIO_EXT = new Set([
  'mp3', 'm4a', 'm4b', 'aac', 'wav', 'wave', 'flac', 'ogg', 'oga',
  'opus', 'weba', 'webm', 'aiff', 'aif', 'aifc', 'wma', 'mp4'
]);
const ZIP_EXT = new Set(['zip']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']);
const PRELOAD_LEAD_SECONDS = 10;
const AUTO_NEXT_RESUME_TIMEOUT_MS = 10000;

let uid = 0;
const state = {
  playlist: [],        // { id, name, kind: 'audio'|'zip', path }
  currentIndex: -1,    // index into playlist of the active (playing/loaded) item
  selectedId: null,    // id of the single-click-highlighted item (selection only)
  // Zip browsing is decoupled from zip playback: the sub-panel shows `view`
  // (the archive you're looking at); `zip` is the archive currently producing
  // audio. They reference the SAME object when you browse the playing zip.
  view: null,          // { id, name, path, mainIndex, entries, selIndex, coverUrl, images }
  zip: null            // same shape + `index` = the playing chapter
};

// Last-played-position store, loaded once from the main process. The renderer
// keeps the authoritative in-memory copy (see loadProgress in Init); saves are
// mirrored here immediately and persisted via IPC. Schema: see db.js.
let progressDB = { items: {} };
let pendingSeek = null;   // resume position to apply on the next loadedmetadata
let lastSaveTs = 0;       // throttle for IPC progress saves during playback
let sessionReady = false; // gate auto-save until the saved session is restored
let playIntent = false;   // are we actively trying to play? (gates auto-skip)
let zipViewRequest = 0;   // latest async request allowed to replace the sub-panel
let zipPlayRequest = 0;   // latest async request allowed to start zip playback
let preloadRequest = 0;   // latest async request allowed to warm the standby player
let preloadPendingKey = null;
let preloadedNext = null; // { key, kind, itemId, src, z?, chapterIndex?, enterZip? }
let autoNextRequest = 0;  // latest automatic-next decision still allowed to advance
let autoNextTimer = null;
let autoNextPromptOpen = false;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
let audio = $('audio');
let standbyAudio = $('preloadAudio');

const el = {
  brandName: $('brandName'),
  npTitle: $('npTitle'), npSub: $('npSub'),
  npArt: $('npArt'), npArtImg: $('npArtImg'),
  compactBtn: $('compactBtn'), compactIcon: $('compactIcon'), expandIcon: $('expandIcon'),
  mainList: $('mainList'), mainCount: $('mainCount'),
  subPanel: $('subPanel'), subList: $('subList'), subZipName: $('subZipName'),
  subCover: $('subCover'), subCoverImg: $('subCoverImg'),
  closeSubBtn: $('closeSubBtn'),
  playBtn: $('playBtn'), playIcon: $('playIcon'), pauseIcon: $('pauseIcon'),
  prevBtn: $('prevBtn'), nextBtn: $('nextBtn'),
  sortBtn: $('sortBtn'), shuffleBtn: $('shuffleBtn'),
  muteBtn: $('muteBtn'), volIcon: $('volIcon'), volume: $('volume'),
  speedSelect: $('speedSelect'),
  seek: $('seek'), curTime: $('curTime'), durTime: $('durTime'),
  dropOverlay: $('dropOverlay'), dropAppend: $('dropAppend'), dropReplace: $('dropReplace')
};

if (window.api && window.api.appInfo) {
  document.title = window.api.appInfo.title;
  el.brandName.textContent = window.api.appInfo.title;
}

// ---------------------------------------------------------------------------
// File-type helpers
// ---------------------------------------------------------------------------
function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
const isAudio = (name) => AUDIO_EXT.has(extOf(name));
const isZip = (name) => ZIP_EXT.has(extOf(name));
const isImage = (name) => IMAGE_EXT.has(extOf(name));
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();

const IMAGE_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif'
};
const AUDIO_MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', wave: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/ogg', weba: 'audio/webm', webm: 'audio/webm',
  aiff: 'audio/aiff', aif: 'audio/aiff', aifc: 'audio/aiff', wma: 'audio/x-ms-wma',
  mp4: 'audio/mp4'
};
const mimeFor = (table, name) => table[extOf(name)] || '';

// Wrap an ArrayBuffer from a zip entry in a typed Blob URL.
const blobUrl = (data, type) => URL.createObjectURL(new Blob([data], type ? { type } : undefined));

// ---------------------------------------------------------------------------
// Adding files / directories to the playlist
// ---------------------------------------------------------------------------
async function expandPaths(paths) {
  const out = [];
  for (const p of paths) {
    if (!p) continue;
    let st;
    try { st = await window.api.statFile(p); } catch (_) { continue; }
    if (st.isDirectory) {
      let entries = [];
      try { entries = await window.api.listDir(p); } catch (_) {}
      const childPaths = entries.map((e) => e.path);
      out.push(...await expandPaths(childPaths));
    } else if (isAudio(p) || isZip(p)) {
      out.push(p);
    }
  }
  return out;
}

function makeItem(path) {
  return {
    id: ++uid,
    name: baseName(path),
    kind: isZip(path) ? 'zip' : 'audio',
    path
  };
}

async function addFiles(paths, mode) {
  const files = await expandPaths(paths);
  if (!files.length) return;

  // Requirement 6: when several files arrive at once, order them naturally
  // (aaa1, aaa2 … aaa11, aaa12) before inserting.
  const items = files.map(makeItem);
  items.sort((a, b) => naturalCompare(a.name, b.name));

  if (mode === 'replace') {
    forceSaveCurrent(false); // persist the outgoing track before clearing
    stopZipPlayback(false);
    closeView();
    revokeThumbs(state.playlist);
    state.playlist = items;
    state.currentIndex = -1; // old index is meaningless against the new list
    lastScroll.main = -1;    // new list → allow the first scroll
    renderMainList();
    playIndex(0, false); // select & load, but don't auto-play
  } else {
    const wasEmpty = state.playlist.length === 0;
    state.playlist.push(...items);
    renderMainList();
    if (wasEmpty) playIndex(0, false);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const EQ_SVG = '<svg class="eq" viewBox="0 0 24 24" width="14" height="14"><path d="M6 10v4M11 6v12M16 8v8M21 11v2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

// Auto-scroll the active row into view, but only when the active index actually
// changes — so re-renders from play/pause don't yank the list while the user is
// browsing. `block:'nearest'` is a no-op when the row is already visible.
const lastScroll = { main: -1, sub: -1 };
function scrollActiveIntoView(listEl, index, key) {
  if (index < 0) { lastScroll[key] = -1; return; }
  if (index === lastScroll[key]) return;
  lastScroll[key] = index;
  const li = listEl.querySelector('.track.active');
  if (li) li.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderMainList() {
  if (sessionReady) persistSession(); // any structural/selection change auto-saves
  el.mainCount.textContent = `${state.playlist.length} track${state.playlist.length === 1 ? '' : 's'}`;
  el.mainList.innerHTML = '';

  if (!state.playlist.length) {
    const li = document.createElement('li');
    li.className = 'empty-hint';
    li.innerHTML = 'Drop audio files, folders, or a <b>.zip</b> here.<br>Drag tracks to reorder.';
    el.mainList.appendChild(li);
    return;
  }

  state.playlist.forEach((item, i) => {
    const li = document.createElement('li');
    const current = i === state.currentIndex;            // playing / loaded
    const selected = !current && item.id === state.selectedId; // single-click pick
    li.className = 'track' + (current ? ' active' : '') + (selected ? ' selected' : '');
    li.draggable = true;
    li.dataset.index = String(i);

    const playing = i === state.currentIndex && !audio.paused;
    li.innerHTML =
      `<span class="art">${artInner(item, i, playing)}</span>` +
      `<span class="name">${escapeHtml(item.name)}</span>` +
      (item.kind === 'zip' ? '<span class="badge">ZIP</span>' : '') +
      '<span class="track-time"></span>' +
      '<span class="remove" title="Remove">✕</span>' +
      '<span class="track-progress"><span class="track-progress-fill"></span></span>';

    // Single click selects (highlights) and, for a zip, opens its chapter list
    // in the sub-panel — never disturbs playback. Double click plays.
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove')) { removeItem(i); return; }
      selectMain(i);
      const it = state.playlist[i];
      if (it && it.kind === 'zip' && !it.missing) browseZip(i);
    });
    li.addEventListener('dblclick', (e) => {
      if (e.target.classList.contains('remove')) return;
      playIndex(i, true);
    });

    attachReorderHandlers(li);
    el.mainList.appendChild(li);
    applyUnderline(item);  // paint from cache if we already know this item
    gateItemWork(item);    // flag dark-red if gone; else thumb + fingerprint
  });
  scrollActiveIntoView(el.mainList, state.currentIndex, 'main');
}

// Inner HTML for a main-list item's left thumbnail box: artwork if we have it,
// otherwise the track number (or a 📦 for archives), with a playing overlay.
function artInner(item, i, playing) {
  if (item.thumbUrl) {
    return `<img src="${item.thumbUrl}" alt="">` +
      (playing ? `<span class="eqover">${EQ_SVG}</span>` : '');
  }
  if (playing) return EQ_SVG;
  return item.kind === 'zip' ? '📦' : String(i + 1);
}

// ---------------------------------------------------------------------------
// Embedded artwork thumbnails (requirement: per-item cover icon)
//   audio -> embedded tag picture (parsed in main via music-metadata)
//   zip   -> first/preferred image inside the archive (extracted in main via yauzl)
// Extraction is lazy, cached on the item, and throttled.
// ---------------------------------------------------------------------------
const THUMB_CONCURRENCY = 3;
let thumbActive = 0;
const thumbQueue = [];

function scheduleThumb(item) {
  if (item.thumbTried) return;
  item.thumbTried = true;
  thumbQueue.push(item);
  pumpThumbs();
}

function pumpThumbs() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const item = thumbQueue.shift();
    thumbActive++;
    extractThumb(item)
      .catch(() => {})
      .finally(() => { thumbActive--; pumpThumbs(); });
  }
}

async function extractThumb(item) {
  let url = null;
  if (item.kind === 'zip') {
    const list = await window.api.listZip(item.path);
    const pick = pickCover(list.map((e) => e.internalPath).filter(isImage));
    if (pick) {
      const data = await window.api.readZipEntry(item.path, pick);
      url = blobUrl(data, mimeFor(IMAGE_MIME, pick));
    }
  } else {
    const art = await window.api.getArtwork(item.path);
    if (art && art.data) url = blobUrl(art.data, art.mime);
  }
  if (url) {
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    item.thumbUrl = url;
    applyThumb(item);
  }
}

// Patch the already-rendered list node in place (avoids a full re-render).
function applyThumb(item) {
  const i = state.playlist.indexOf(item);
  if (i < 0) return;
  const li = el.mainList.querySelector(`.track[data-index="${i}"]`);
  const art = li && li.querySelector('.art');
  if (art) {
    const playing = i === state.currentIndex && !audio.paused;
    art.innerHTML = artInner(item, i, playing);
  }
  if (i === state.currentIndex && !state.zip) refreshNowArt();
}

function revokeThumbs(items) {
  for (const it of items) {
    if (it.thumbUrl) { URL.revokeObjectURL(it.thumbUrl); it.thumbUrl = null; }
  }
}

// ---------------------------------------------------------------------------
// Content fingerprints + listened-time progress
//   - Fingerprints identify a file by content (not path) without reading all of
//     it; computed lazily/throttled like thumbnails and cached on the item.
//   - The underline under each entry shows listened/total; for a zip it is the
//     aggregate over its chapters (durations of unplayed chapters estimated from
//     their uncompressed size).
// ---------------------------------------------------------------------------
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Build the natural-sorted audio-entry list of a zip (index-aligned with the
// `e` map and with openZip's playback order). Cached on the item.
async function loadZipEntries(item) {
  if (item.zipEntries) return item.zipEntries;
  const list = await window.api.listZip(item.path);
  const entries = list
    .filter((e) => isAudio(e.internalPath))
    .map((e) => ({ internalPath: e.internalPath, name: baseName(e.internalPath), uncompressedSize: e.uncompressedSize }));
  entries.sort((a, b) => naturalCompare(a.name, b.name));
  item.zipEntries = entries;
  return entries;
}

// Compute (once) and cache the content fingerprint of an item. De-duped so the
// lazy queue and an on-demand save don't both hit IPC.
function ensureFingerprint(item) {
  if (item.fingerprint) return Promise.resolve(item.fingerprint);
  if (item._fpPromise) return item._fpPromise;
  item._fpPromise = (async () => {
    if (item.kind === 'zip') {
      await loadZipEntries(item);
      item.fingerprint = await window.api.fingerprintZip(item.path);
    } else {
      item.fingerprint = await window.api.fingerprintFile(item.path);
    }
    return item.fingerprint;
  })();
  return item._fpPromise;
}

const FP_CONCURRENCY = 3;
let fpActive = 0;
const fpQueue = [];

function scheduleFingerprint(item) {
  if (item.fpTried || item.fingerprint) return;
  item.fpTried = true;
  fpQueue.push(item);
  pumpFingerprints();
}

function pumpFingerprints() {
  while (fpActive < FP_CONCURRENCY && fpQueue.length) {
    const item = fpQueue.shift();
    fpActive++;
    ensureFingerprint(item)
      .then(() => applyUnderline(item))
      .catch(() => {})
      .finally(() => { fpActive--; pumpFingerprints(); });
  }
}

// ---------------------------------------------------------------------------
// Lazy running-time probing — fill in each entry's total time in the background
// without playing it, and persist it (content-keyed) so it's instant next launch.
// Low concurrency + best-effort so it never competes with playback.
// ---------------------------------------------------------------------------
const DUR_CONCURRENCY = 2;
let durActive = 0;
const durQueue = [];

function scheduleDurations(item) {
  if (item.durTried) return;
  item.durTried = true;
  durQueue.push(item);
  pumpDurations();
}

function pumpDurations() {
  while (durActive < DUR_CONCURRENCY && durQueue.length) {
    const item = durQueue.shift();
    durActive++;
    probeDuration(item).catch(() => {}).finally(() => { durActive--; pumpDurations(); });
  }
}

async function probeDuration(item) {
  const fp = await ensureFingerprint(item).catch(() => null);
  if (!fp) return;
  const rec = progressDB.items[fp] || null;

  if (item.kind === 'zip') {
    if (!item.zipEntries || !item.zipEntries.length) return;
    // Already have a measured chapter (played or probed) → estimates work; done.
    if (zipBytesPerSec(item, rec) > 0) { applyUnderline(item); return; }
    const first = item.zipEntries[0];
    const dur = await window.api.zipFirstDuration(item.path, first.internalPath);
    if (!dur) return;
    const curE = (progressDB.items[fp] || {}).e || {};
    const pos0 = curE['0'] ? curE['0'][0] : 0; // preserve any played position
    recordDuration(item, { e: { 0: [pos0, Math.round(dur)] } });
  } else {
    if (rec && rec.d > 0) return; // already known
    const dur = await window.api.getDuration(item.path);
    if (!dur) return;
    recordDuration(item, { d: Math.round(dur) });
  }
}

// Persist a duration-only record and refresh that item's labels/bars.
function recordDuration(item, rec) {
  const fp = item.fingerprint;
  if (!fp) return;
  localMergeProgress(fp, rec);
  applyUnderline(item);
  if (state.view && state.playlist[state.view.mainIndex] === item) refreshSubUnderlines();
  window.api.saveProgress(fp, rec);
}

// bytes→seconds rate from the zip's already-measured chapters (0 if none yet).
function zipBytesPerSec(item, rec) {
  if (!item.zipEntries || !rec || !rec.e) return 0;
  let dur = 0, bytes = 0;
  item.zipEntries.forEach((e, k) => {
    const t = rec.e[k];
    if (t && typeof t[1] === 'number' && t[1] > 0 && e.uncompressedSize > 0) {
      dur += t[1]; bytes += e.uncompressedSize;
    }
  });
  return bytes > 0 ? dur / bytes : 0;
}

// Aggregate listened/total for a zip, estimating unknown durations by size.
function zipAggregateFraction(item, rec) {
  const entries = item.zipEntries;
  if (!entries || !entries.length || !rec || !rec.e) return 0;
  const bps = zipBytesPerSec(item, rec);
  let total = 0, listened = 0;
  entries.forEach((e, k) => {
    const t = rec.e[k];
    const measured = t && typeof t[1] === 'number' && t[1] > 0 ? t[1] : null;
    const est = measured != null ? measured : (bps > 0 && e.uncompressedSize > 0 ? e.uncompressedSize * bps : null);
    if (est == null) return;
    total += est;
    listened += Math.min(t ? t[0] : 0, est);
  });
  return total > 0 ? clamp01(listened / total) : 0;
}

// Whole zip listened to the end (used to restart it from chapter 0).
function isZipComplete(item, rec) {
  return zipAggregateFraction(item, rec) >= 1;
}

// Fraction for a single zip chapter (measured duration, else size-estimated).
function subChapterFraction(rec, item, idx) {
  if (!rec || !rec.e) return 0;
  const t = rec.e[idx];
  if (!t) return 0;
  let dur = (typeof t[1] === 'number' && t[1] > 0) ? t[1] : null;
  if (dur == null) {
    const bps = zipBytesPerSec(item, rec);
    const size = item.zipEntries && item.zipEntries[idx] && item.zipEntries[idx].uncompressedSize;
    if (bps > 0 && size > 0) dur = size * bps;
  }
  if (!dur) return t[0] > 0 ? 0.02 : 0;
  return clamp01(t[0] / dur);
}

// 0..1 listened fraction for a main-list item (null/0 = unread).
function progressFraction(item) {
  const fp = item.fingerprint;
  if (!fp) return 0;
  const rec = progressDB.items[fp];
  if (!rec) return 0;
  if (item.kind === 'zip') return zipAggregateFraction(item, rec);
  if (!rec.d) return rec.p > 0 ? 0.02 : 0; // duration unknown → thin sliver
  return clamp01(rec.p / rec.d);
}

// ---------------------------------------------------------------------------
// Played / total time labels (shown on the right of each entry).
// Total is "exact" when a real duration has been measured; otherwise it's a
// size-based estimate, shown with a leading "~".
// ---------------------------------------------------------------------------
function fmtClock(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtTimes(t) {
  if (!t || !(t.total > 0)) return '';
  return `${fmtClock(t.played)} / ${t.est ? '~' : ''}${fmtClock(t.total)}`;
}

// Audio file: known only once it's been played (measured duration in the DB).
function audioTimes(item) {
  const rec = item.fingerprint && progressDB.items[item.fingerprint];
  if (!rec || !(rec.d > 0)) return null;
  return { played: Math.min(rec.p || 0, rec.d), total: rec.d, est: false };
}

// Zip aggregate: sum of chapter durations; estimated (~) if any chapter's
// duration is still size-derived rather than measured.
function zipTimes(item) {
  const entries = item.zipEntries;
  if (!entries || !entries.length) return null;
  const rec = item.fingerprint && progressDB.items[item.fingerprint];
  const bps = zipBytesPerSec(item, rec);
  let total = 0, played = 0, est = false;
  entries.forEach((e, k) => {
    const t = rec && rec.e && rec.e[k];
    const measured = t && typeof t[1] === 'number' && t[1] > 0 ? t[1] : null;
    let dur;
    if (measured != null) dur = measured;
    else { est = true; dur = (bps > 0 && e.uncompressedSize > 0) ? e.uncompressedSize * bps : 0; }
    total += dur;
    if (t) played += Math.min(t[0], dur > 0 ? dur : t[0]);
  });
  return total > 0 ? { played, total, est } : null;
}

// Single zip chapter: measured duration, else size estimate (~).
function chapterTimes(item, rec, bps, k) {
  const e = item.zipEntries && item.zipEntries[k];
  if (!e) return null;
  const t = rec && rec.e && rec.e[k];
  const measured = t && typeof t[1] === 'number' && t[1] > 0 ? t[1] : null;
  let total, est;
  if (measured != null) { total = measured; est = false; }
  else { total = (bps > 0 && e.uncompressedSize > 0) ? e.uncompressedSize * bps : 0; est = true; }
  return total > 0 ? { played: t ? t[0] : 0, total, est } : null;
}

// Paint a track node's underline: unread (gray groove) / in-read / complete.
function setBar(node, frac) {
  const fill = node.querySelector('.track-progress-fill');
  if (!fill) return;
  node.classList.remove('unread', 'complete');
  if (frac == null || frac < 0.005) {
    node.classList.add('unread');
    fill.style.width = '0%';
  } else if (frac >= 1) {
    node.classList.add('complete');
    fill.style.width = '100%';
  } else {
    fill.style.width = (frac * 100).toFixed(1) + '%';
  }
}

function applyUnderline(item) {
  const i = state.playlist.indexOf(item);
  if (i < 0) return;
  const li = el.mainList.querySelector(`.track[data-index="${i}"]`);
  if (!li) return;
  const container = li.querySelector('.track-progress');
  if (!container) return;
  // A zip shows one segment per chapter, each with its own progress; a plain
  // audio file (or a zip not yet listed) shows the single aggregate bar.
  if (item.kind === 'zip' && item.zipEntries && item.zipEntries.length) {
    renderSegments(container, item);
  } else {
    setBar(li, progressFraction(item));
  }
  const timeEl = li.querySelector('.track-time');
  if (timeEl) timeEl.textContent = fmtTimes(item.kind === 'zip' ? zipTimes(item) : audioTimes(item));
}

// Paint a zip row's multi-segment bar (one segment per chapter). Segment DOM is
// built once per chapter-count; later calls only update fills (cheap on every
// timeupdate).
function renderSegments(container, item) {
  const n = item.zipEntries.length;
  if (container.dataset.segs !== String(n)) {
    container.classList.add('segmented');
    container.innerHTML = Array.from({ length: n },
      () => '<span class="seg"><span class="seg-fill"></span></span>').join('');
    container.dataset.segs = String(n);
  }
  const rec = progressDB.items[item.fingerprint] || null;
  const bps = zipBytesPerSec(item, rec);
  const segs = container.children;
  for (let k = 0; k < n; k++) {
    const seg = segs[k];
    // Width ∝ chapter length: measured duration when known, else size-estimate.
    const w = String(Math.max(0.001, chapterWeight(item, rec, bps, k)));
    if (seg.style.flexGrow !== w) seg.style.flexGrow = w;
    setSeg(seg, subChapterFraction(rec, item, k));
  }
}

// Relative size of one chapter for segment widths (same unit basis as the
// aggregate: measured seconds, or size→seconds estimate, or raw bytes).
function chapterWeight(item, rec, bps, k) {
  const t = rec && rec.e && rec.e[k];
  const measured = t && typeof t[1] === 'number' && t[1] > 0 ? t[1] : null;
  if (measured != null) return measured;
  const size = item.zipEntries[k].uncompressedSize || 0;
  if (size > 0) return bps > 0 ? size * bps : size;
  return 1; // 0-byte entry still gets a sliver
}

function setSeg(seg, frac) {
  const fill = seg.querySelector('.seg-fill');
  if (!fill) return;
  seg.classList.remove('unread', 'complete');
  if (frac == null || frac < 0.005) { seg.classList.add('unread'); fill.style.width = '0%'; }
  else if (frac >= 1) { seg.classList.add('complete'); fill.style.width = '100%'; }
  else fill.style.width = (frac * 100).toFixed(1) + '%';
}

function refreshAllUnderlines() {
  state.playlist.forEach(applyUnderline);
}

// ---------------------------------------------------------------------------
// Missing-file detection — flag entries whose file no longer exists.
// ---------------------------------------------------------------------------
async function checkExists(item) {
  if (!item.existChecked) {
    let ok = true;
    try { ok = await window.api.pathExists(item.path); } catch (_) { ok = true; }
    item.existChecked = true;
    item.missing = !ok;
  }
  applyMissing(item);
  return !item.missing;
}

// Existence-gate the heavier per-item work so a missing file isn't probed
// (avoids futile zip-list / fingerprint / artwork reads on dead entries).
async function gateItemWork(item) {
  if (!(await checkExists(item))) return;
  scheduleThumb(item);
  scheduleFingerprint(item);
  scheduleDurations(item);
}

function applyMissing(item) {
  const i = state.playlist.indexOf(item);
  if (i < 0) return;
  const li = el.mainList.querySelector(`.track[data-index="${i}"]`);
  if (!li) return;
  li.classList.toggle('missing', !!item.missing);
  if (item.missing) li.title = 'File not found:\n' + item.path;
  else li.removeAttribute('title');
}

function applySubUnderline(li, idx) {
  if (!state.view) return;
  const item = state.playlist[state.view.mainIndex];
  const fp = item && item.fingerprint;
  const rec = (fp && progressDB.items[fp]) || null;
  setBar(li, subChapterFraction(rec, item, idx));
  const timeEl = li.querySelector('.track-time');
  if (timeEl && item) {
    timeEl.textContent = fmtTimes(chapterTimes(item, rec, zipBytesPerSec(item, rec), idx));
  }
}

function refreshSubUnderlines() {
  if (!state.view) return;
  el.subList.querySelectorAll('.track').forEach((li, idx) => applySubUnderline(li, idx));
}

// ---------------------------------------------------------------------------
// Saving / restoring listened time
// ---------------------------------------------------------------------------
// Snapshot the current playback position as a (compact) record, or null if
// there's nothing worth saving (no metadata / barely started).
function captureSnapshot(complete) {
  const cur = audio.currentTime || 0;
  if (!complete && cur < 1) return null; // avoid clobbering a saved spot at load
  const dur = (isFinite(audio.duration) && audio.duration > 0) ? Math.round(audio.duration) : null;
  let pos = Math.round(cur);
  if (complete && dur) pos = dur;
  else if (dur && pos >= dur) pos = Math.max(0, dur - 1);

  if (state.zip && state.zip.index >= 0) {
    const item = state.playlist[state.zip.mainIndex];
    if (!item) return null;
    const idx = state.zip.index;
    const rec = { i: idx, e: { [idx]: [pos, dur] } };
    if (complete) rec._complete = true;
    return { item, rec };
  }
  if (state.currentIndex >= 0) {
    const item = state.playlist[state.currentIndex];
    if (!item || item.kind === 'zip') return null; // zip selected but not opened
    const rec = { p: pos, d: dur };
    if (complete) rec._complete = true;
    return { item, rec };
  }
  return null;
}

// Merge a record into the in-memory DB (mirrors db.put's merge), minus the
// _complete signal which is only meaningful to the persistence gate.
function localMergeProgress(fp, rec) {
  const cur = progressDB.items[fp] || {};
  const next = Object.assign({}, cur, rec);
  if (rec.e) next.e = Object.assign({}, cur.e, rec.e);
  delete next._complete;
  next.u = Math.floor(Date.now() / 1000);
  progressDB.items[fp] = next;
}

function persistProgress(snap, alsoIPC) {
  const fp = snap.item.fingerprint;
  if (!fp) return false;
  localMergeProgress(fp, snap.rec);
  applyUnderline(snap.item);
  if (state.view) refreshSubUnderlines();
  if (alsoIPC) window.api.saveProgress(fp, snap.rec);
  return true;
}

// Force-save the current position (pause / track change / completion / unload).
// Computes the fingerprint inline if it isn't ready so a finished chapter isn't
// lost.
async function forceSaveCurrent(complete) {
  const snap = captureSnapshot(!!complete);
  if (!snap) return;
  if (!snap.item.fingerprint) {
    try { await ensureFingerprint(snap.item); } catch (_) { return; }
  }
  persistProgress(snap, true);
}

// Auto-resume helpers — seek to the saved position once metadata is available,
// without yanking playback the user has already moved past.
function applyPendingSeek() {
  if (pendingSeek == null || !isFinite(audio.duration)) return;
  if (pendingSeek > 0 && pendingSeek < audio.duration - 2) audio.currentTime = pendingSeek;
  pendingSeek = null;
}

async function primeAudioResume(item) {
  const fp = await ensureFingerprint(item).catch(() => null);
  if (!fp) return;
  if (state.zip || state.currentIndex < 0 || state.playlist[state.currentIndex] !== item) return;
  const rec = progressDB.items[fp];
  if (!rec || !rec.d || !(rec.p > 0) || rec.p >= rec.d - 2) return;
  if (audio.currentTime > 1) return; // already progressed
  if (isFinite(audio.duration) && audio.duration > 0) audio.currentTime = rec.p;
  else pendingSeek = rec.p;
}

async function primeSubResume(item, idx, z) {
  const fp = await ensureFingerprint(item).catch(() => null);
  if (!fp) return;
  if (state.zip !== z || z.index !== idx) return;
  const rec = progressDB.items[fp];
  const t = rec && rec.e && rec.e[idx];
  if (!t || !(t[0] > 0)) return;
  if (t[1] && t[0] >= t[1] - 2) return;
  if (audio.currentTime > 1) return;
  if (isFinite(audio.duration) && audio.duration > 0) audio.currentTime = t[0];
  else pendingSeek = t[0];
}

function renderSubList() {
  const v = state.view;
  if (!v) return;
  // The "playing" chapter highlight only applies when the viewed zip is also the
  // one currently producing audio.
  const playingHere = state.zip === v;
  el.subZipName.textContent = v.name;
  el.subList.innerHTML = '';
  v.entries.forEach((entry, i) => {
    const li = document.createElement('li');
    const curCh = playingHere && i === state.zip.index;
    const selCh = !curCh && i === v.selIndex;
    li.className = 'track' + (curCh ? ' active' : '') + (selCh ? ' selected' : '');
    const playing = curCh && !audio.paused;
    li.innerHTML =
      `<span class="idx">${playing ? EQ_SVG : i + 1}</span>` +
      `<span class="name">${escapeHtml(entry.name)}</span>` +
      '<span class="track-time"></span>' +
      '<span class="track-progress"><span class="track-progress-fill"></span></span>';
    // Single click selects the chapter (no playback change); double click plays.
    li.addEventListener('click', () => selectSub(i));
    li.addEventListener('dblclick', () => playSub(i, true));
    el.subList.appendChild(li);
    applySubUnderline(li, i);
  });
  scrollActiveIntoView(el.subList, playingHere ? state.zip.index : v.selIndex, 'sub');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function removeItem(i) {
  const removed = state.playlist[i];
  if (!removed) return;
  const wasCurrent = i === state.currentIndex;
  revokeThumbs([removed]);
  if (state.zip && state.zip.id === removed.id) stopZipPlayback(false);
  if (state.view && state.view.id === removed.id) closeView();
  state.playlist.splice(i, 1);
  if (i < state.currentIndex) state.currentIndex--;
  else if (wasCurrent) {
    state.currentIndex = -1;
    audio.removeAttribute('src');
    audio.load();
    updateNowPlaying();
  }
  remapZipIndices();
  renderMainList();
}

// ---------------------------------------------------------------------------
// Playback preloading — warm one exact automatic-next target in a standby
// player, then promote it at the file boundary if the playlist still matches.
// ---------------------------------------------------------------------------
function resetPlayer(player) {
  player.pause();
  player.removeAttribute('src');
  player.load();
}

function releasePreloadedZip(target) {
  if (target && target.z && target.z !== state.zip && target.z !== state.view) {
    releaseZip(target.z);
  }
}

function invalidatePreloadedNext() {
  preloadRequest++;
  preloadPendingKey = null;
  const target = preloadedNext;
  preloadedNext = null;
  resetPlayer(standbyAudio);
  releasePreloadedZip(target);
}

function nextMainSpec(from) {
  const mainIndex = firstAvailableFrom(from, 1);
  if (mainIndex < 0) return null;
  const item = state.playlist[mainIndex];
  return { key: `main:${item.id}`, kind: 'main', itemId: item.id };
}

function nextPlaybackSpec() {
  if (state.zip) {
    const z = state.zip;
    const chapterIndex = z.index + 1;
    if (chapterIndex < z.entries.length) {
      return { key: `zip:${z.id}:${chapterIndex}`, kind: 'zipChapter', z, chapterIndex };
    }
    return nextMainSpec(z.mainIndex + 1);
  }
  return state.currentIndex >= 0 ? nextMainSpec(state.currentIndex + 1) : null;
}

function savedAudioResume(item) {
  const rec = item.fingerprint && progressDB.items[item.fingerprint];
  return rec && rec.d && rec.p > 0 && rec.p < rec.d - 2 ? rec.p : null;
}

function savedChapterResume(item, chapterIndex) {
  const rec = item.fingerprint && progressDB.items[item.fingerprint];
  const t = rec && rec.e && rec.e[chapterIndex];
  return t && t[0] > 0 && (!t[1] || t[0] < t[1] - 2) ? t[0] : null;
}

async function savedSpecResume(spec) {
  if (!spec) return null;
  const target = preloadedNext;
  if (target && target.key === spec.key && target.resume > 0) return target.resume;

  const item = state.playlist.find((it) => it.id === (spec.z ? spec.z.id : spec.itemId));
  if (!item || !(await ensureFingerprint(item).catch(() => null))) return null;
  if (spec.kind === 'zipChapter') return savedChapterResume(item, spec.chapterIndex);
  if (item.kind !== 'zip') return savedAudioResume(item);

  const rec = progressDB.items[item.fingerprint];
  const chapterIndex = rec && rec.i && !isZipComplete(item, rec)
    ? Math.max(0, Math.min(rec.i, item.zipEntries.length - 1))
    : 0;
  return savedChapterResume(item, chapterIndex);
}

async function loadZipEntryBlob(z, chapterIndex) {
  const entry = z.entries[chapterIndex];
  if (!entry) return null;
  if (entry.blobUrl) return entry.blobUrl;
  if (!entry.blobPromise) {
    entry.blobPromise = window.api.readZipEntry(z.path, entry.internalPath)
      .then((data) => {
        if (!entry.blobUrl) entry.blobUrl = blobUrl(data, mimeFor(AUDIO_MIME, entry.name));
        return entry.blobUrl;
      })
      .finally(() => { entry.blobPromise = null; });
  }
  return entry.blobPromise;
}

async function resolvePreloadTarget(spec) {
  if (spec.kind === 'zipChapter') {
    const item = state.playlist.find((it) => it.id === spec.z.id);
    const src = await loadZipEntryBlob(spec.z, spec.chapterIndex);
    return src && item ? {
      key: spec.key, kind: 'zip', itemId: item.id, src,
      z: spec.z, chapterIndex: spec.chapterIndex, enterZip: false,
      resume: savedChapterResume(item, spec.chapterIndex)
    } : null;
  }

  let mainIndex = state.playlist.findIndex((it) => it.id === spec.itemId);
  if (mainIndex < 0) return null;
  const item = state.playlist[mainIndex];
  if (item.kind !== 'zip') {
    return {
      key: spec.key, kind: 'audio', itemId: item.id,
      src: window.api.pathToFileURL(item.path), resume: savedAudioResume(item)
    };
  }

  let z = null;
  if (state.zip && state.zip.id === item.id) z = state.zip;
  else if (state.view && state.view.id === item.id) z = state.view;
  else z = await buildZipView(item, mainIndex);
  if (!z) return null;

  mainIndex = state.playlist.findIndex((it) => it.id === item.id);
  if (mainIndex < 0) {
    if (z !== state.zip && z !== state.view) releaseZip(z);
    return null;
  }
  z.mainIndex = mainIndex;
  try { await ensureFingerprint(item); } catch (_) {}
  const rec = item.fingerprint && progressDB.items[item.fingerprint];
  const chapterIndex = rec && rec.i && !isZipComplete(item, rec)
    ? Math.max(0, Math.min(rec.i, z.entries.length - 1))
    : 0;
  const src = await loadZipEntryBlob(z, chapterIndex);
  return src ? {
    key: spec.key, kind: 'zip', itemId: item.id, src,
    z, chapterIndex, enterZip: true, resume: savedChapterResume(item, chapterIndex)
  } : null;
}

function applyPreparedSeek(player, target) {
  if (!target || !(target.resume > 0) || !isFinite(player.duration)) return;
  if (target.resume < player.duration - 2) player.currentTime = target.resume;
}

async function preloadNextPlayback() {
  const spec = nextPlaybackSpec();
  if (!spec) { invalidatePreloadedNext(); return; }
  if ((preloadedNext && preloadedNext.key === spec.key) || preloadPendingKey === spec.key) return;

  invalidatePreloadedNext();
  const request = ++preloadRequest;
  preloadPendingKey = spec.key;
  let target = null;
  try {
    target = await resolvePreloadTarget(spec);
  } catch (e) {
    console.error('Failed to preload next track', e);
  }
  const currentSpec = nextPlaybackSpec();
  if (request !== preloadRequest || !target || !currentSpec || currentSpec.key !== spec.key) {
    if (request === preloadRequest) preloadPendingKey = null;
    releasePreloadedZip(target);
    return;
  }

  preloadPendingKey = null;
  preloadedNext = target;
  syncPlayerSettings(standbyAudio);
  standbyAudio.src = target.src;
  standbyAudio.load();
  applyPreparedSeek(standbyAudio, target);
}

function maybePreloadNextPlayback() {
  if (!playIntent || !isFinite(audio.duration) || audio.duration <= 0) return;
  if (audio.duration - audio.currentTime <= PRELOAD_LEAD_SECONDS) preloadNextPlayback();
}

function promotePreloadedNext(spec, resume = true) {
  const target = preloadedNext;
  if (!target || target.key !== spec.key || standbyAudio.readyState < 2) return false;
  const mainIndex = state.playlist.findIndex((it) => it.id === target.itemId);
  if (mainIndex < 0) return false;

  const previousAudio = audio;
  const previousZip = state.zip;
  audio = standbyAudio;
  standbyAudio = previousAudio;
  preloadRequest++;
  preloadPendingKey = null;
  preloadedNext = null;
  pendingSeek = null;

  if (target.kind === 'zip') {
    state.zip = target.z;
    target.z.mainIndex = mainIndex;
    target.z.index = target.chapterIndex;
    target.z.selIndex = target.chapterIndex;
    state.currentIndex = mainIndex;
    state.selectedId = target.itemId;
    if (target.enterZip) setView(target.z);
    else if (state.view === target.z) renderSubList();
    if (!target.z.coverUrl) loadCover(target.z);
  } else {
    state.zip = null;
    state.currentIndex = mainIndex;
    state.selectedId = target.itemId;
    closeView();
  }

  if (previousZip && previousZip !== state.zip && previousZip !== state.view) {
    releaseZip(previousZip);
  }
  resetPlayer(standbyAudio);
  syncPlayerSettings(audio);
  el.durTime.textContent = fmtTime(audio.duration);
  if (resume) applyPreparedSeek(audio, target);
  else audio.currentTime = 0;
  const item = state.playlist[mainIndex];
  if (resume) {
    if (target.kind === 'zip') primeSubResume(item, target.chapterIndex, target.z);
    else primeAudioResume(item);
  }
  audio.play().catch(() => {});
  updateNowPlaying();
  renderMainList();
  if (state.view) renderSubList();
  return true;
}

// ---------------------------------------------------------------------------
// Playback — main playlist
// ---------------------------------------------------------------------------
function playIndex(i, autoplay = true, resume = true) {
  if (i < 0 || i >= state.playlist.length) return;
  cancelPendingAutoNext();
  invalidatePreloadedNext();
  zipPlayRequest++;         // cancel a zip that is still opening asynchronously
  forceSaveCurrent(false); // persist the outgoing track's position first
  pendingSeek = null;
  stopZipPlayback(false);  // stop any playing zip (browse view is independent)
  const item = state.playlist[i];
  if (item.kind === 'zip' && autoplay) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  state.currentIndex = i;
  state.selectedId = item.id; // selection follows the now-current item
  if (item.kind !== 'zip') closeView();
  playIntent = autoplay; // selecting without autoplay must not trigger auto-skip

  if (item.kind === 'zip') {
    // A zip is opened (sub-list built + played) when actually played.
    if (autoplay) openZip(item, i, true, resume);
    else { audio.removeAttribute('src'); audio.load(); }
  } else {
    audio.src = window.api.pathToFileURL(item.path);
    if (resume) primeAudioResume(item); // auto-resume from the saved position
    if (autoplay) audio.play().catch(() => {});
  }
  updateNowPlaying();
  renderMainList();
}

// First non-missing index scanning from `from` in direction `dir` (+1/-1).
function firstAvailableFrom(from, dir) {
  for (let k = from; k >= 0 && k < state.playlist.length; k += dir) {
    if (!state.playlist[k].missing) return k;
  }
  return -1;
}

function nextMain(resume = true) {
  const i = firstAvailableFrom(state.currentIndex + 1, 1);
  if (i >= 0) playIndex(i, true, resume);
  else stopPlayback();
}

function prevMain() {
  if (state.currentIndex > 0) {
    const i = firstAvailableFrom(state.currentIndex - 1, -1);
    if (i >= 0) { playIndex(i); return; }
  }
  const f = firstAvailableFrom(0, 1);
  if (f >= 0) playIndex(f);
}

function stopPlayback() {
  cancelPendingAutoNext();
  playIntent = false;
  invalidatePreloadedNext();
  stopZipPlayback(false); // stop zip audio; leave any browse panel open
  audio.pause();
  audio.currentTime = 0;
  state.currentIndex = -1;
  updateNowPlaying();
  renderMainList();
}

// ---------------------------------------------------------------------------
// Playback — zip archives (secondary playlist, requirement 5)
// ---------------------------------------------------------------------------
// Build a browseable zip object (lists the directory only). Returns null if the
// archive is unreadable or has no audio entries.
async function buildZipView(item, mainIndex) {
  let list;
  try {
    list = await window.api.listZip(item.path); // directory only — no inflation
  } catch (e) {
    console.error('Failed to read zip', e);
    return null;
  }
  const entries = [];
  const images = [];
  for (const { internalPath, uncompressedSize } of list) {
    if (isAudio(internalPath)) {
      entries.push({ name: baseName(internalPath), internalPath, uncompressedSize, blobUrl: null });
    } else if (isImage(internalPath)) {
      images.push(internalPath);
    }
  }
  entries.sort((a, b) => naturalCompare(a.name, b.name));
  if (!entries.length) return null;
  item.zipEntries = entries; // index-aligned with the saved `e` map
  return {
    id: item.id, name: item.name, path: item.path, mainIndex,
    entries, index: -1, selIndex: -1, coverUrl: null, images
  };
}

// Open a zip in the sub-panel. autoplay=true → also start playing (resume
// chapter); autoplay=false → just browse, leaving current playback untouched.
async function openZip(item, mainIndex, autoplay = true, resume = true) {
  const viewRequest = ++zipViewRequest;
  const playRequest = autoplay ? ++zipPlayRequest : null;
  // Reuse the live object if we're opening the zip that's already playing/shown
  // (keeps its blob cache); otherwise build a fresh view.
  let z = null;
  if (state.zip && state.zip.id === item.id) { z = state.zip; z.mainIndex = mainIndex; }
  else if (state.view && state.view.id === item.id) { z = state.view; z.mainIndex = mainIndex; }
  else {
    z = await buildZipView(item, mainIndex);
    if (!z) {
      const current = state.currentIndex >= 0 ? state.playlist[state.currentIndex] : null;
      if (autoplay && playRequest === zipPlayRequest && current && current.id === item.id) nextMain();
      return;
    }
  }

  const liveIndex = state.playlist.findIndex((it) => it.id === item.id);
  if (liveIndex < 0) return; // removed/replaced while the zip directory was read
  z.mainIndex = liveIndex;
  if (viewRequest === zipViewRequest) setView(z);
  else if (!autoplay) return; // a newer browse request owns the sub-panel

  try { await ensureFingerprint(item); } catch (_) {}
  applyUnderline(item);

  const rec = item.fingerprint && progressDB.items[item.fingerprint];
  // Resume at the last-played chapter — unless the book is finished, in which
  // case playing it restarts from the first chapter.
  let resumeIdx = 0;
  if (resume && rec && rec.i && !isZipComplete(item, rec)) {
    resumeIdx = Math.max(0, Math.min(rec.i, z.entries.length - 1));
  }

  if (autoplay) {
    const current = state.currentIndex >= 0 ? state.playlist[state.currentIndex] : null;
    if (playRequest !== zipPlayRequest || !current || current.id !== item.id) return;
    z.mainIndex = state.currentIndex; // the playlist may have been reordered
    playChapter(z, resumeIdx, true, resume);
  } else {
    if (viewRequest !== zipViewRequest || state.view !== z) return;
    if (z !== state.zip) z.selIndex = resumeIdx; // preselect resume when browsing
    renderSubList();
  }
}

// Switch the sub-panel to display zip `z`, releasing the previously-viewed one
// if it's neither playing nor the same object.
function setView(z) {
  if (state.view && state.view !== z && state.view !== state.zip &&
      (!preloadedNext || preloadedNext.z !== state.view)) releaseZip(state.view);
  state.view = z;
  lastScroll.sub = -1;
  el.subPanel.classList.remove('hidden');
  el.subZipName.textContent = z.name;
  if (z.coverUrl) {
    el.subCoverImg.src = z.coverUrl;
    el.subCover.classList.remove('hidden');
  } else {
    el.subCover.classList.add('hidden');
    el.subCoverImg.removeAttribute('src');
    loadCover(z);
  }
  renderSubList();
  refreshSubUnderlines();
}

// Release a zip object's blob URLs (extracted chapters + cover).
function releaseZip(z) {
  if (!z) return;
  for (const e of z.entries) {
    if (e.blobUrl) { URL.revokeObjectURL(e.blobUrl); e.blobUrl = null; }
  }
  if (z.coverUrl) { URL.revokeObjectURL(z.coverUrl); z.coverUrl = null; }
}

// Prefer common artwork names (cover/folder/front/album/art), otherwise the
// first image in natural order.
function pickCover(images) {
  if (!images || !images.length) return null;
  const PREF = /(cover|folder|front|album|art(work)?)/i;
  const sorted = images.slice().sort((a, b) => naturalCompare(baseName(a), baseName(b)));
  return sorted.find((p) => PREF.test(baseName(p))) || sorted[0];
}

// Load a zip's cover into z.coverUrl, then show it if z is still being viewed.
async function loadCover(z) {
  if (z.coverUrl || z.coverLoading) return;
  const internalPath = pickCover(z.images);
  if (!internalPath) return;
  z.coverLoading = true;
  try {
    const data = await window.api.readZipEntry(z.path, internalPath);
    if (state.view !== z && state.zip !== z) return;
    z.coverUrl = blobUrl(data, mimeFor(IMAGE_MIME, internalPath));
    if (state.view === z) {
      el.subCoverImg.src = z.coverUrl;
      el.subCover.classList.remove('hidden');
    }
    if (state.zip === z) refreshNowArt();
  } catch (e) {
    console.error('Failed to load cover', internalPath, e);
  } finally {
    z.coverLoading = false;
  }
}

// Play chapter i of zip object z — z becomes the playing archive (state.zip).
async function playChapter(z, i, autoplay = true, resume = true) {
  if (!z || i < 0 || i >= z.entries.length) return;
  cancelPendingAutoNext();
  invalidatePreloadedNext();
  zipPlayRequest++;         // supersede a zip that is still opening
  forceSaveCurrent(false); // persist whatever was playing before
  pendingSeek = null;
  const entry = z.entries[i];
  if (audio.src !== entry.blobUrl) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  // Replacing audio from a different previously-playing zip → release it unless
  // it's still being browsed.
  if (state.zip && state.zip !== z && state.zip !== state.view) releaseZip(state.zip);
  state.zip = z;
  state.currentIndex = z.mainIndex;
  if (state.playlist[z.mainIndex]) state.selectedId = state.playlist[z.mainIndex].id;
  z.index = i;
  z.selIndex = i;
  playIntent = autoplay;

  const zipItem = state.playlist[z.mainIndex];
  if (!z.coverUrl) loadCover(z);

  if (!entry.blobUrl) {
    try {
      // Inflate only this one track, off the renderer thread.
      await loadZipEntryBlob(z, i);
      if (state.zip !== z || z.index !== i) return;
    } catch (e) {
      console.error('Failed to extract entry', entry.internalPath, e);
      if (state.zip !== z) return;
      if (i + 1 < z.entries.length) return playChapter(z, i + 1, autoplay);
      stopZipPlayback(true);
      return;
    }
  }
  // The archive may have been switched while we were inflating.
  if (state.zip !== z || z.index !== i) return;
  audio.src = entry.blobUrl;
  if (zipItem && resume) primeSubResume(zipItem, i, z); // auto-resume within chapter
  if (autoplay) audio.play().catch(() => {});
  updateNowPlaying();
  if (state.view === z) renderSubList();
  renderMainList();
}

// Play a chapter chosen from the displayed list (double-click) — promotes the
// viewed zip to be the playing one.
function playSub(i, autoplay = true) {
  if (state.view) playChapter(state.view, i, autoplay);
}

function nextSub(resume = true) {
  const z = state.zip;
  if (!z) return;
  if (z.index + 1 < z.entries.length) playChapter(z, z.index + 1, true, resume);
  else stopZipPlayback(true, resume); // end of archive → advance the main playlist
}

function prevSub() {
  const z = state.zip;
  if (!z) return;
  if (z.index > 0) playChapter(z, z.index - 1, true);
  else prevMain();
}

// Stop zip PLAYBACK only (the browse view is independent). advance=true →
// continue to the next main track after stopping.
function stopZipPlayback(advance, resume = true) {
  const z = state.zip;
  if (!z) return;
  invalidatePreloadedNext();
  forceSaveCurrent(false);
  const fromIndex = z.mainIndex;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.zip = null;
  if (state.view !== z) releaseZip(z); // keep blobs if still being browsed
  else renderSubList();                // drop the playing highlight in the view

  if (advance) {
    if (fromIndex + 1 < state.playlist.length) playIndex(fromIndex + 1, true, resume);
    else stopPlayback();
  }
}

// Close the browse panel — does NOT stop playback.
function closeView() {
  zipViewRequest++; // keep an in-flight browse request from reopening the panel
  const z = state.view;
  if (!z) return;
  state.view = null;
  el.subPanel.classList.add('hidden');
  el.subList.innerHTML = '';
  el.subCover.classList.add('hidden');
  el.subCoverImg.removeAttribute('src');
  if (z !== state.zip && (!preloadedNext || preloadedNext.z !== z)) releaseZip(z);
  lastScroll.sub = -1;
}

// Re-point the playing/viewed zip objects at their item after a reorder.
function remapZipIndices() {
  invalidatePreloadedNext();
  for (const z of [state.zip, state.view]) {
    if (!z) continue;
    const i = state.playlist.findIndex((it) => it.id === z.id);
    if (i >= 0) z.mainIndex = i;
  }
}

// ---------------------------------------------------------------------------
// Unified transport actions
// ---------------------------------------------------------------------------
// Start (or resume) playback from `from`, skipping unavailable files.
function startPlay(from) {
  const i = firstAvailableFrom(from, 1);
  if (i >= 0) playIndex(i, true);
  else stopPlayback();
}

function togglePlay() {
  cancelPendingAutoNext();
  if (state.currentIndex < 0) {
    if (state.playlist.length) startPlay(0);
    return;
  }
  const cur = state.playlist[state.currentIndex];
  // Nothing loaded yet (just dropped / zip not opened), or the current file is
  // unavailable → (re)start, skipping over missing entries.
  if ((!state.zip && !audio.src) || (cur && cur.missing && !state.zip)) {
    startPlay(state.currentIndex);
    return;
  }
  if (audio.paused) { playIntent = true; audio.play().catch(() => {}); }
  else { playIntent = false; audio.pause(); }
}

// Jump within the current track.
function seekBy(seconds) {
  if (!audio.src || !isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + seconds));
}

function next() {
  cancelPendingAutoNext();
  if (state.zip) nextSub();
  else nextMain();
}

function prev() {
  cancelPendingAutoNext();
  // Restart current track if we're more than 3s in.
  if (audio.src && audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.zip) prevSub();
  else prevMain();
}

function cancelPendingAutoNext() {
  autoNextRequest++;
  if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = null; }
  if (autoNextPromptOpen) {
    autoNextPromptOpen = false;
    closeModal();
  }
}

function finishAutoNext(spec, resume, request) {
  if (request !== autoNextRequest) return;
  if (spec) {
    const currentSpec = nextPlaybackSpec();
    if (!currentSpec || currentSpec.key !== spec.key) {
      cancelPendingAutoNext();
      return;
    }
  }
  autoNextRequest++;
  if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = null; }
  if (autoNextPromptOpen) {
    autoNextPromptOpen = false;
    closeModal();
  }
  if (spec && promotePreloadedNext(spec, resume)) return;
  if (state.zip) nextSub(resume);
  else nextMain(resume);
}

function promptAutoNextResume(spec, resume, request) {
  autoNextPromptOpen = true;
  openModal(
    'Continue from previous progress?',
    `<div class="modal-empty">The next file has saved progress at <b>${fmtClock(resume)}</b>.<br>Continuing from there automatically in 10 seconds.</div>`,
    [
      { label: 'Play from start', onClick: () => finishAutoNext(spec, false, request) },
      { label: 'Continue', primary: true, onClick: () => finishAutoNext(spec, true, request) }
    ],
    { closable: false }
  );
  autoNextTimer = setTimeout(() => finishAutoNext(spec, true, request), AUTO_NEXT_RESUME_TIMEOUT_MS);
}

async function onEnded() {
  const spec = nextPlaybackSpec();
  forceSaveCurrent(true); // mark the finished track / chapter complete
  const request = ++autoNextRequest;
  const resume = await savedSpecResume(spec);
  if (request !== autoNextRequest) return;
  if (resume > 0) promptAutoNextResume(spec, resume, request);
  else finishAutoNext(spec, true, request);
}

// ---------------------------------------------------------------------------
// Now-playing display & control sync
// ---------------------------------------------------------------------------
function updateNowPlaying() {
  if (state.zip) {
    const e = state.zip.entries[state.zip.index];
    // In the mini window the sub-line is hidden, so show "zip / track.ext".
    el.npTitle.textContent = (compactMode && e)
      ? `${state.zip.name} / ${e.name}`
      : (e ? e.name : state.zip.name);
    el.npSub.textContent = `📦 ${state.zip.name} — ${state.zip.index + 1}/${state.zip.entries.length}`;
  } else if (state.currentIndex >= 0) {
    const item = state.playlist[state.currentIndex];
    el.npTitle.textContent = item.name;
    el.npSub.textContent = `Track ${state.currentIndex + 1} of ${state.playlist.length}`;
  } else {
    el.npTitle.textContent = 'Nothing playing';
    el.npSub.textContent = 'Drop audio files or a .zip to begin';
  }
  refreshNowArt();
}

// Show the current item's cover (zip cover or embedded thumbnail) in the header;
// falls back to the app icon placeholder.
function refreshNowArt() {
  const url = state.zip
    ? state.zip.coverUrl
    : (state.currentIndex >= 0 ? state.playlist[state.currentIndex].thumbUrl : null);
  if (url) {
    el.npArtImg.src = url;
    el.npArtImg.classList.remove('hidden');
    el.npArt.classList.add('has-art');
  } else {
    el.npArtImg.removeAttribute('src');
    el.npArtImg.classList.add('hidden');
    el.npArt.classList.remove('has-art');
  }
}

function syncPlayButton() {
  const playing = !audio.paused && !!audio.src;
  el.playIcon.classList.toggle('hidden', playing);
  el.pauseIcon.classList.toggle('hidden', !playing);
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------
let lastVolume = 0.8;
function setVolume(v) {
  v = Math.max(0, Math.min(1, v));
  for (const player of [audio, standbyAudio]) {
    player.volume = v;
    player.muted = v === 0;
  }
  el.volume.value = String(Math.round(v * 100));
  el.muteBtn.classList.toggle('toggle-on', audio.muted);
}
function toggleMute() {
  if (audio.volume > 0 && !audio.muted) {
    lastVolume = audio.volume;
    setVolume(0);
  } else {
    setVolume(lastVolume || 0.8);
  }
}

// ---------------------------------------------------------------------------
// Playback speed (0.5×–3× in 0.5 steps)
// ---------------------------------------------------------------------------
// Loading new media resets playbackRate to defaultPlaybackRate, so we set both
// and re-apply on loadedmetadata to keep the chosen speed across tracks.
function applySpeedTo(player) {
  const rate = Number(el.speedSelect.value) || 1;
  player.defaultPlaybackRate = rate;
  player.playbackRate = rate;
}

function applySpeed() {
  applySpeedTo(audio);
  applySpeedTo(standbyAudio);
}

function syncPlayerSettings(player) {
  player.volume = audio.volume;
  player.muted = audio.muted;
  applySpeedTo(player);
}

// Set the speed programmatically (e.g. from the 1/2/3 keys) and keep the
// dropdown in sync. Only applies values the selector actually offers.
function setSpeed(rate) {
  const opt = [...el.speedSelect.options].find((o) => Number(o.value) === rate);
  if (!opt) return;
  el.speedSelect.value = opt.value;
  applySpeed();
}

// ---------------------------------------------------------------------------
// Sort & shuffle (requirement 9)
// ---------------------------------------------------------------------------
function rememberCurrentId() {
  return state.currentIndex >= 0 ? state.playlist[state.currentIndex].id : null;
}
function restoreCurrentById(id) {
  if (id == null) return;
  const i = state.playlist.findIndex((it) => it.id === id);
  if (i >= 0) state.currentIndex = i;
}

function sortList() {
  const id = rememberCurrentId();
  state.playlist.sort((a, b) => naturalCompare(a.name, b.name));
  restoreCurrentById(id);
  remapZipIndices();
  renderMainList();
}

function shuffleList() {
  const id = rememberCurrentId();
  const a = state.playlist;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  restoreCurrentById(id);
  remapZipIndices();
  renderMainList();
}

// ---------------------------------------------------------------------------
// Drag-to-reorder within the main playlist (requirement 8)
// ---------------------------------------------------------------------------
let dragFromIndex = -1;
function attachReorderHandlers(li) {
  li.addEventListener('dragstart', (e) => {
    dragFromIndex = Number(li.dataset.index);
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Mark as an internal reorder so the file-drop overlay stays hidden.
    e.dataTransfer.setData('application/x-sonobook-player-reorder', '1');
  });
  li.addEventListener('dragend', () => {
    dragFromIndex = -1;
    li.classList.remove('dragging');
    clearDropMarkers();
  });
  li.addEventListener('dragover', (e) => {
    if (dragFromIndex < 0) return; // external file drag handled elsewhere
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const before = isBeforeHalf(e, li);
    clearDropMarkers();
    li.classList.add(before ? 'drop-before' : 'drop-after');
  });
  li.addEventListener('drop', (e) => {
    if (dragFromIndex < 0) return;
    e.preventDefault();
    e.stopPropagation();
    let to = Number(li.dataset.index);
    const before = isBeforeHalf(e, li);
    reorder(dragFromIndex, to, before);
    clearDropMarkers();
  });
}

function isBeforeHalf(e, li) {
  const r = li.getBoundingClientRect();
  return (e.clientY - r.top) < r.height / 2;
}
function clearDropMarkers() {
  el.mainList.querySelectorAll('.drop-before, .drop-after')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after'));
}

function reorder(from, to, before) {
  if (from === to) return;
  const id = rememberCurrentId();
  const [moved] = state.playlist.splice(from, 1);
  // Recompute target index after removal.
  let insertAt = to;
  if (from < to) insertAt = before ? to - 1 : to;
  else insertAt = before ? to : to + 1;
  insertAt = Math.max(0, Math.min(state.playlist.length, insertAt));
  state.playlist.splice(insertAt, 0, moved);
  restoreCurrentById(id);
  remapZipIndices();
  renderMainList();
}

// ---------------------------------------------------------------------------
// External file drag & drop with split drop zone (requirement 4)
// ---------------------------------------------------------------------------
let dragDepth = 0;

function isFileDrag(e) {
  // True only for OS file drags, not internal reorder drags.
  if (dragFromIndex >= 0) return false;
  const types = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
  return types.includes('Files');
}

window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  el.dropOverlay.classList.remove('hidden');
});

window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (e) => {
  if (dragFromIndex >= 0) return;
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    hideOverlay();
  }
});

window.addEventListener('drop', (e) => {
  // Catch-all so files dropped anywhere don't navigate the window.
  if (dragFromIndex >= 0) return;
  e.preventDefault();
  hideOverlay();
});

function hideOverlay() {
  dragDepth = 0;
  el.dropOverlay.classList.add('hidden');
  el.dropAppend.classList.remove('hot');
  el.dropReplace.classList.remove('hot');
}

function pathsFromDrop(e) {
  const files = e.dataTransfer.files;
  const paths = [];
  for (const f of files) {
    const p = window.api.getPathForFile(f);
    if (p) paths.push(p);
  }
  return paths;
}

[['dropAppend', 'append'], ['dropReplace', 'replace']].forEach(([id, mode]) => {
  const zone = el[id];
  zone.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    zone.classList.add('hot');
  });
  zone.addEventListener('dragleave', (e) => {
    e.stopPropagation();
    zone.classList.remove('hot');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const paths = pathsFromDrop(e);
    hideOverlay();
    if (!paths.length) return;
    // "Clear & play" is destructive — confirm before wiping a non-empty list.
    if (mode === 'replace' && state.playlist.length) confirmReplaceDrop(paths);
    else addFiles(paths, mode);
  });
});

// Second confirmation step for a drag-drop that would clear the current list.
function confirmReplaceDrop(paths) {
  const n = state.playlist.length;
  openModal(
    'Clear current playlist?',
    `<div class="modal-empty">This removes the current ${n} track${n === 1 ? '' : 's'} and plays the dropped file${paths.length === 1 ? '' : 's'} instead.</div>`,
    [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Clear & play', danger: true, onClick: () => { closeModal(); addFiles(paths, 'replace'); } }
    ]
  );
}

// ---------------------------------------------------------------------------
// Playlist persistence — auto-saved session + named library
// ---------------------------------------------------------------------------
// Push the current list (paths + selection) to the main process; debounced and
// written atomically there. Called from renderMainList on every change.
function persistSession() {
  window.api.saveSession(state.playlist.map((it) => it.path), state.currentIndex);
}

// Rebuild the in-memory playlist from saved paths and re-select the last track.
async function restoreSession() {
  let s = null;
  try { s = await window.api.loadSession(); } catch (_) {}
  if (s && Array.isArray(s.paths) && s.paths.length) {
    state.playlist = s.paths.map(makeItem);
    renderMainList();
    const idx = s.currentIndex;
    if (Number.isInteger(idx) && idx >= 0 && idx < state.playlist.length) {
      playIndex(idx, false); // select & load (paused); saved position auto-resumes
    }
  }
  sessionReady = true; // from here on, changes auto-save
}

// Replace the whole list (Load / clear share the teardown).
function replacePlaylist(paths) {
  forceSaveCurrent(false);
  stopZipPlayback(false);
  closeView();
  revokeThumbs(state.playlist);
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.playlist = (paths || []).map(makeItem);
  state.currentIndex = -1;
  lastScroll.main = -1; // new list → allow the first scroll
  renderMainList();
  if (state.playlist.length) playIndex(0, false);
  updateNowPlaying();
}

// --- Clear (double confirmation) ---
let clearArmed = false;
let clearTimer = null;

function disarmClear() {
  clearArmed = false;
  if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
  const b = $('clearListBtn');
  b.classList.remove('armed');
  b.querySelector('span').textContent = 'Clear';
}

function onClearClick() {
  if (!clearArmed) {
    if (!state.playlist.length) return;
    clearArmed = true;
    const b = $('clearListBtn');
    b.classList.add('armed');
    b.querySelector('span').textContent = 'Confirm?';
    clearTimer = setTimeout(disarmClear, 3500);
    return;
  }
  disarmClear();
  replacePlaylist([]);
}

// --- Modal (save name / load picker) ---
let modalClosable = true;

function openModal(title, bodyHtml, actions, options = {}) {
  modalClosable = options.closable !== false;
  $('modalTitle').textContent = title;
  const body = $('modalBody');
  body.innerHTML = bodyHtml;
  const act = $('modalActions');
  act.innerHTML = '';
  (actions || []).forEach((a) => {
    const b = document.createElement('button');
    b.className = 'modal-btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '');
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    act.appendChild(b);
  });
  $('modalOverlay').classList.remove('hidden');
  return body;
}

function closeModal() {
  modalClosable = true;
  $('modalOverlay').classList.add('hidden');
  $('modalBody').innerHTML = '';
  $('modalActions').innerHTML = '';
}

// Save → export the current list to an .m3u file (OS save dialog in main).
async function exportPlaylistFlow() {
  if (!state.playlist.length) return;
  try { await window.api.exportPlaylist(state.playlist.map((it) => it.path)); } catch (_) {}
}

// Load → import an .m3u file (OS open dialog), then ask replace vs. append.
async function importPlaylistFlow() {
  let paths = null;
  try { paths = await window.api.importPlaylist(); } catch (_) {}
  if (!paths || !paths.length) return;
  // Expand dirs / drop non-audio + missing entries, preserving the file's order.
  const expanded = await expandPaths(paths);
  if (!expanded.length) return;
  // Only ask replace-vs-append when there's an existing list to lose.
  if (state.playlist.length) askReplaceOrAppend((mode) => applyImported(expanded, mode));
  else applyImported(expanded, 'replace');
}

function askReplaceOrAppend(cb) {
  openModal(
    'Import playlist',
    '<div class="modal-empty">Replace the current playlist, or add these tracks to the end?</div>',
    [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Add to end', onClick: () => { closeModal(); cb('append'); } },
      { label: 'Replace', primary: true, onClick: () => { closeModal(); cb('replace'); } }
    ]
  );
}

// Apply imported paths in file order (no natural-sort — the saved order wins).
function applyImported(paths, mode) {
  if (mode === 'replace') {
    replacePlaylist(paths);
  } else {
    const wasEmpty = state.playlist.length === 0;
    state.playlist.push(...paths.map(makeItem));
    renderMainList();
    if (wasEmpty) playIndex(0, false);
  }
}

// ---------------------------------------------------------------------------
// Progress reset / mark-finished (right-click actions)
// ---------------------------------------------------------------------------
const isCurrent = (item) => state.zip
  ? state.playlist[state.zip.mainIndex] === item
  : (state.currentIndex >= 0 && state.playlist[state.currentIndex] === item);

function commitRec(item, upd) {
  const fp = item.fingerprint;
  if (!fp) return;
  localMergeProgress(fp, upd);
  window.api.saveProgress(fp, upd);
  applyUnderline(item);
  if (state.view && state.playlist[state.view.mainIndex] === item) refreshSubUnderlines();
}

// Reset one entry's listened position (keeps the cached running time).
function resetItemProgress(item) {
  const rec = item.fingerprint && progressDB.items[item.fingerprint];
  if (!rec) return;
  let upd;
  if (item.kind === 'zip' && rec.e) {
    const e = {};
    for (const k of Object.keys(rec.e)) e[k] = [0, rec.e[k][1]]; // keep durations
    upd = { e, i: 0 };
  } else {
    upd = { p: 0 };
  }
  commitRec(item, upd);
  // Restart it only if it's the item currently producing audio.
  if (item.kind === 'zip') {
    if (state.zip && state.zip.id === item.id) playChapter(state.zip, 0, !audio.paused);
  } else if (isCurrent(item)) {
    audio.currentTime = 0;
  }
}

// Mark one entry as fully listened (fills bar/segments green).
function markFinished(item) {
  const rec = (item.fingerprint && progressDB.items[item.fingerprint]) || null;
  if (item.kind === 'zip') {
    if (!item.zipEntries) return;
    const bps = zipBytesPerSec(item, rec);
    const e = {};
    item.zipEntries.forEach((en, k) => {
      const t = rec && rec.e && rec.e[k];
      const dur = (t && t[1] > 0) ? t[1]
        : (bps > 0 && en.uncompressedSize > 0 ? Math.round(en.uncompressedSize * bps) : 0);
      if (dur > 0) e[k] = [dur, dur];
    });
    if (Object.keys(e).length) commitRec(item, { e, i: item.zipEntries.length - 1 });
  } else if (rec && rec.d > 0) {
    commitRec(item, { p: rec.d });
  }
}

function resetChapterProgress(idx) {
  const v = state.view;
  if (!v) return;
  const item = state.playlist[v.mainIndex];
  const rec = item && item.fingerprint && progressDB.items[item.fingerprint];
  if (!rec) return;
  const cur = rec.e && rec.e[idx];
  const dur = (cur && cur[1] > 0) ? cur[1] : null;
  commitRec(item, { e: { [idx]: [0, dur] } });
  if (state.zip === v && state.zip.index === idx) audio.currentTime = 0; // rewind if playing
}

function markChapterFinished(idx) {
  if (!state.view) return;
  const item = state.playlist[state.view.mainIndex];
  const rec = (item && item.fingerprint && progressDB.items[item.fingerprint]) || null;
  const en = item.zipEntries && item.zipEntries[idx];
  if (!en) return;
  const cur = rec && rec.e && rec.e[idx];
  const bps = zipBytesPerSec(item, rec);
  const dur = (cur && cur[1] > 0) ? cur[1]
    : (bps > 0 && en.uncompressedSize > 0 ? Math.round(en.uncompressedSize * bps) : 0);
  if (dur > 0) commitRec(item, { e: { [idx]: [dur, dur] } });
}

// Global wipe of all listened positions — double-confirmed.
function resetAllProgress() {
  openModal(
    'Reset all progress?',
    '<div class="modal-empty">Clears the listened position of <b>every</b> file. Running times are kept. This cannot be undone.</div>',
    [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Reset all', danger: true, onClick: (e) => {
        const btn = e.currentTarget;
        if (btn.dataset.armed !== '1') { // require a confirming second click
          btn.dataset.armed = '1';
          btn.textContent = 'Click again to confirm';
          return;
        }
        closeModal();
        doResetAllProgress();
      } }
    ]
  );
}

async function doResetAllProgress() {
  let db = null;
  try { db = await window.api.resetAllProgress(); } catch (_) {}
  if (db && db.items) progressDB = db;
  refreshAllUnderlines();
  if (state.view) refreshSubUnderlines();
}

// Remove every entry whose file no longer exists (bulk cleanup).
function removeMissingEntries() {
  const n = state.playlist.filter((it) => it.missing).length;
  if (!n) return;
  openModal(
    'Remove missing entries?',
    `<div class="modal-empty">Remove ${n} entr${n === 1 ? 'y' : 'ies'} whose file no longer exists?</div>`,
    [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Remove', danger: true, onClick: () => { closeModal(); doRemoveMissing(); } }
    ]
  );
}

function doRemoveMissing() {
  const cur = state.currentIndex >= 0 ? state.playlist[state.currentIndex] : null;
  const removingCurrent = !!(cur && cur.missing);
  const curId = cur && !removingCurrent ? cur.id : null;
  const gone = state.playlist.filter((it) => it.missing);
  // Tear down the playing/viewed zip if its file is among those removed.
  if (state.zip && gone.some((it) => it.id === state.zip.id)) stopZipPlayback(false);
  if (state.view && gone.some((it) => it.id === state.view.id)) closeView();
  revokeThumbs(gone);
  state.playlist = state.playlist.filter((it) => !it.missing);
  if (removingCurrent) {
    state.currentIndex = -1;
    audio.removeAttribute('src');
    audio.load();
    updateNowPlaying();
  } else {
    state.currentIndex = curId != null ? state.playlist.findIndex((it) => it.id === curId) : -1;
  }
  remapZipIndices();
  renderMainList();
}

// ---------------------------------------------------------------------------
// Per-entry reorder / queue / probe helpers (right-click actions)
// ---------------------------------------------------------------------------
function moveItem(from, toFinal) {
  if (from < 0 || from >= state.playlist.length) return;
  const id = rememberCurrentId();
  const [m] = state.playlist.splice(from, 1);
  const t = Math.max(0, Math.min(state.playlist.length, toFinal));
  state.playlist.splice(t, 0, m);
  restoreCurrentById(id);
  remapZipIndices();
  renderMainList();
}
const moveToTop = (i) => moveItem(i, 0);
const moveToBottom = (i) => moveItem(i, state.playlist.length);

// Move an entry to play right after the current track.
function playNext(i) {
  if (i < 0 || i >= state.playlist.length || i === state.currentIndex) return;
  if (state.currentIndex < 0) { moveItem(i, 0); return; }
  const curId = state.playlist[state.currentIndex].id;
  const [m] = state.playlist.splice(i, 1);
  const curIdx = state.playlist.findIndex((it) => it.id === curId);
  state.playlist.splice(curIdx + 1, 0, m);
  state.currentIndex = curIdx;
  remapZipIndices();
  renderMainList();
}

// Force a fresh duration probe for one entry (e.g. after a file downloads).
async function rescanDuration(item) {
  const fp = await ensureFingerprint(item).catch(() => null);
  if (!fp) return;
  if (item.kind === 'zip') {
    if (!item.zipEntries || !item.zipEntries.length) return;
    const dur = await window.api.zipFirstDuration(item.path, item.zipEntries[0].internalPath);
    if (!dur) return;
    const cur = (progressDB.items[fp] || {}).e || {};
    const pos0 = cur['0'] ? cur['0'][0] : 0;
    commitRec(item, { e: { 0: [pos0, Math.round(dur)] } });
  } else {
    const dur = await window.api.getDuration(item.path);
    if (dur) commitRec(item, { d: Math.round(dur) });
  }
}

// Browse a zip's chapter list in the sub-panel without disturbing playback.
function browseZip(i) {
  const item = state.playlist[i];
  if (!item || item.kind !== 'zip' || item.missing) return;
  if (state.view && state.view.id === item.id) return; // already viewing it
  openZip(item, i, false);
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
function showContextMenu(x, y, items) {
  const menu = $('ctxMenu');
  menu.innerHTML = '';
  items.forEach((it) => {
    if (it.separator) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      menu.appendChild(s);
      return;
    }
    const d = document.createElement('div');
    d.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
    d.textContent = it.label;
    if (!it.disabled) d.addEventListener('click', () => { closeContextMenu(); it.onClick(); });
    menu.appendChild(d);
  });
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.remove('hidden');
  // Clamp inside the viewport.
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = Math.max(4, window.innerWidth - r.width - 6) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = Math.max(4, window.innerHeight - r.height - 6) + 'px';
}

function closeContextMenu() { $('ctxMenu').classList.add('hidden'); }

// Single-click selection (highlight only; never touches playback).
function selectMain(i) {
  const item = state.playlist[i];
  if (!item) return;
  state.selectedId = item.id;
  if (item.kind !== 'zip') closeView();
  renderMainList();
}
function selectSub(i) {
  if (!state.view) return;
  state.view.selIndex = i;
  renderSubList();
}

// Right-click menu for a main entry — item-specific actions only.
function openEntryMenu(e, i) {
  const item = state.playlist[i];
  if (!item) return;
  const hasProgress = !!(item.fingerprint && progressDB.items[item.fingerprint]);
  const last = state.playlist.length - 1;
  const items = [
    { label: 'Play', onClick: () => playIndex(i) },
    { label: 'Play next', disabled: state.currentIndex < 0 || i === state.currentIndex, onClick: () => playNext(i) }
  ];
  if (item.kind === 'zip') items.push({ label: 'Open (show chapters)', disabled: item.missing, onClick: () => browseZip(i) });
  items.push(
    { separator: true },
    { label: 'Reset progress', disabled: !hasProgress, onClick: () => resetItemProgress(item) },
    { label: 'Mark as finished', onClick: () => markFinished(item) },
    { label: 'Re-scan duration', onClick: () => rescanDuration(item) },
    { separator: true },
    { label: 'Move to top', disabled: i === 0, onClick: () => moveToTop(i) },
    { label: 'Move to bottom', disabled: i === last, onClick: () => moveToBottom(i) },
    { separator: true },
    { label: 'Reveal in file manager', onClick: () => window.api.revealFile(item.path) },
    { label: 'Copy file path', onClick: () => window.api.copyText(item.path) },
    { label: 'Copy file name', onClick: () => window.api.copyText(item.name) },
    { separator: true },
    { label: 'Remove from playlist', onClick: () => removeItem(i) }
  );
  showContextMenu(e.clientX, e.clientY, items);
}

// Right-click menu for a zip chapter — item-specific actions only.
function openSubMenu(e, idx) {
  showContextMenu(e.clientX, e.clientY, [
    { label: 'Play', onClick: () => playSub(idx) },
    { separator: true },
    { label: 'Reset progress', onClick: () => resetChapterProgress(idx) },
    { label: 'Mark as finished', onClick: () => markChapterFinished(idx) }
  ]);
}

// Global/bulk actions, anchored under the playlist header's "⋮" button.
function showGlobalMenu(rect) {
  const n = state.playlist.filter((it) => it.missing).length;
  showContextMenu(rect.left, rect.bottom + 4, [
    { label: 'Reset all progress…', danger: true, onClick: resetAllProgress },
    { label: n ? `Remove missing entries (${n})` : 'Remove missing entries', disabled: !n, onClick: removeMissingEntries }
  ]);
}

// ---------------------------------------------------------------------------
// Wiring: buttons, audio events, media keys
// ---------------------------------------------------------------------------
$('saveListBtn').addEventListener('click', exportPlaylistFlow);
$('loadListBtn').addEventListener('click', importPlaylistFlow);
$('clearListBtn').addEventListener('click', onClearClick);

// Playlist-header "⋮" → global/bulk actions menu.
$('listMenuBtn').addEventListener('click', (e) => {
  e.stopPropagation(); // don't let the window-click handler immediately close it
  showGlobalMenu(e.currentTarget.getBoundingClientRect());
});

// Backdrop click / Esc closes dismissible modals.
$('modalOverlay').addEventListener('mousedown', (e) => {
  if (e.target === $('modalOverlay') && modalClosable) closeModal();
});
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeContextMenu();
  if (!$('modalOverlay').classList.contains('hidden')) {
    e.preventDefault();
    if (modalClosable) closeModal();
  }
}, true);

// Right-click context menus on the playlists.
el.mainList.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('.track[data-index]');
  if (!li) return;
  e.preventDefault();
  openEntryMenu(e, Number(li.dataset.index));
});
el.subList.addEventListener('contextmenu', (e) => {
  if (!state.view) return;
  const li = e.target.closest('.track');
  if (!li) return;
  e.preventDefault();
  const idx = Array.prototype.indexOf.call(el.subList.children, li);
  if (idx >= 0) openSubMenu(e, idx);
});
// Dismiss the menu on any outside interaction.
window.addEventListener('click', closeContextMenu);
window.addEventListener('blur', closeContextMenu);
window.addEventListener('resize', closeContextMenu);
window.addEventListener('contextmenu', (e) => { if (!e.target.closest('.track')) closeContextMenu(); });
document.addEventListener('scroll', closeContextMenu, true);

el.playBtn.addEventListener('click', togglePlay);
el.prevBtn.addEventListener('click', prev);
el.nextBtn.addEventListener('click', next);
el.sortBtn.addEventListener('click', sortList);
el.shuffleBtn.addEventListener('click', shuffleList);
el.muteBtn.addEventListener('click', toggleMute);
el.closeSubBtn.addEventListener('click', closeView); // close the browse panel; keep playing

// Full / compact (mini-player) mode toggle.
let compactMode = false;
function setCompactMode(on) {
  compactMode = on;
  document.body.classList.toggle('compact', on);
  el.compactIcon.classList.toggle('hidden', on);
  el.expandIcon.classList.toggle('hidden', !on);
  el.compactBtn.title = on ? 'Exit compact mode' : 'Compact mode';
  window.api.setCompact(on);
  updateNowPlaying(); // title format differs between full/compact for zips
}
el.compactBtn.addEventListener('click', () => setCompactMode(!compactMode));

el.volume.addEventListener('input', () => setVolume(Number(el.volume.value) / 100));
el.speedSelect.addEventListener('change', applySpeed);

el.seek.addEventListener('input', () => {
  if (audio.duration) {
    audio.currentTime = (Number(el.seek.value) / 1000) * audio.duration;
  }
});

function bindPlayerEvents(player) {
  player.addEventListener('play', () => {
    if (player !== audio) return;
    playIntent = true;
    syncPlayButton();
    renderMainList();
    renderSubList();
    maybePreloadNextPlayback();
  });
  player.addEventListener('pause', () => {
    if (player !== audio) return;
    syncPlayButton(); renderMainList(); renderSubList();
    if (!audio.ended) forceSaveCurrent(false); // persist on pause (end handled by onEnded)
  });
  player.addEventListener('ended', () => {
    if (player === audio) onEnded();
  });
  player.addEventListener('timeupdate', () => {
    if (player !== audio) return;
    el.curTime.textContent = fmtTime(audio.currentTime);
    if (audio.duration) {
      el.seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    }
    // Update the underline live; persist to disk at most every ~5s.
    const snap = captureSnapshot(false);
    if (snap && snap.item.fingerprint) {
      const now = Date.now();
      const ipc = now - lastSaveTs > 5000;
      persistProgress(snap, ipc);
      if (ipc) lastSaveTs = now;
    }
    maybePreloadNextPlayback();
  });
  player.addEventListener('loadedmetadata', () => {
    if (player !== audio) {
      if (player === standbyAudio) applyPreparedSeek(player, preloadedNext);
      return;
    }
    el.durTime.textContent = fmtTime(audio.duration);
    applySpeedTo(audio); // new media resets the rate; restore the selected speed
    applyPendingSeek(); // auto-resume once we know the duration
    maybePreloadNextPlayback();
  });
  player.addEventListener('error', () => {
    if (player !== audio) return;
    // Auto-skip a track that fails to load — but only while actively playing, so a
    // merely-selected (e.g. session-restored) unavailable file doesn't auto-advance.
    if (playIntent && (state.currentIndex >= 0 || state.zip)) setTimeout(next, 250);
  });
}
bindPlayerEvents(audio);
bindPlayerEvents(standbyAudio);

// Keyboard shortcuts (within the window) in addition to OS media keys.
//   Space            play / pause
//   ← / →            seek -5s / +5s
//   Ctrl+← / Ctrl+→  seek -30s / +30s
//   ↑ / ↓            volume up / down
//   PageUp/PageDown  previous / next track
//   Cmd+← / Cmd+→    previous / next track
const VOL_STEP = 0.05;
window.addEventListener('keydown', (e) => {
  if (!$('modalOverlay').classList.contains('hidden')) return; // modal owns the keyboard
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  switch (e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight':
      e.preventDefault();
      if (e.metaKey) next();
      else if (e.ctrlKey) seekBy(30);
      else seekBy(5);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.metaKey) prev();
      else if (e.ctrlKey) seekBy(-30);
      else seekBy(-5);
      break;
    case 'ArrowUp': e.preventDefault(); setVolume(audio.volume + VOL_STEP); break;
    case 'ArrowDown': e.preventDefault(); setVolume(audio.volume - VOL_STEP); break;
    case 'PageUp': e.preventDefault(); prev(); break;
    case 'PageDown': e.preventDefault(); next(); break;
    // 1 / 2 / 3 → playback speed 1× / 2× / 3× (top-row and numpad).
    case 'Digit1': case 'Numpad1': e.preventDefault(); setSpeed(1); break;
    case 'Digit2': case 'Numpad2': e.preventDefault(); setSpeed(2); break;
    case 'Digit3': case 'Numpad3': e.preventDefault(); setSpeed(3); break;
  }
});

// OS media keys (requirement 7).
window.api.onMediaKey((key) => {
  switch (key) {
    case 'media-playpause': togglePlay(); break;
    case 'media-next': next(); break;
    case 'media-prev': prev(); break;
    case 'media-stop': stopPlayback(); break;
    case 'media-volup': setVolume(audio.volume + 0.05); break;
    case 'media-voldown': setVolume(audio.volume - 0.05); break;
    case 'media-volmute': toggleMute(); break;
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
// Persist position + playlist when the window is closing (main flushes on quit).
window.addEventListener('beforeunload', () => { forceSaveCurrent(false); persistSession(); });

setVolume(0.8);
applySpeed();
renderMainList(); // initial empty paint (sessionReady is still false → no save)
updateNowPlaying();
syncPlayButton();

// Load the listened-time DB first, then restore the saved session so per-file
// resume positions are available when the last track is re-selected.
window.api.loadProgress()
  .then((dbData) => { if (dbData && dbData.items) progressDB = dbData; })
  .catch(() => {})
  .finally(() => { refreshAllUnderlines(); restoreSession(); });
