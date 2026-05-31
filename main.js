'use strict';

const { app, BrowserWindow, globalShortcut, nativeImage, ipcMain, systemPreferences, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const yauzl = require('yauzl');
const db = require('./db');
const playlists = require('./playlists');

let mainWindow = null;

// Audio extensions — kept in sync with the renderer; used by the zip fingerprint
// so it hashes only the audio chapters (a re-saved cover image won't reset it).
const FP_AUDIO_EXT = new Set([
  'mp3', 'm4a', 'm4b', 'aac', 'wav', 'wave', 'flac', 'ogg', 'oga',
  'opus', 'weba', 'webm', 'aiff', 'aif', 'aifc', 'wma', 'mp4'
]);
function isAudioName(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 && FP_AUDIO_EXT.has(name.slice(i + 1).toLowerCase());
}

function resolveIcon() {
  // Prefer a platform-rendered raster icon if it has been generated,
  // otherwise fall back to the SVG (used by the renderer/dock where possible).
  const png = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(png)) {
    const img = nativeImage.createFromPath(png);
    if (!img.isEmpty()) return img;
  }
  return undefined;
}

function createWindow() {
  const icon = resolveIcon();

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0a0a0a',
    title: 'Sonobook Player',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow loading local audio files directly via file:// URLs.
      webSecurity: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  if (process.platform === 'darwin' && icon) {
    app.dock && app.dock.setIcon(icon);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel);
  }
}

// Transport keys — reliably supported across platforms.
const TRANSPORT_KEYS = {
  MediaPlayPause: 'media-playpause',
  MediaNextTrack: 'media-next',
  MediaPreviousTrack: 'media-prev',
  MediaStop: 'media-stop'
};
// Volume keys — best effort; on most OSes these are owned by the system.
const VOLUME_KEYS = {
  VolumeUp: 'media-volup',
  VolumeDown: 'media-voldown',
  VolumeMute: 'media-volmute'
};

// Register a map of accelerators; returns true if at least one is now active.
// These are GLOBAL — they fire even when the app is unfocused / in the
// background, which is the whole point of using globalShortcut.
function registerKeys(map) {
  let any = false;
  for (const [accel, channel] of Object.entries(map)) {
    if (globalShortcut.isRegistered(accel)) { any = true; continue; }
    try { if (globalShortcut.register(accel, () => send(channel))) any = true; } catch (_) {}
  }
  return any;
}

let accessibilityPrompted = false;
function registerMediaKeys() {
  const transportOk = registerKeys(TRANSPORT_KEYS);
  registerKeys(VOLUME_KEYS);

  // macOS gates hardware media keys behind Accessibility permission; until it's
  // granted, registration silently fails. Guide the user there once.
  if (!transportOk && process.platform === 'darwin' && !accessibilityPrompted) {
    accessibilityPrompted = true;
    if (!systemPreferences.isTrustedAccessibilityClient(false)) promptAccessibility();
  }
  return transportOk;
}

function promptAccessibility() {
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'info',
    title: 'Enable background media keys',
    message: 'Let Sonobook Player respond to the keyboard media keys',
    detail: 'macOS requires Accessibility permission for an app to receive the ▶︎ / ⏭ / ⏮ media keys while it is in the background.\n\nOpen System Settings → Privacy & Security → Accessibility, enable Sonobook Player, then return to the app — the keys will start working automatically.',
    buttons: ['Open Settings', 'Later'],
    defaultId: 0,
    cancelId: 1
  }).then(({ response }) => {
    if (response === 0) {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
  }).catch(() => {});
}

// --- IPC: file system access for the renderer ---
ipcMain.handle('stat-file', async (_evt, filePath) => {
  const s = await fs.promises.stat(filePath);
  return { size: s.size, isDirectory: s.isDirectory() };
});

// Lightweight existence check that never throws/logs (used to flag dead entries).
ipcMain.handle('path-exists', async (_evt, filePath) => {
  try { await fs.promises.access(filePath); return true; } catch (_) { return false; }
});

// --- IPC: zip access via yauzl (reads only the central directory + the one
//     requested entry; never inflates the whole archive, never blocks the
//     renderer since it runs here in the main process). ---
function openZipFile(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) reject(err); else resolve(zip);
    });
  });
}

// List entry names without decompressing anything. crc32 + uncompressedSize come
// straight from the central directory (no inflation) and feed both the progress
// fingerprint and the zip's listened-time duration estimate.
ipcMain.handle('zip-list', async (_evt, filePath) => {
  try {
    const zip = await openZipFile(filePath);
    return await new Promise((resolve) => {
      const out = [];
      zip.on('entry', (entry) => {
        if (!/\/$/.test(entry.fileName)) {
          out.push({
            internalPath: entry.fileName,
            crc32: entry.crc32,
            uncompressedSize: entry.uncompressedSize
          });
        }
        zip.readEntry();
      });
      zip.on('end', () => { zip.close(); resolve(out); });
      zip.on('error', () => { try { zip.close(); } catch (_) {} resolve([]); });
      zip.readEntry();
    });
  } catch (_) {
    return []; // unreadable / locked / online-only — treat as no entries
  }
});

// --- IPC: content fingerprints (never read the whole file) ---

// Audio: sha256 of size + first 64KB + next-up-to-64KB tail. Reads <=128KB
// regardless of file size. Truncated to 128 bits (collision-safe, compact key).
ipcMain.handle('fingerprint-file', async (_evt, filePath) => {
  const CHUNK = 65536;
  let fd = null;
  try {
    const st = await fs.promises.stat(filePath);
    const size = st.size;
    fd = await fs.promises.open(filePath, 'r');
    const hash = crypto.createHash('sha256');
    const sizeBuf = Buffer.alloc(8);
    sizeBuf.writeBigUInt64LE(BigInt(size));
    hash.update(sizeBuf);

    const headLen = Math.min(CHUNK, size);
    if (headLen > 0) {
      const buf = Buffer.alloc(headLen);
      await fd.read(buf, 0, headLen, 0);
      hash.update(buf);
    }
    // Tail: the region after the head (no overlap), up to 64KB.
    if (size > CHUNK) {
      const tailLen = Math.min(CHUNK, size - CHUNK);
      const buf = Buffer.alloc(tailLen);
      await fd.read(buf, 0, tailLen, size - tailLen);
      hash.update(buf);
    }
    return 'a1:' + hash.digest('hex').slice(0, 32);
  } catch (_) {
    return null; // unreadable (locked / online-only) — no fingerprint
  } finally {
    if (fd) await fd.close();
  }
});

// Zip: sha256 over the sorted "name:size:crc32" lines of audio entries, read
// from the central directory only (no inflation). crc32 is a free content hash.
ipcMain.handle('fingerprint-zip', async (_evt, filePath) => {
  try {
    const zip = await openZipFile(filePath);
    return await new Promise((resolve) => {
      const lines = [];
      zip.on('entry', (entry) => {
        if (!/\/$/.test(entry.fileName) && isAudioName(entry.fileName)) {
          lines.push(`${entry.fileName}:${entry.uncompressedSize}:${entry.crc32}`);
        }
        zip.readEntry();
      });
      zip.on('end', () => {
        zip.close();
        lines.sort();
        const hex = crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
        resolve('z1:' + hex.slice(0, 32));
      });
      zip.on('error', () => { try { zip.close(); } catch (_) {} resolve(null); });
      zip.readEntry();
    });
  } catch (_) {
    return null; // unreadable / locked / online-only — no fingerprint
  }
});

// --- IPC: progress database ---
ipcMain.handle('progress-load', () => db.getAll());
ipcMain.handle('progress-save', (_evt, fp, rec) => { db.put(fp, rec); });
// Zero every file's listened position (running times kept); returns updated map.
ipcMain.handle('progress-reset-all', () => { db.resetAllPositions(); return db.getAll(); });

// --- IPC: small OS integrations for the context menu ---
ipcMain.handle('reveal-file', (_evt, filePath) => { shell.showItemInFolder(filePath); });
ipcMain.handle('copy-text', (_evt, text) => { clipboard.writeText(String(text || '')); });

// --- IPC: playlist session (auto-saved current list) ---
ipcMain.handle('playlist-load-session', () => playlists.getSession());
ipcMain.on('playlist-save-session', (_evt, paths, currentIndex) => playlists.setSession(paths, currentIndex));

// --- IPC: playlist export / import as real .m3u files (OS file dialogs) ---
ipcMain.handle('playlist-export', async (_evt, paths) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow || undefined, {
    title: 'Export playlist',
    defaultPath: 'playlist.m3u',
    filters: [{ name: 'Playlist', extensions: ['m3u', 'm3u8'] }]
  });
  if (canceled || !filePath) return { ok: false };
  const body = '#EXTM3U\n' + (Array.isArray(paths) ? paths : []).join('\n') + '\n';
  await fs.promises.writeFile(filePath, body, 'utf8');
  return { ok: true };
});

ipcMain.handle('playlist-import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Import playlist',
    properties: ['openFile'],
    filters: [
      { name: 'Playlist', extensions: ['m3u', 'm3u8'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (canceled || !filePaths || !filePaths.length) return null;
  const text = await fs.promises.readFile(filePaths[0], 'utf8');
  const base = path.dirname(filePaths[0]);
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue; // skip blanks + #EXTM3U/#EXTINF
    out.push(path.isAbsolute(line) ? line : path.resolve(base, line)); // relative → resolve
  }
  return out;
});

// Inflate a single entry to a Node Buffer (used by zip-entry + duration probe).
function readEntryBuffer(filePath, internalPath) {
  return new Promise((resolve, reject) => {
    openZipFile(filePath).then((zip) => {
      let found = false;
      const fail = (e) => { try { zip.close(); } catch (_) {} reject(e); };
      zip.on('entry', (entry) => {
        if (entry.fileName !== internalPath) { zip.readEntry(); return; }
        found = true;
        zip.openReadStream(entry, (err, stream) => {
          if (err) return fail(err);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', fail);
          stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks)); });
        });
      });
      zip.on('end', () => { if (!found) fail(new Error('entry not found: ' + internalPath)); });
      zip.on('error', fail);
      zip.readEntry();
    }, reject);
  });
}

// Inflate and return the bytes of a single entry only.
ipcMain.handle('zip-entry', async (_evt, filePath, internalPath) => {
  const b = await readEntryBuffer(filePath, internalPath);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
});

// music-metadata is ESM-only; load it lazily via dynamic import.
let mmPromise = null;
const getMM = () => (mmPromise || (mmPromise = import('music-metadata')));

ipcMain.handle('get-artwork', async (_evt, filePath) => {
  try {
    const mm = await getMM();
    const meta = await mm.parseFile(filePath, { duration: false, skipCovers: false });
    const pics = meta.common && meta.common.picture;
    if (pics && pics.length) {
      const pic = pics[0];
      const u8 = pic.data;
      return {
        mime: pic.format || 'image/jpeg',
        data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
      };
    }
  } catch (_) { /* no/unreadable tags */ }
  return null;
});

// Duration of an audio file (seconds) via music-metadata — header-based, no
// playback. Used to lazily fill in running times for the playlist.
ipcMain.handle('get-duration', async (_evt, filePath) => {
  try {
    const mm = await getMM();
    const meta = await mm.parseFile(filePath, { duration: true });
    const d = meta && meta.format && meta.format.duration;
    return (typeof d === 'number' && d > 0) ? d : null;
  } catch (_) { return null; }
});

// Duration (seconds) of one zip entry — inflates just that entry and parses it.
// Lets the renderer seed a bytes→seconds rate to estimate the other chapters.
ipcMain.handle('zip-first-duration', async (_evt, filePath, internalPath) => {
  try {
    const buf = await readEntryBuffer(filePath, internalPath);
    const mm = await getMM();
    const meta = await mm.parseBuffer(buf, undefined, { duration: true });
    const d = meta && meta.format && meta.format.duration;
    return (typeof d === 'number' && d > 0) ? d : null;
  } catch (_) { return null; }
});

ipcMain.handle('list-dir', async (_evt, dirPath) => {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  return entries.map((e) => ({
    name: e.name,
    path: path.join(dirPath, e.name),
    isDirectory: e.isDirectory()
  }));
});

// Resize the window when toggling the compact mini-player.
let savedBounds = null;
ipcMain.on('set-compact', (_evt, compact) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (compact) {
    savedBounds = mainWindow.getBounds();
    mainWindow.setMinimumSize(300, 130);
    mainWindow.setSize(400, 150, true);
    mainWindow.setAlwaysOnTop(true);
  } else {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setMinimumSize(760, 520);
    if (savedBounds) mainWindow.setBounds(savedBounds, true);
    else mainWindow.setSize(1040, 720, true);
  }
});

app.whenReady().then(() => {
  db.load(app.getPath('userData'));
  playlists.load(app.getPath('userData'));
  createWindow();
  registerMediaKeys();

  // If media keys weren't available at launch (e.g. macOS Accessibility was
  // just granted), retry whenever the app regains focus. isRegistered guards
  // make this a no-op once they're active.
  app.on('browser-window-focus', () => {
    if (!globalShortcut.isRegistered('MediaPlayPause')) {
      registerKeys(TRANSPORT_KEYS);
      registerKeys(VOLUME_KEYS);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  db.flush();
  playlists.flush();
});

app.on('window-all-closed', () => {
  // Quit on every platform when the window is closed (including macOS).
  app.quit();
});
