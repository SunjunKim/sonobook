# ZipTune 🎧

A simple, cross-platform (Windows / macOS / Linux) audio player built with Electron.
It plays ordinary audio files **and** audio bundled inside `.zip` archives.

## Features

- **Universal desktop app** — runs on Windows, macOS and Linux (Electron).
- **Headphone app icon** — orange headphones on a black background (`assets/icon.svg`).
- **Standard transport UI** — previous / play-pause / next, a volume slider with mute, a seek bar with current/total playtime, and a playlist.
- **Playback speed** — a speed selector beside the transport buttons (0.5×–3× in 0.5× steps); the `1` / `2` / `3` keys jump straight to 1× / 2× / 3×. The chosen speed is kept across track changes.
- **Smart drag & drop** — drag files/folders onto the window and the drop area splits in two:
  - **Add to end of playlist**
  - **Clear list & play this**
- **Zip playback** — play a `.zip` and a **secondary playlist** opens listing the audio files inside; they play in order. When the archive finishes (or you pick another main track), the secondary list closes and playback moves to the next item.
- **Archive cover art** — if the zip contains an image (jpg/png/gif/webp/bmp/avif), it's shown as a cover above the secondary playlist. Names like `cover`, `folder`, `front`, `album`, or `art` are preferred; otherwise the first image is used.
- **Per-track thumbnails** — each playlist row shows a small cover icon on the left: embedded album art for audio files (parsed via `music-metadata`), or the inner image for `.zip` items. Thumbnails load lazily and fall back to the track number.
- **Natural ordering** — multiple dropped files are sorted so `aaa1, aaa2 … aaa9, aaa10, aaa11, aaa12` order numerically, not lexically.
- **Media keys** — Play/Pause, Next, Previous (and best-effort volume keys) are registered **globally**, so they control playback even when ZipTune is in the background. Works out of the box on Windows/Linux. On **macOS**, receiving the hardware media keys requires Accessibility permission — the app detects this and prompts you to open System Settings → Privacy & Security → Accessibility; once granted, the keys start working automatically.
- **Reorder by drag** — drag tracks within the playlist to change their order.
- **Sort / Shuffle** — buttons at the bottom-left of the controls: natural A→Z sort and random shuffle.
- **Compact mini-player mode** — the toggle in the top-right shrinks the window to a small always-on-top player showing just the now-playing cover + title, prev/play/next, volume, the speed selector, and the seek bar with current/total playtime. Toggle again to restore the full window.

## Run it

```bash
cd audio-player
npm install
npm run icons   # render icon.png / icon.ico / icon.icns from the SVG
npm start
```

## Build installers

```bash
npm run dist          # current platform
npm run dist:mac      # .dmg / .zip
npm run dist:win      # NSIS installer + portable
npm run dist:linux    # AppImage + .deb
```

## Keyboard shortcuts (in-window)

| Key | Action |
| --- | --- |
| Space | Play / Pause |
| ← / → | Seek −5s / +5s |
| Ctrl + ← / → | Seek −30s / +30s |
| ↑ / ↓ | Volume up / down |
| PageUp / PageDown | Previous / Next track |
| Cmd + ← / → | Previous / Next track |
| 1 / 2 / 3 | Playback speed 1× / 2× / 3× |

Dropping files loads the first track but does **not** start playback — press Space (or Play) to begin.

Plus the OS media keys (▶❚❚, ⏭, ⏮).

## Supported audio

mp3, m4a, m4b, aac, wav, flac, ogg, oga, opus, weba/webm, aiff, wma, mp4 — anything Chromium can decode. Files with unsupported codecs are skipped automatically.

## Notes

- File loading uses `webSecurity: false` so local `file://` media can be read directly.
- **Zip handling is streamed in the main process via `yauzl`** — listing reads only the archive's central directory, and a track or cover image is inflated one entry at a time, on demand. The whole archive is never loaded into memory or parsed on the UI thread, so dropping several large zips stays responsive. Extracted blob URLs are released when the archive closes.
- Global volume media keys are owned by the OS on most systems; ZipTune registers them best-effort and always falls back to its own volume slider / in-window shortcuts.
