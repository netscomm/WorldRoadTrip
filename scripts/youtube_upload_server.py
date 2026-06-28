import json
import os
import re
import sys
import threading
import uuid

from flask import Flask, request, jsonify
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request as GoogleRequest
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import (  # noqa: E402
    DJI_DIR, FIT_DIR, PALETTE, build_one_media, build_one_track, build_tracks,
)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CLIENT_SECRET_PATH = os.path.join(SCRIPT_DIR, "client_secret.json")
TOKEN_PATH = os.path.join(SCRIPT_DIR, "token.json")
YOUTUBE_MAP_PATH = os.path.join(SCRIPT_DIR, "..", "docs", "youtube_map.js")
DATA_JS_PATH = os.path.join(SCRIPT_DIR, "..", "docs", "data.js")
SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
DEFAULT_PRIVACY = "unlisted"
PORT = 8765
UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024  # 4MB chunks so progress updates smoothly

app = Flask(__name__)

jobs = {}
jobs_lock = threading.Lock()


def set_job(job_id, **fields):
    with jobs_lock:
        jobs[job_id].update(fields)


def get_youtube_service():
    creds = None
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(GoogleRequest())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CLIENT_SECRET_PATH, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_PATH, "w", encoding="utf-8") as f:
            f.write(creds.to_json())
    return build("youtube", "v3", credentials=creds)


def load_youtube_map():
    if not os.path.exists(YOUTUBE_MAP_PATH):
        return {}
    content = open(YOUTUBE_MAP_PATH, encoding="utf-8").read()
    m = re.search(r"const YOUTUBE_MAP\s*=\s*(\{.*\});", content, re.S)
    if not m:
        return {}
    return json.loads(m.group(1))


def save_youtube_map(mapping):
    os.makedirs(os.path.dirname(YOUTUBE_MAP_PATH), exist_ok=True)
    with open(YOUTUBE_MAP_PATH, "w", encoding="utf-8") as f:
        f.write("const YOUTUBE_MAP = ")
        json.dump(mapping, f, ensure_ascii=False, indent=2)
        f.write(";\n")


TRACKS_RE = re.compile(r"const TRACKS = (\[.*?\]);(?=\s*const MEDIA = )", re.S)
MEDIA_RE = re.compile(r"const MEDIA = (\[.*?\]);\s*\n", re.S)


def load_data_js():
    content = open(DATA_JS_PATH, encoding="utf-8").read()
    tracks = json.loads(TRACKS_RE.search(content).group(1))
    media = json.loads(MEDIA_RE.search(content).group(1))
    return tracks, media


def save_media(media):
    content = open(DATA_JS_PATH, encoding="utf-8").read()
    new_content = MEDIA_RE.sub(
        lambda m: "const MEDIA = " + json.dumps(media, ensure_ascii=False) + ";\n", content, count=1
    )
    with open(DATA_JS_PATH, "w", encoding="utf-8") as f:
        f.write(new_content)


def save_tracks(tracks):
    content = open(DATA_JS_PATH, encoding="utf-8").read()
    new_content = TRACKS_RE.sub(
        lambda m: "const TRACKS = " + json.dumps(tracks, ensure_ascii=False) + ";", content, count=1
    )
    with open(DATA_JS_PATH, "w", encoding="utf-8") as f:
        f.write(new_content)


def known_basenames(media):
    return {m["path"].rsplit("/", 1)[-1] for m in media}


def next_media_id(media):
    used = [int(m["id"].replace("media", "")) for m in media if m["id"].startswith("media")]
    return f"media{(max(used) + 1) if used else 0}"


def next_track_id(tracks):
    used = [int(t["id"].replace("track", "")) for t in tracks if t["id"].startswith("track")]
    return f"track{(max(used) + 1) if used else 0}"


@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/scan-new-videos", methods=["GET"])
def scan_new_videos():
    tracks, media = load_data_js()
    known = known_basenames(media)
    mapping = load_youtube_map()
    all_files = sorted(f for f in os.listdir(DJI_DIR) if f.upper().endswith(".MP4"))
    new_files = [f for f in all_files if f not in known]

    results = []
    next_idx = max([int(m["id"].replace("media", "")) for m in media], default=-1) + 1
    for i, fname in enumerate(new_files):
        entry = build_one_media(fname, tracks, f"media{next_idx + i}")
        if entry is None:
            continue
        entry["alreadyUploaded"] = fname in mapping
        results.append(entry)
    return jsonify(results)


@app.route("/add-video", methods=["POST", "OPTIONS"])
def add_video():
    if request.method == "OPTIONS":
        return "", 204

    data = request.get_json(force=True)
    basename = data.get("basename")
    path = os.path.join(DJI_DIR, basename) if basename else None

    if not basename or not os.path.exists(path):
        return jsonify({"error": f"file not found: {basename}"}), 400

    tracks, media = load_data_js()
    if basename in known_basenames(media):
        return jsonify({"error": "already added"}), 400

    entry = build_one_media(basename, tracks, next_media_id(media))
    if entry is None:
        return jsonify({"error": "could not determine a time/position for this file"}), 400

    media.append(entry)
    save_media(media)

    job_id = str(uuid.uuid4())
    with jobs_lock:
        jobs[job_id] = {"status": "uploading", "progress": 0, "videoId": None, "error": None}
    thread = threading.Thread(target=run_upload, args=(job_id, path, basename, basename), daemon=True)
    thread.start()

    return jsonify({"jobId": job_id, "media": entry})


@app.route("/upload-new-video", methods=["POST", "OPTIONS"])
def upload_new_video():
    if request.method == "OPTIONS":
        return "", 204

    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "no file provided"}), 400

    basename = os.path.basename(f.filename)
    dest = os.path.join(DJI_DIR, basename)

    tracks, media = load_data_js()
    if basename in known_basenames(media):
        return jsonify({"error": "already added"}), 400
    if os.path.exists(dest):
        return jsonify({"error": f"a file named {basename} already exists on the server"}), 400

    f.save(dest)

    entry = build_one_media(basename, tracks, next_media_id(media))
    if entry is None:
        os.remove(dest)
        return jsonify({"error": "could not determine a time/position for this file"}), 400

    media.append(entry)
    save_media(media)

    job_id = str(uuid.uuid4())
    with jobs_lock:
        jobs[job_id] = {"status": "uploading", "progress": 0, "videoId": None, "error": None}
    thread = threading.Thread(target=run_upload, args=(job_id, dest, basename, basename), daemon=True)
    thread.start()

    return jsonify({"jobId": job_id, "media": entry})


UNSAFE_FILENAME_CHARS_RE = re.compile(r'[<>:"/\\|?*]')


@app.route("/upload-new-track", methods=["POST", "OPTIONS"])
def upload_new_track():
    if request.method == "OPTIONS":
        return "", 204

    f = request.files.get("file")
    title = (request.form.get("title") or "").strip()
    if not f or not f.filename:
        return jsonify({"error": "no file provided"}), 400
    if not title:
        return jsonify({"error": "title is required"}), 400

    tmp_path = os.path.join(FIT_DIR, f"_tmp_{uuid.uuid4().hex}.fit")
    f.save(tmp_path)

    tracks, _ = load_data_js()
    color = PALETTE[len(tracks) % len(PALETTE)]
    track = build_one_track(os.path.basename(tmp_path), next_track_id(tracks), color)
    if track is None:
        os.remove(tmp_path)
        return jsonify({"error": "could not find any GPS points in this FIT file"}), 400

    date_str = track["startTime"][:10].replace("-", "")
    safe_title = UNSAFE_FILENAME_CHARS_RE.sub("_", title)
    fname = f"{date_str}_{safe_title}.fit"
    dest = os.path.join(FIT_DIR, fname)
    if os.path.exists(dest):
        os.remove(tmp_path)
        return jsonify({"error": f"a track named {fname} already exists on the server"}), 400

    os.rename(tmp_path, dest)
    track["file"] = fname

    tracks.append(track)
    save_tracks(tracks)

    return jsonify({"track": track})


def run_upload(job_id, path, basename, title):
    try:
        youtube = get_youtube_service()
        media = MediaFileUpload(path, chunksize=UPLOAD_CHUNK_SIZE, resumable=True)
        request_body = {
            "snippet": {"title": title},
            "status": {"privacyStatus": DEFAULT_PRIVACY},
        }
        insert_request = youtube.videos().insert(
            part="snippet,status", body=request_body, media_body=media
        )

        response = None
        while response is None:
            status, response = insert_request.next_chunk()
            if status:
                set_job(job_id, progress=round(status.progress() * 100, 1))

        set_job(job_id, status="done", progress=100, videoId=response["id"])

        mapping = load_youtube_map()
        mapping[basename] = response["id"]
        save_youtube_map(mapping)
    except Exception as e:
        set_job(job_id, status="error", error=str(e))


@app.route("/upload", methods=["POST", "OPTIONS"])
def upload():
    if request.method == "OPTIONS":
        return "", 204

    data = request.get_json(force=True)
    path = data.get("path")
    basename = data.get("basename")
    title = data.get("title") or basename

    if not path or not os.path.exists(path):
        return jsonify({"error": f"file not found: {path}"}), 400

    job_id = str(uuid.uuid4())
    with jobs_lock:
        jobs[job_id] = {"status": "uploading", "progress": 0, "videoId": None, "error": None}

    thread = threading.Thread(target=run_upload, args=(job_id, path, basename, title), daemon=True)
    thread.start()

    return jsonify({"jobId": job_id})


@app.route("/progress/<job_id>", methods=["GET"])
def progress(job_id):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "unknown job"}), 404
    return jsonify(job)


if __name__ == "__main__":
    print(f"YouTube upload helper running on http://localhost:{PORT}")
    print("Keep this window open while using the upload button on the map page.")
    app.run(host="127.0.0.1", port=PORT)
