import os
import shutil
import threading
import uuid
import webbrowser
from datetime import datetime

import yt_dlp
from flask import Flask, jsonify, render_template, request

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


# --- Routes ---

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    return jsonify({
        "ffmpeg_available": FFMPEG_AVAILABLE,
        "yt_dlp_version": yt_dlp.version.__version__,
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
    webbrowser.open("http://localhost:5000")
    app.run(host="localhost", port=5000, debug=False)
