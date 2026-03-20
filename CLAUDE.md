# Blob — Video Downloader + Image Scraper

A Flask + yt-dlp web app for downloading videos, and a gallery-dl-powered image scraper for bulk-downloading public social media profile images (Instagram, Facebook, 100+ sites). Opens in the browser at `http://localhost:5000`.

## Running the app

```bash
pip install -r requirements.txt
python app.py
```

The browser does **not** open automatically — navigate to `http://localhost:5000` yourself. Downloads land in `./downloads/`.

## Stack

- **Backend:** Python + Flask (single file: `app.py`)
- **Video engine:** `yt-dlp` Python library (not CLI)
- **Image scraper:** `gallery-dl` Python library (not CLI) — v1.31.10 installed
- **Frontend:** Vanilla HTML/CSS/JS — no build tools, no frameworks

## Key architecture decisions

- Each download runs in its own `threading.Thread` — fully parallel, no queue
- Progress is tracked in a shared `downloads_progress` dict (protected by `threading.Lock`)
- Frontend polls `/api/progress/<id>` every 500ms per active download
- Each active download gets its own UI card (not a single shared panel)

## FFmpeg

FFmpeg is **not installed** on this machine. The app detects this on startup and:
- Shows a warning banner with install instructions (`winget install ffmpeg`)
- Disables download buttons for video-only formats that need merging
- Video+audio combined formats work fine without FFmpeg

## Format classification quirks

Many sites (ok.ru, etc.) return muxed video formats **without explicit `vcodec`/`acodec` fields**. The `classify_format()` function in `app.py` handles this: if both codec fields are `"none"` but the format has a `height` or a video extension (mp4, webm, etc.), it's treated as `video+audio`.

MHTML, json, and bin formats are filtered out — these are storyboard/thumbnail formats from sites like YouTube, not real video streams.

## File size estimation

When `filesize` and `filesize_approx` are both missing, the app estimates size from `tbr` (total bitrate in kbps) × duration in seconds.

## API routes

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Serve UI |
| `/api/status` | GET | FFmpeg + gallery-dl availability + yt-dlp version |
| `/api/formats` | POST | `{ url }` → video info + available formats |
| `/api/download` | POST | `{ url, format_id, title, resolution, needs_merge }` → `{ download_id }` |
| `/api/progress/<id>` | GET | Current download progress |
| `/api/history` | GET | Completed downloads list |
| `/api/open-downloads` | GET | Opens `./downloads/` in Explorer |
| `/api/scrape-profile` | POST | `{ url }` → `{ scan_id }` — starts async scan, returns immediately |
| `/api/scan-progress/<id>` | GET | Shared poll endpoint for image and channel scans; `status: scanning` returns lightweight progress (includes `scan_type`), `status: done` returns full result with `images` or `videos` |
| `/api/download-images` | POST | `{ url, profile_name, images }` → `{ download_id }` |
| `/api/scan-channel` | POST | `{ url }` → `{ scan_id }` — uses yt-dlp `extract_flat` to list channel/playlist videos; reuses `scan_progress` dict with `scan_type: "channel"` |
| `/api/start-channel-downloads` | POST | `{ channel_name, videos: [{url, title}] }` → `{ download_id }` — sequential download, single progress card with per-video sub-progress |

## Images mode (gallery-dl)

The UI has two tabs: **Video** and **Images**. Images mode:

1. User pastes a profile URL → "Scan Profile" → calls `/api/scrape-profile`, which spawns a thread and returns `{ scan_id }` immediately
2. Frontend polls `/api/scan-progress/<scan_id>` every 500ms; timer shows e.g. "12s · 31 images found" as images accumulate
3. gallery-dl extractor iterates `(Message.Directory, ...)` and `(Message.Url, url, ...)` tuples to collect image URLs; progress written to `scan_progress` dict (protected by `scan_lock`) after each image
4. When scan finishes, poll response includes full `images` list; frontend renders thumbnail grid
5. User can deselect images then click "Download All"
4. `/api/download-images` spawns a thread using `urllib.request` to download each image; tracks per-image progress

### gallery-dl import quirk

In v1.31.10, `Message` moved to `gallery_dl.extractor.message`. The app handles both with a try/except:
```python
try:
    from gallery_dl.extractor.message import Message as GdlMessage
except ImportError:
    from gallery_dl.extractor import Message as GdlMessage  # older versions
```

### cookies.txt support

If `cookies.txt` (Netscape format) is present in the app root, it is automatically passed to gallery-dl for authenticated scraping. Export via browser extensions: "Get cookies.txt LOCALLY" (Chrome/Edge) or "cookies.txt" by Lennon Hill (Firefox). Navigate to the site while logged in, then export.

The app checks for both `cookies.txt` and `cookies.txt.txt` — Windows often hides the `.txt` extension so users end up with a double extension without realising.

### Message.Queue — recursive album handling

In gallery-dl v1.31.10, `Message.Queue = 6` (not 4 as in older docs). Facebook and similar hierarchical sites return Queue messages pointing to sub-pages (e.g. individual albums) rather than direct image URLs. The `scan_profile_images()` function in `app.py` uses a recursive `process_extractor()` inner function to follow Queue messages: for each queued URL it calls `gdl_extractor.find()` on it and processes the child extractor. A `visited` set prevents infinite loops.

### Facebook album URLs (`/media/set/?set=...`)

These use `FacebookSetExtractor`, which chains through photos one-by-one via `next_photo_id`. By default gallery-dl stops early when it detects a large jump in photo IDs (assumes loop-back to album start). Fix: `gdl_config.set(("extractor", "facebook"), "loop", True)` — set in `scan_profile_images()` alongside the cookies config.

### Rate limiting — `sleep-request`

`scan_profile_images()` sets `sleep-request` in two places when `sleep_request > 0`:
- `gdl_config.set(("extractor",), "sleep-request", ...)` — global fallback for all sites
- `gdl_config.set(("extractor", "facebook"), "sleep-request", ...)` — explicit facebook override (required because facebook config may shadow the global setting)

Recommended values for Facebook: 2–5s normal, 10s+ if seeing 429s or blocks.

### Tooltip component

CSS-only tooltips use `.tooltip-icon` + `data-tooltip="..."` attribute. Renders a small circular `i` badge; the tooltip bubble appears above on hover via `::after` pseudo-element. Styles in `style.css`. Use this pattern for any new UI option hints — no JS needed.

### Progress entry type discrimination

Each `downloads_progress` entry has a `"type"` field (`"video"`, `"images"`, or `"channel"`) so the frontend renders different card layouts without any routing ambiguity.

Image progress entry structure:
```python
{
    "type": "images",
    "status": "starting" | "downloading" | "done" | "partial" | "error",
    "title": profile_name,
    "percent": 0-100,
    "total": N,
    "completed": N,
    "failed": N,
    "current_file": "",
    "errors": [],
    "folder": "downloads/profile_name/",
    "error": "",
}
```

Images land in `./downloads/<profile_name>/`.

Channel progress entry structure:
```python
{
    "type": "channel",
    "status": "starting" | "downloading" | "done" | "partial" | "error",
    "title": "Channel Name — N videos",
    "percent": 0-100,          # overall progress across all videos
    "total": N,
    "completed": N,
    "failed": N,
    "current_title": "",       # title of video currently downloading
    "current_percent": 0-100,  # progress within the current video
    "errors": [],
    "error": "",
}
```

Channel videos land in `./downloads/` (flat, same as single video downloads).

## Channel mode (yt-dlp extract_flat)

The **Channel** tab lets users scan a YouTube channel or playlist URL:
1. User pastes channel URL → "Scan Channel" → calls `/api/scan-channel`, which spawns a thread and returns `{ scan_id }` immediately
2. Frontend polls `/api/scan-progress/<scan_id>` (same endpoint as images); timer shows e.g. "8s · 47 videos found"
3. yt-dlp `extract_flat="in_playlist"` fetches all video metadata without downloading; `playlistend` caps at 500 by default
4. Thumbnails: entry.thumbnail if present, otherwise constructed as `https://i.ytimg.com/vi/{id}/mqdefault.jpg`
5. When scan finishes, `status: "done"` response includes `videos` list; frontend renders 16:9 video card grid
6. User selects/deselects videos, clicks "Download Selected"
7. `run_channel_download()` downloads videos sequentially using `bestvideo+bestaudio/best` — always best quality; single progress card with overall bar + per-video sub-bar

The `scan_progress` dict entry for channel scans includes `"scan_type": "channel"` to distinguish from image scans. The `api_scan_progress` endpoint uses `.get()` with defaults for all fields so it handles both scan types.

## GitHub

**ALWAYS push to GitHub automatically after every code change** — include CLAUDE.md and all modified files. Do not wait to be asked.

```bash
git add -A
git commit -m "..."
git push
```

## After each change — self-update

After pushing, always ask yourself: **is anything from this session worth noting in CLAUDE.md or memory?** If yes, update them before finishing. This covers:
- New architectural decisions or quirks added to the codebase
- New API routes or data structures
- New user workflow preferences discovered
- Anything that would help a future session avoid re-learning the same thing

Do this automatically — the user does not need to ask.
