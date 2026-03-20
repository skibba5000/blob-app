import os
import re
import shutil
import threading
import urllib.request as urlreq
import uuid
import webbrowser
from datetime import datetime

import yt_dlp
from flask import Flask, jsonify, render_template, request

# gallery-dl (optional — needed for image scraping)
try:
    from gallery_dl import extractor as gdl_extractor
    from gallery_dl import config as gdl_config
    try:
        from gallery_dl.extractor.message import Message as GdlMessage
    except ImportError:
        from gallery_dl.extractor import Message as GdlMessage  # older versions
    GALLERY_DL_AVAILABLE = True
except ImportError:
    GALLERY_DL_AVAILABLE = False

app = Flask(__name__)

# --- Shared state ---
downloads_progress = {}
download_history = []
progress_lock = threading.Lock()

# --- Startup checks ---
DOWNLOADS_DIR = os.path.join(os.path.dirname(__file__), "downloads")
os.makedirs(DOWNLOADS_DIR, exist_ok=True)
FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None


# --- Helpers ---

def safe_filename(name):
    """Sanitize a string for use as a filename or folder name."""
    name = re.sub(r'[\\/:*?"<>|]', '_', str(name))
    return name.strip('. ')[:80] or "profile"


def format_bytes(size):
    if size is None:
        return "Unknown"
    for unit in ["B", "KB", "MB", "GB"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def classify_format(fmt):
    vcodec = fmt.get("vcodec", "none") or "none"
    acodec = fmt.get("acodec", "none") or "none"
    has_video = vcodec != "none"
    has_audio = acodec != "none"
    if has_video and has_audio:
        return "video+audio"
    elif has_video:
        return "video-only"
    elif has_audio:
        return "audio-only"
    # Many sites (ok.ru, etc.) provide muxed streams without explicit codec info.
    # If the format has a height or video extension, treat it as video+audio.
    if fmt.get("height") or fmt.get("width"):
        return "video+audio"
    if fmt.get("url") and fmt.get("ext") in ("mp4", "webm", "flv", "avi", "mkv"):
        return "video+audio"
    return "unknown"


def process_formats(raw_formats, duration=None):
    # Extensions that are not downloadable video/audio
    JUNK_EXTENSIONS = {"mhtml", "json", "bin"}

    seen_resolutions = {}
    for fmt in raw_formats:
        ext = fmt.get("ext", "?")
        if ext in JUNK_EXTENSIONS:
            continue

        fmt_type = classify_format(fmt)
        if fmt_type == "unknown":
            continue

        height = fmt.get("height") or 0
        width = fmt.get("width") or 0
        resolution = f"{width}x{height}" if width and height else fmt.get("resolution", "audio")
        key = (resolution, fmt_type)

        filesize = fmt.get("filesize") or fmt.get("filesize_approx")
        # Estimate from bitrate if missing
        if not filesize and duration:
            tbr = fmt.get("tbr")  # total bitrate in kbps
            if tbr:
                filesize = int(tbr * 1000 / 8 * duration)
        fps = fmt.get("fps")

        entry = {
            "format_id": fmt.get("format_id"),
            "resolution": resolution,
            "height": height,
            "ext": ext,
            "filesize": format_bytes(filesize),
            "filesize_raw": filesize or 0,
            "fps": fps,
            "type": fmt_type,
            "needs_merge": fmt_type == "video-only",
        }

        # Prefer mp4 for same resolution+type
        if key not in seen_resolutions:
            seen_resolutions[key] = entry
        else:
            existing = seen_resolutions[key]
            if ext == "mp4" and existing["ext"] != "mp4":
                seen_resolutions[key] = entry

    result = list(seen_resolutions.values())

    # Sort: video+audio first (by height desc), then video-only (by height desc), then audio-only
    type_order = {"video+audio": 0, "video-only": 1, "audio-only": 2, "unknown": 3}
    result.sort(key=lambda x: (type_order.get(x["type"], 9), -(x["height"] or 0)))

    return result


def make_progress_hook(download_id, title):
    def hook(d):
        with progress_lock:
            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                downloaded = d.get("downloaded_bytes", 0)
                percent = (downloaded / total * 100) if total else 0
                speed = d.get("speed")
                eta = d.get("eta")

                downloads_progress[download_id].update({
                    "status": "downloading",
                    "percent": round(percent, 1),
                    "speed": f"{format_bytes(speed)}/s" if speed else "...",
                    "eta": f"{int(eta // 60):02d}:{int(eta % 60):02d}" if eta else "--:--",
                    "downloaded": format_bytes(downloaded),
                    "total": format_bytes(total),
                })
            elif d["status"] == "finished":
                downloads_progress[download_id].update({
                    "status": "merging",
                    "percent": 100,
                    "speed": "",
                    "eta": "",
                })
    return hook


def make_postprocessor_hook(download_id):
    def hook(d):
        if d["status"] == "finished":
            with progress_lock:
                downloads_progress[download_id].update({
                    "status": "finished",
                    "percent": 100,
                })
    return hook


def run_download(download_id, url, format_id, title, resolution):
    if True:
        fmt_spec = f"{format_id}+bestaudio/best" if format_id else "bestvideo+bestaudio/best"
        ydl_opts = {
            "format": fmt_spec,
            "merge_output_format": "mp4",
            "outtmpl": os.path.join(DOWNLOADS_DIR, "%(title)s.%(ext)s"),
            "progress_hooks": [make_progress_hook(download_id, title)],
            "postprocessor_hooks": [make_postprocessor_hook(download_id)],
            "quiet": True,
            "no_warnings": True,
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                filename = ydl.prepare_filename(info)
                # yt-dlp may change extension to mp4 after merge
                base = os.path.splitext(filename)[0]
                for ext in [".mp4", ".mkv", ".webm"]:
                    if os.path.exists(base + ext):
                        filename = os.path.basename(base + ext)
                        break
                else:
                    filename = os.path.basename(filename)

            filesize_raw = os.path.getsize(os.path.join(DOWNLOADS_DIR, filename)) if os.path.exists(os.path.join(DOWNLOADS_DIR, filename)) else 0

            with progress_lock:
                downloads_progress[download_id]["status"] = "finished"
                downloads_progress[download_id]["filename"] = filename
                download_history.insert(0, {
                    "title": title,
                    "url": url,
                    "resolution": resolution,
                    "filesize": format_bytes(filesize_raw),
                    "filename": filename,
                    "completed_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
                })
        except yt_dlp.utils.DownloadError as e:
            with progress_lock:
                downloads_progress[download_id]["status"] = "error"
                downloads_progress[download_id]["error"] = str(e).replace("ERROR: ", "")
        except Exception as e:
            with progress_lock:
                downloads_progress[download_id]["status"] = "error"
                downloads_progress[download_id]["error"] = str(e)


# --- Image scraping ---

def scan_profile_images(url, max_images=300):
    """Extract image URLs from a profile URL using gallery-dl."""
    gdl_config.clear()

    # Auto-load cookies.txt from app directory if present (Netscape format)
    # Check both names — Windows often hides .txt extension, so users save "cookies.txt.txt"
    app_dir = os.path.dirname(__file__)
    cookies_file = None
    for name in ("cookies.txt", "cookies.txt.txt"):
        path = os.path.join(app_dir, name)
        if os.path.exists(path):
            cookies_file = path
            break

    if cookies_file:
        print(f"[gallery-dl] Loading cookies from: {cookies_file}")
        gdl_config.set(("extractor",), "cookies", cookies_file)
    else:
        print(f"[gallery-dl] No cookies file found in: {app_dir}")

    # Facebook album pagination: by default gallery-dl stops early when it
    # detects a large jump in photo IDs (assumes loop-back). Setting loop=True
    # tells it to keep following next_photo_id through the whole album.
    gdl_config.set(("extractor", "facebook"), "loop", True)

    ex = gdl_extractor.find(url)
    if ex is None:
        raise ValueError(
            "No extractor found for this URL. "
            "Supported sites include Instagram, Facebook, Twitter/X, and 100+ others."
        )

    print(f"[gallery-dl] Extractor: {type(ex).__name__} for URL: {url}")

    images = []
    platform = type(ex).__module__.split(".")[-1]
    visited = set()

    # Try to extract a profile name from the URL as a fallback
    from urllib.parse import urlparse
    _path_parts = [p for p in urlparse(url).path.split("/") if p]
    _skip_words = {"photos", "photos_albums", "albums", "videos", "reels", "posts", "tagged"}
    _url_profile_name = next((p for p in _path_parts if p.lower() not in _skip_words), None)
    profile_name = _url_profile_name or "profile"

    def process_extractor(ext):
        """Iterate an extractor, recursively following Queue messages."""
        nonlocal profile_name
        for item in ext:
            msg_type = item[0]

            if msg_type == GdlMessage.Directory:
                kwdict = item[1] if len(item) > 1 else {}
                if isinstance(kwdict, dict):
                    profile_name = (
                        kwdict.get("username")
                        or kwdict.get("user")
                        or kwdict.get("uploader")
                        or kwdict.get("owner")
                        or kwdict.get("name")
                        or profile_name
                    )

            elif msg_type == GdlMessage.Url:
                img_url = item[1]
                kwdict = item[2] if len(item) > 2 and isinstance(item[2], dict) else {}
                ext_name = kwdict.get("extension", "jpg")
                fname = kwdict.get("filename") or str(len(images) + 1)
                images.append({
                    "url": img_url,
                    "filename": f"{fname}.{ext_name}",
                    "thumbnail": img_url,
                })
                if len(images) >= max_images:
                    return

            elif msg_type == GdlMessage.Queue:
                queue_url = item[1]
                if queue_url not in visited:
                    visited.add(queue_url)
                    print(f"[gallery-dl] Following queue: {queue_url[:100]}")
                    child_ex = gdl_extractor.find(queue_url)
                    if child_ex:
                        process_extractor(child_ex)
                        if len(images) >= max_images:
                            return

    process_extractor(ex)

    print(f"[gallery-dl] Done. {len(images)} images found, {len(visited)} albums followed.")
    return profile_name, platform, images


def run_image_download(download_id, profile_url, profile_name, images):
    """Download a list of images into downloads/{profile_name}/."""
    folder_name = safe_filename(profile_name)
    folder = os.path.join(DOWNLOADS_DIR, folder_name)
    os.makedirs(folder, exist_ok=True)

    total = len(images)
    completed = 0
    failed = 0
    errors = []

    for i, image in enumerate(images):
        img_url = image["url"]
        filename = safe_filename(image.get("filename", f"{i + 1}.jpg"))
        filepath = os.path.join(folder, filename)

        with progress_lock:
            downloads_progress[download_id].update({
                "status": "downloading",
                "percent": round(i / total * 100, 1),
                "current_file": filename,
                "completed": completed,
                "failed": failed,
            })

        try:
            if os.path.exists(filepath):
                completed += 1
                continue
            req = urlreq.Request(img_url, headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                "Referer": profile_url,
            })
            with urlreq.urlopen(req, timeout=30) as resp:
                with open(filepath, "wb") as f:
                    while True:
                        chunk = resp.read(8192)
                        if not chunk:
                            break
                        f.write(chunk)
            completed += 1
        except Exception as e:
            failed += 1
            errors.append(f"{filename}: {str(e)[:100]}")

    final_status = "finished" if failed == 0 else ("partial" if completed > 0 else "error")
    error_msg = f"All {failed} downloads failed" if completed == 0 and failed > 0 else ""

    with progress_lock:
        downloads_progress[download_id].update({
            "status": final_status,
            "percent": 100,
            "completed": completed,
            "failed": failed,
            "current_file": "",
            "errors": errors,
            "folder": folder_name,
            "error": error_msg,
        })
        if completed > 0:
            download_history.insert(0, {
                "title": f"{profile_name} — {completed} image{'s' if completed != 1 else ''}",
                "url": profile_url,
                "resolution": f"{completed} images",
                "filesize": "—",
                "filename": folder_name + "/",
                "completed_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
            })


# --- Routes ---

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    return jsonify({
        "ffmpeg_available": FFMPEG_AVAILABLE,
        "yt_dlp_version": yt_dlp.version.__version__,
        "gallery_dl_available": GALLERY_DL_AVAILABLE,
    })


@app.route("/api/formats", methods=["POST"])
def api_formats():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    ydl_opts = {"quiet": True, "no_warnings": True}
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as e:
        msg = str(e).replace("ERROR: ", "")
        return jsonify({"error": msg}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    raw_formats = info.get("formats") or []
    formats = process_formats(raw_formats, duration=info.get("duration"))

    return jsonify({
        "title": info.get("title", "Unknown"),
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration"),
        "uploader": info.get("uploader") or info.get("channel"),
        "formats": formats,
    })


@app.route("/api/download", methods=["POST"])
def api_download():
    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    format_id = (data or {}).get("format_id", "")
    title = (data or {}).get("title", "video")
    resolution = (data or {}).get("resolution", "")
    needs_merge = (data or {}).get("needs_merge", False)

    if not url:
        return jsonify({"error": "No URL provided"}), 400
    if needs_merge and not FFMPEG_AVAILABLE:
        return jsonify({"error": "This format requires FFmpeg to merge video and audio. Please install FFmpeg first."}), 400

    download_id = str(uuid.uuid4())
    with progress_lock:
        downloads_progress[download_id] = {
            "type": "video",
            "status": "starting",
            "title": title,
            "percent": 0,
            "speed": "",
            "eta": "",
            "filename": "",
            "downloaded": "",
            "total": "",
            "error": "",
        }

    thread = threading.Thread(
        target=run_download,
        args=(download_id, url, format_id, title, resolution),
        daemon=True,
    )
    thread.start()

    return jsonify({"download_id": download_id})


@app.route("/api/progress/<download_id>")
def api_progress(download_id):
    with progress_lock:
        data = downloads_progress.get(download_id)
    if data is None:
        return jsonify({"error": "Unknown download ID"}), 404
    return jsonify(data)


@app.route("/api/history")
def api_history():
    with progress_lock:
        return jsonify(download_history)


@app.route("/api/scrape-profile", methods=["POST"])
def api_scrape_profile():
    if not GALLERY_DL_AVAILABLE:
        return jsonify({"error": "gallery-dl is not installed. Run: pip install gallery-dl"}), 400

    data = request.get_json()
    url = (data or {}).get("url", "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400

    try:
        profile_name, platform, images = scan_profile_images(url)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return jsonify({"error": f"gallery-dl error: {e}"}), 500

    if not images:
        return jsonify({
            "error": (
                "No images found. The profile may be private, or Instagram/Facebook "
                "may require login. Try adding a cookies.txt file to the app folder."
            )
        }), 400

    return jsonify({
        "profile_name": profile_name,
        "platform": platform,
        "image_count": len(images),
        "images": images,
    })


@app.route("/api/download-images", methods=["POST"])
def api_download_images():
    if not GALLERY_DL_AVAILABLE:
        return jsonify({"error": "gallery-dl is not installed"}), 400

    data = request.get_json()
    profile_url = (data or {}).get("url", "").strip()
    profile_name = (data or {}).get("profile_name", "profile").strip()
    images = (data or {}).get("images", [])

    if not profile_url:
        return jsonify({"error": "No URL provided"}), 400
    if not images:
        return jsonify({"error": "No images to download"}), 400

    download_id = str(uuid.uuid4())
    with progress_lock:
        downloads_progress[download_id] = {
            "type": "images",
            "status": "starting",
            "title": profile_name,
            "percent": 0,
            "total": len(images),
            "completed": 0,
            "failed": 0,
            "current_file": "",
            "errors": [],
            "folder": "",
            "error": "",
        }

    thread = threading.Thread(
        target=run_image_download,
        args=(download_id, profile_url, profile_name, images),
        daemon=True,
    )
    thread.start()

    return jsonify({"download_id": download_id})


@app.route("/api/open-downloads")
def api_open_downloads():
    import subprocess
    try:
        subprocess.Popen(["explorer", DOWNLOADS_DIR])
    except Exception:
        pass
    return jsonify({"ok": True})


if __name__ == "__main__":
    print(f"  FFmpeg: {'found' if FFMPEG_AVAILABLE else 'NOT found'}")
    print(f"  yt-dlp: {yt_dlp.version.__version__}")
    print(f"  Downloads: {DOWNLOADS_DIR}")
    print()
    app.run(host="localhost", port=5000, debug=False)
