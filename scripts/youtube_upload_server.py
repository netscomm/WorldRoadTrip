import json
import os
import re

from flask import Flask, request, jsonify
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request as GoogleRequest
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CLIENT_SECRET_PATH = os.path.join(SCRIPT_DIR, "client_secret.json")
TOKEN_PATH = os.path.join(SCRIPT_DIR, "token.json")
YOUTUBE_MAP_PATH = os.path.join(SCRIPT_DIR, "..", "docs", "youtube_map.js")
SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
DEFAULT_PRIVACY = "unlisted"
PORT = 8765

app = Flask(__name__)


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


@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


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

    youtube = get_youtube_service()
    media = MediaFileUpload(path, chunksize=-1, resumable=True)
    request_body = {
        "snippet": {"title": title},
        "status": {"privacyStatus": DEFAULT_PRIVACY},
    }
    insert_request = youtube.videos().insert(
        part="snippet,status", body=request_body, media_body=media
    )
    response = insert_request.execute()
    video_id = response["id"]

    mapping = load_youtube_map()
    mapping[basename] = video_id
    save_youtube_map(mapping)

    return jsonify({"videoId": video_id})


if __name__ == "__main__":
    print(f"YouTube upload helper running on http://localhost:{PORT}")
    print("Keep this window open while using the upload button on the map page.")
    app.run(host="127.0.0.1", port=PORT)
