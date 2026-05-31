# Sonobook Player

A simple cross-platform audio player built with Electron.
It plays ordinary audio files and audio bundled inside `.zip` archives.

Current app version: `0.2`

## Features

- **Desktop app** - runs on Windows, macOS, and Linux through Electron.
- **Audio and zip playback** - play normal audio files, or open a `.zip` and browse/play the audio entries inside it.
- **Secondary archive playlist** - when a zip is selected, the app shows the archive's internal audio list without replacing the main playlist.
- **Archive cover art** - if a zip contains an image (`jpg`, `png`, `gif`, `webp`, `bmp`, or `avif`), it is shown as archive art. Names such as `cover`, `folder`, `front`, `album`, and `art` are preferred.
- **Per-track thumbnails** - playlist rows show embedded album art for audio files or archive art for zip items when available.
- **Natural ordering** - multiple dropped files are sorted in numeric-friendly order, so `aaa2` comes before `aaa10`.
- **Smart drag and drop** - drop files or folders onto the window, then choose whether to append them or replace the playlist.
- **Playback controls** - previous, play/pause, next, seek, mute, volume, and playback speed controls.
- **Playback speed shortcuts** - `1`, `2`, and `3` switch directly to 1x, 2x, and 3x speed.
- **Global media keys** - Play/Pause, Next, Previous, and best-effort volume keys are registered globally. On macOS, hardware media keys may require Accessibility permission.
- **Playlist management** - reorder by dragging, natural sort, shuffle, clear, and import/export `.m3u` playlists.
- **Compact mini-player** - shrink the window to a small always-on-top player with artwork, now-playing text, transport controls, volume, speed, and seek.
- **Persistent progress** - listened positions and playlist session data are stored under the OS application-data directory, not beside the installed app.

## Run It

```bash
cd sonobook
npm install
npm run icons
npm start
```

`npm run icons` renders `assets/icon.svg` into the raster icons used by Electron and installer packaging:

- `assets/icon.png`
- `assets/icon.ico`
- `assets/icon.icns`

## Build Installers

```bash
npm run dist          # current platform
npm run dist:mac      # dmg and zip
npm run dist:win      # NSIS installer and portable build
npm run dist:linux    # AppImage and deb
```

Each `dist` script runs `npm run sync-version` first, then regenerates icons, then runs `electron-builder`.

On Windows, Electron Builder may need permission to create symlinks while extracting its signing helper cache. If a normal Windows build fails there, enabling Developer Mode or running from an elevated shell usually resolves it.

## Versioning

Version information is managed from [version.js](./version.js).

The version stub currently defines:

```js
const version = '0.2';
```

That single stub is used for:

- the app window title and visible header: `Sonobook Player v0.2`
- Git tag name: `v0.2`
- package metadata for distribution

npm and Electron Builder require strict SemVer, so the packaging version is derived as `0.2.0` and synced into `package.json` and `package-lock.json`.

Useful commands:

```bash
npm run sync-version      # sync package.json and package-lock.json from version.js
npm run tag               # create local annotated tag v0.2
npm run github:tag        # sync version, create the tag if needed, and push it to origin
```

The tag script is idempotent for an existing local tag. For a non-mutating check, run:

```bash
npm run tag -- --dry-run
```

## Keyboard Shortcuts

| Key | Action |
| --- | --- |
| Space | Play / Pause |
| Left / Right | Seek -5s / +5s |
| Ctrl + Left / Right | Seek -30s / +30s |
| Up / Down | Volume up / down |
| PageUp / PageDown | Previous / Next track |
| Cmd + Left / Right | Previous / Next track on macOS |
| 1 / 2 / 3 | Playback speed 1x / 2x / 3x |

Dropping files loads the first track but does not start playback. Press Space or Play to begin.

The app also listens for OS media keys when the platform allows it.

## Supported Audio

`mp3`, `m4a`, `m4b`, `aac`, `wav`, `flac`, `ogg`, `oga`, `opus`, `weba`, `webm`, `aiff`, `wma`, and `mp4`.

Support ultimately depends on what Chromium can decode. Files with unsupported codecs are skipped automatically.

## Runtime Data

Runtime-generated files are stored under the OS-standard app-data directory for `Sonobook Player`, including:

- progress database
- session playlists
- logs
- caches
- crash dumps

The installed app directory stays read-only.

## Implementation Notes

- The renderer loads local media through `file://` URLs, so the Electron window uses `webSecurity: false`.
- Zip handling is streamed in the main process through `yauzl`.
- Zip listing reads only the archive central directory.
- Zip track and cover reads inflate one entry at a time, on demand.
- Extracted blob URLs are released when the archive closes.
- The preload script exposes a small `window.api` bridge for filesystem, zip, progress, playlist, media-key, and app-version operations.
